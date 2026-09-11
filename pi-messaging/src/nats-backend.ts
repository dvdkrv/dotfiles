import { connect, type NatsConnection, type Subscription } from '@nats-io/transport-node';
import { AckPolicy, DeliverPolicy, DiscardPolicy, RetentionPolicy, StorageType, JetStreamApiError, jetstream, jetstreamManager, type Consumer, type JetStreamClient, type JetStreamManager } from '@nats-io/jetstream';
import { Kvm, type KV } from '@nats-io/kv';
import { setTimeout as delay } from 'node:timers/promises';
import { MessagingError, type BrokerConfig, type Envelope, type GroupRef, type GroupSummary, type MessagingBackend, type MessageStatus, type Peer, type Reservation, type SendInput } from './contracts.ts';
import * as policy from './policy.ts';

const STREAM = 'PM_MESSAGES';
const BUCKET = 'PM_CONTROL';
const CHANGED = 'pm.changed';
const subject = (m: MessageStatus) => `pm.message.${m.groupId}.${m.recipientPeerId}.${m.id}`;
const consumerName = (peerId: string) => `peer_${peerId.replaceAll('-', '')}`;
const apiCode = (error: unknown, code: number) => error instanceof JetStreamApiError && error.code === code;

/** Provisioning is only called by explicit broker bootstrap, never by a Pi tool. */
export async function connectBackend(config: BrokerConfig, options: { initialize?: boolean } = {}): Promise<MessagingBackend> {
  const nc = await connect({ servers: config.server, token: config.token, reconnect: false, timeout: 1500, name: 'pi-messaging' });
  try {
    const js = jetstream(nc, { timeout: 1500 });
    const jsm = await jetstreamManager(nc, { timeout: 1500 });
    const kvm = new Kvm(js);
    if (options.initialize) {
      await jsm.streams.add({ name: STREAM, subjects: ['pm.message.>'], storage: StorageType.File, retention: RetentionPolicy.Limits, discard: DiscardPolicy.New, max_msgs: 2000, max_bytes: 32 * 1024 * 1024, max_msg_size: 65536, max_age: 0, max_consumers: 512 });
    }
    const kv = options.initialize
      ? await kvm.create(BUCKET, { history: 1, storage: StorageType.File, maxValueSize: 2 * 1024 * 1024, max_bytes: 8 * 1024 * 1024 })
      : await kvm.open(BUCKET);
    if (options.initialize && !(await kv.get('state'))) await kv.create('state', JSON.stringify(policy.newLedger(config.authorityId)));
    const stream = (await jsm.streams.info(STREAM)).config;
    const bucket = (await jsm.streams.info(`KV_${BUCKET}`)).config;
    if (stream.storage !== StorageType.File || stream.retention !== RetentionPolicy.Limits || stream.discard !== DiscardPolicy.New || stream.max_age !== 0 || stream.max_msgs !== 2000 || stream.max_bytes !== 32 * 1024 * 1024 || stream.max_msg_size !== 65536 || stream.subjects?.join() !== 'pm.message.>' || bucket.storage !== StorageType.File || bucket.max_age !== 0 || bucket.max_msgs_per_subject !== 1) policy.fail('configuration', 'Unsafe or incompatible broker stream configuration');
    const backend = new NatsBackend(nc, js, jsm, kv, config.authorityId);
    await backend.snapshot();
    return backend;
  } catch (error) { await nc.close(); throw error; }
}

