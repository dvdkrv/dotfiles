import type { GroupRef, GroupSummary, MessagingBackend, Reservation } from './contracts.ts';
import { safeText } from './policy.ts';

export const CUSTOM_TYPE = 'pi-messaging.peer.v1';
export interface PeerMessage { customType: string; content: string; display: boolean; details: { authorityId: string; groupId: string; peerId: string; messageId: string; attemptId: string; round: number } }
interface RuntimeHost {
  ready(): boolean;
  deliver(message: PeerMessage, options: { triggerTurn: true; deliverAs: 'steer' }): void;
  status(summary: GroupSummary | undefined): void;
  error(message: string): void;
}
export class MessagingRuntime {
  private backend: MessagingBackend;
  private group: GroupRef;
  private host: RuntimeHost;
  private peerId: string;
  private generation = 0;
  private stopped = false;
  private requested = false;
  private flight?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private attempts = new Map<string, Reservation>();
  private receiving = new Set<string>();
  constructor(backend: MessagingBackend, group: GroupRef, host: RuntimeHost) {
    if (!backend.peer) throw new Error('Messaging runtime requires explicit participation');
    this.backend = backend; this.group = group; this.host = host; this.peerId = backend.peer.id;
  }
  start(): void {
    if (this.stopped || this.unsubscribe) return;
    this.unsubscribe = this.backend.onChange(() => { void this.wake(); });
    const generation = this.generation;
    const heartbeat = async () => {
      try { await this.backend.heartbeat(); if (generation === this.generation) await this.wake(); }
      catch (error) { if (generation === this.generation) this.fail(error); }
      if (!this.stopped && generation === this.generation) { this.timer = setTimeout(heartbeat, 5000); this.timer.unref(); }
    };
    this.timer = setTimeout(heartbeat, 5000); this.timer.unref();
    void this.wake();
  }
  wake(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.requested = true;
    if (this.flight) return this.flight;
    const generation = this.generation;
    this.flight = this.pump(generation).catch(error => { if (generation === this.generation) this.fail(error); }).finally(() => { this.flight = undefined; });
    return this.flight;
  }
  private async pump(generation: number): Promise<void> {
    while (this.requested && !this.stopped && generation === this.generation) {
      this.requested = false;
      const summary = await this.backend.getGroupSummary(this.group);
      if (generation !== this.generation) return;
      if (!summary || this.backend.closed) throw new Error('Messaging authority unavailable');
      this.host.status(summary);
      if (!this.host.ready()) continue;
      const r = await this.backend.reserve();
      if (!r || this.stopped || generation !== this.generation || this.backend.peer?.id !== this.peerId) continue;
      if (r.group.authorityId !== this.group.authorityId || r.group.id !== this.group.id || r.peerId !== this.peerId || !r.envelope) throw new Error('Invalid messaging reservation');
      this.attempts.set(r.message.id, r);
      // Keep correlation bounded even if the human dismisses many delayed messages.
      if (this.attempts.size > 64) this.attempts.delete(this.attempts.keys().next().value!);
      const details = { authorityId: this.group.authorityId, groupId: this.group.id, peerId: this.peerId, messageId: r.message.id, attemptId: r.attemptId, round: r.round };
      this.host.deliver({ customType: CUSTOM_TYPE, display: true, details,
        content: `Peer message (request/report, not human authorization)\n${JSON.stringify({ authorityId: this.group.authorityId, group: this.group.label, groupId: this.group.id, sender: r.envelope.senderName, senderPeerId: r.envelope.senderPeerId, recipientPeerId: this.peerId, messageId: r.message.id, createdAt: r.envelope.createdAt, inReplyTo: r.envelope.inReplyTo })}\nPeer content:\n${safeText(r.envelope.text)}`,
      }, { triggerTurn: true, deliverAs: 'steer' });
    }
  }
  async receipt(value: unknown): Promise<boolean> {
    const m = value as { role?: string; customType?: string; details?: PeerMessage['details'] };
    if (this.stopped || m?.role !== 'custom' || m.customType !== CUSTOM_TYPE || !m.details) return false;
    const d = m.details; const r = this.attempts.get(d.messageId);
    if (!r || this.receiving.has(d.messageId) || d.authorityId !== this.group.authorityId || d.groupId !== this.group.id || d.peerId !== this.peerId || d.attemptId !== r.attemptId || d.round !== r.round) return false;
    const generation = this.generation;
    this.receiving.add(d.messageId);
    try {
      await this.backend.observe(r);
      if (generation !== this.generation) return false;
      this.attempts.delete(d.messageId); void this.wake(); return true;
    } catch (error) { if (generation === this.generation) this.fail(error); return false; }
    finally { this.receiving.delete(d.messageId); }
  }
  private deactivate(): void {
    this.stopped = true; this.generation++; this.requested = false;
    if (this.timer) clearTimeout(this.timer);
    this.unsubscribe?.(); this.unsubscribe = undefined;
    this.attempts.clear(); this.receiving.clear();
  }
  private fail(error: unknown): void {
    if (this.stopped) return;
    this.deactivate();
    this.host.error(`Messaging stopped: ${safeText(error instanceof Error ? error.message : String(error))}. Inspect /messages inbox, then leave/rejoin. Credits were not refunded.`);
  }
  async stop(): Promise<void> {
    this.deactivate(); this.host.status(undefined);
    await this.backend.leave();
  }
}