class NatsBackend implements MessagingBackend {
  private nc: NatsConnection;
  private js: JetStreamClient;
  private jsm: JetStreamManager;
  private kv: KV;
  private authorityId: string;
  private participant?: Peer;
  private consumer?: Consumer;
  private failed = false;
  private fetching = false;
  private joining = false;
  private membershipGeneration = 0;
  private lastMaintenance = 0;
  private subscriptions = new Set<Subscription>();
  constructor(nc: NatsConnection, js: JetStreamClient, jsm: JetStreamManager, kv: KV, authorityId: string) {
    this.nc = nc; this.js = js; this.jsm = jsm; this.kv = kv; this.authorityId = authorityId;
  }
  get peer(): Peer | undefined { return this.participant ? { ...this.participant } : undefined; }
  get closed(): boolean { return this.failed || this.nc.isClosed(); }
  private async io<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) policy.fail('unavailable', 'Messaging broker unavailable; explicitly leave/rejoin');
    try { return await operation(); }
    catch (error) {
      this.failed = true;
      throw new MessagingError('uncertain', `Broker operation failed or has an uncertain outcome; no automatic retry. Leave/rejoin after inspection. ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  async snapshot(): Promise<{ state: policy.Ledger; revision: number }> {
    const entry = await this.io(() => this.kv.get('state'));
    if (!entry || entry.operation !== 'PUT') { this.failed = true; policy.fail('missing', 'Messaging ledger missing; refusing to recreate allowance'); }
    try {
      const state: unknown = JSON.parse(entry.string()); policy.validateLedger(state, this.authorityId);
      return { state, revision: entry.revision };
    } catch (error) { this.failed = true; throw error; }
  }
  private notify(): void { if (!this.nc.isClosed()) this.nc.publish(CHANGED); }
  private async change<T>(mutate: (state: policy.Ledger) => T): Promise<T> {
    for (let retry = 0; retry < 64; retry++) {
      const { state, revision } = await this.snapshot();
      const original = JSON.stringify(state);
      const result = mutate(state);
      const next = JSON.stringify(state);
      if (next === original) return result;
      if (Buffer.byteLength(next) > 2 * 1024 * 1024) policy.fail('full', 'Messaging control ledger full; prune terminal history');
      try { await this.kv.update('state', next, revision); this.notify(); return result; }
      catch (error) {
        // Only the server's explicit wrong-revision response establishes no commit.
        if (apiCode(error, 10071)) { await delay(Math.min(50, retry * 2) + Math.random() * 10); continue; }
        this.failed = true;
        throw new MessagingError('uncertain', 'Ledger write outcome uncertain; stop admissions and inspect before leave/rejoin');
      }
    }
    policy.fail('busy', 'Messaging ledger busy; operation was not committed');
  }
  async listGroups(): Promise<GroupRef[]> { return Object.values((await this.snapshot()).state.groups).map(policy.refOf); }
  async createGroup(label: string): Promise<GroupRef> { return this.change(s => policy.createGroup(s, label)); }
  async getGroupSummary(ref: GroupRef): Promise<GroupSummary | null> {
    const { state } = await this.snapshot();
    if (ref.authorityId !== state.authorityId) policy.fail('authority', 'Messaging authority mismatch');
    return Object.hasOwn(state.groups, ref.id) ? policy.summary(state, ref) : null;
  }
  async peers(ref: GroupRef): Promise<Peer[]> { const { state } = await this.snapshot(); policy.groupOf(state, ref); return Object.values(state.peers).filter(p => p.groupId === ref.id); }
  async join(ref: GroupRef, info: { sessionId: string; displayName: string }): Promise<Peer> {
    if (this.participant || this.joining) policy.fail('participation', 'Leave the current group before joining');
    this.joining = true;
    const generation = ++this.membershipGeneration;
    try {
      const peer = await this.change(s => policy.joinPeer(s, ref, info));
      if (generation !== this.membershipGeneration) { await this.change(s => policy.leavePeer(s, peer.id)); policy.fail('participation', 'Join canceled by session departure'); }
      this.participant = peer;
      await this.io(() => this.jsm.consumers.add(STREAM, { durable_name: consumerName(peer.id), filter_subject: `pm.message.${ref.id}.${peer.id}.*`, ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All, max_ack_pending: 8, ack_wait: 5_000_000_000 }));
      this.consumer = await this.io(() => this.js.consumers.get(STREAM, consumerName(peer.id)));
      if (generation !== this.membershipGeneration) { await this.leave(); policy.fail('participation', 'Join canceled by session departure'); }
      return { ...peer };
    } finally { this.joining = false; }
  }
  async leave(): Promise<void> {
    this.membershipGeneration++;
    const peer = this.participant; this.participant = undefined; this.consumer = undefined;
    if (!peer || this.closed) return;
    await this.change(s => policy.leavePeer(s, peer.id));
    await this.deleteConsumer(consumerName(peer.id));
  }
  private async deleteConsumer(name: string): Promise<void> {
    await this.io(async () => {
      try { await this.jsm.consumers.delete(STREAM, name); }
      catch (error) { if (!apiCode(error, 10014)) throw error; }
    });
  }
  private joined(): Peer { if (!this.participant) policy.fail('participation', 'Explicitly join a messaging group first'); return this.participant; }
  async heartbeat(displayName?: string): Promise<void> { const p = this.joined(); await this.change(s => policy.heartbeat(s, p.id, displayName)); if (displayName) p.displayName = displayName; }
  async arm(ref: GroupRef, limit: number): Promise<void> { await this.change(s => policy.arm(s, ref, limit)); }
  async pause(ref: GroupRef): Promise<void> { await this.change(s => policy.pause(s, ref)); }
  async send(input: SendInput, requestKey: string): Promise<MessageStatus> {
    const p = this.joined(); policy.validateInput(input);
    if (Date.now() - this.lastMaintenance > 60000) {
      const { state } = await this.snapshot();
      policy.activePeer(state, p.id);
      await this.prune(policy.refOf(state.groups[p.groupId]), true, Date.now() - 7 * 86400000);
      this.lastMaintenance = Date.now();
    }
    const m = await this.change(s => policy.prepareMessage(s, p.id, input, requestKey));
    // An idempotent retry of an attempted/terminal message must not republish it.
    if (m.state !== 'queued') return m;
    const body = policy.envelope(policy.newLedger(this.authorityId), m, input.text);
    try { await this.js.publish(subject(m), JSON.stringify(body), { expect: { lastSubjectSequence: 0 } }); }
    catch (error) {
      if (apiCode(error, 10071)) {
        const stored = await this.io(() => this.jsm.streams.getMessage(STREAM, { last_by_subj: subject(m) }));
        if (!stored) { this.failed = true; policy.fail('uncertain', 'Conflicting publication disappeared; inspect messaging state'); }
        policy.validateEnvelope(stored.json<Envelope>(), policy.newLedger(this.authorityId), m);
      } else { this.failed = true; throw new MessagingError('uncertain', 'Message publication uncertain; metadata retained. Inspect the old inbox before explicitly composing a new message; do not assume resending is safe.'); }
    }
    this.notify(); return m;
  }
  async reserve(): Promise<Reservation[]> {
    const peer = this.joined(); const consumer = this.consumer;
    if (!consumer || this.fetching) return [];
    this.fetching = true;
    try {
      const { state } = await this.snapshot();
      if (!policy.canReceive(state, peer.id)) return [];
      const candidateIds = new Set(Object.values(state.messages)
        .filter(message => message.recipientPeerId === peer.id && message.state === 'queued')
        .map(message => message.id));
      const drainOnly = candidateIds.size === 0;
      const target = drainOnly ? 1 : Math.min(policy.MAX_QUEUED_PER_RECIPIENT, candidateIds.size);
      const held: Array<{ message: { ack(): void; nak(millis?: number): void }; body: Envelope }> = [];
      let drained = 0; let stop = false;
      while (held.length < target && drained < 64 && !stop) {
        const requested = Math.min(target - held.length, 8);
        let received = 0;
        await this.io(async () => {
          const messages = await consumer.fetch({ max_messages: requested, expires: 1000 });
          try {
            for await (const message of messages) {
              received++; drained++;
              const body = message.json<Envelope>();
              const metadata = Object.hasOwn(state.messages, body.messageId) ? state.messages[body.messageId] : undefined;
              if (!metadata) { message.nak(1000); stop = true; break; }
              policy.validateEnvelope(body, state, metadata);
              if (metadata.recipientPeerId !== peer.id) policy.fail('corrupt', 'Consumer returned another peer inbox');
              if (metadata.state !== 'queued') { message.ack(); continue; }
              if (!candidateIds.has(metadata.id)) { message.nak(1000); stop = true; break; }
              held.push({ message, body });
            }
          } finally { await messages.close(); }
        });
        if (drainOnly || received === 0) break;
      }
      if (held.length === 0) return [];
      const reservations = await this.change(ledger => policy.admitBatch(ledger, peer.id, held.map(item => item.body.messageId)));
      const admitted = new Set(reservations.map(reservation => reservation.message.id));
      for (const item of held) {
        if (admitted.has(item.body.messageId)) item.message.ack();
        else item.message.nak(1000);
      }
      const bodies = new Map(held.map(item => [item.body.messageId, item.body]));
      return reservations.map(reservation => ({ ...reservation, envelope: bodies.get(reservation.message.id) }));
    } finally { this.fetching = false; }
  }
  async observe(reservations: readonly Reservation[]): Promise<void> {
    const peer = this.joined();
    if (reservations.some(reservation => reservation.peerId !== peer.id)) policy.fail('receipt', 'Receipt is not from this participation');
    await this.change(state => policy.observeBatch(state, reservations));
  }
  async listMessages(ref: GroupRef): Promise<MessageStatus[]> {
    const { state } = await this.snapshot(); policy.groupOf(state, ref);
    return Object.values(state.messages).filter(m => m.groupId === ref.id).sort((a, b) => b.sequence - a.sequence);
  }
  async readBody(ref: GroupRef, id: string): Promise<Envelope | null> {
    const { state } = await this.snapshot(); policy.groupOf(state, ref);
    const m = Object.hasOwn(state.messages, id) ? state.messages[id] : undefined;
    if (!m || m.groupId !== ref.id) policy.fail('missing', 'Message does not exist in this group');
    try { const stored = await this.jsm.streams.getMessage(STREAM, { last_by_subj: subject(m) }); if (!stored) return null; const body = stored.json<Envelope>(); policy.validateEnvelope(body, state, m); return body; }
    catch (error) { if (apiCode(error, 10037)) return null; throw error; }
  }
  async resolveMessage(ref: GroupRef, id: string, state: 'canceled' | 'dismissed'): Promise<void> { await this.change(s => policy.resolveMessage(s, ref, id, state)); }
  async revoke(ref: GroupRef, id: string): Promise<void> {
    await this.change(s => { policy.groupOf(s, ref); if (!Object.hasOwn(s.peers, id) || s.peers[id].groupId !== ref.id) policy.fail('missing', 'Peer not in group'); policy.leavePeer(s, id); });
    await this.deleteConsumer(consumerName(id));
  }
  async prune(ref: GroupRef, execute = false, before = Infinity): Promise<string[]> {
    const { state } = await this.snapshot(); const ids = policy.prunable(state, ref, before);
    if (!execute) return ids;
    for (const id of ids) await this.io(() => this.jsm.streams.purge(STREAM, { filter: subject(state.messages[id]) }));
    const consumers = await this.io(async () => {
      const names: string[] = [];
      for await (const info of this.jsm.consumers.list(STREAM)) if (/^peer_[0-9a-f]{32}$/.test(info.name)) names.push(info.name);
      return names;
    });
    // Read AFTER enumeration: a newly joined peer's ledger entry precedes its consumer.
    // Inactive identities never become active again; stale-but-active peers need human revocation.
    const current = (await this.snapshot()).state;
    const active = new Set(Object.values(current.peers).filter(p => p.active).map(p => consumerName(p.id)));
    for (const name of consumers) if (!active.has(name)) await this.deleteConsumer(name);
    await this.change(s => {
      if (!Object.hasOwn(s.groups, ref.id)) return;
      for (const id of policy.prunable(s, ref, before)) if (ids.includes(id)) delete s.messages[id];
      const usedPeers = new Set(Object.values(s.messages).flatMap(m => [m.senderPeerId, m.recipientPeerId]));
      for (const p of Object.values(s.peers)) if (p.groupId === ref.id && !p.active && !usedPeers.has(p.id)) delete s.peers[p.id];
      if (before === Infinity && !Object.values(s.peers).some(p => p.groupId === ref.id) && !Object.values(s.messages).some(m => m.groupId === ref.id)) delete s.groups[ref.id];
    });
    return ids;
  }
  onChange(callback: () => void): () => void {
    const sub = this.nc.subscribe(CHANGED, { callback: (error) => { if (error) this.failed = true; callback(); } });
    this.subscriptions.add(sub);
    void this.nc.closed().then(() => { if (this.subscriptions.has(sub)) callback(); });
    return () => { this.subscriptions.delete(sub); sub.unsubscribe(); };
  }
  async close(): Promise<void> {
    this.membershipGeneration++;
    for (const sub of this.subscriptions) sub.unsubscribe(); this.subscriptions.clear();
    await this.nc.close();
  }
}
