import { createHash, randomUUID } from 'node:crypto';
import { MessagingError, type Envelope, type Group, type GroupRef, type GroupSummary, type MessageStatus, type ParticipantLease, type Peer, type PeerLifecycle, type Reservation, type SendInput } from './contracts.ts';

export interface PeerRecord extends Peer { leaseId: string }
export interface Ledger { version: 2; authorityId: string; sequence: number; groups: Record<string, Group>; peers: Record<string, PeerRecord>; messages: Record<string, MessageStatus> }
interface LegacyPeer { id: string; groupId: string; sessionId: string; displayName: string; active: boolean; lastSeen: number }
interface LegacyLedger { version: 1; authorityId: string; sequence: number; groups: Record<string, Group>; peers: Record<string, LegacyPeer>; messages: Record<string, MessageStatus> }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const control = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
export const ONLINE_WINDOW_MS = 30_000;
export function fail(code: string, message: string): never { throw new MessagingError(code, message); }
export function safeText(text: string): string { return text.replace(control, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`); }
export function validateDisplayName(value: string): string {
  if (typeof value !== 'string' || !value.trim() || [...value].length > 64 || safeText(value) !== value || /[\n\r\t]/.test(value)) fail('validation', 'Invalid display name');
  return value.trim();
}
export function validateInput(input: SendInput): SendInput {
  if (typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text, 'utf8') > 8192) fail('validation', 'Message body must be nonempty and at most 8 KiB UTF-8');
  if (!uuid.test(input.toPeerId)) fail('validation', 'Invalid toPeerId: use the full routing id returned by peers');
  if (input.inReplyTo !== undefined && !uuid.test(input.inReplyTo)) fail('validation', 'Invalid inReplyTo: use a message id, or omit it for a new message');
  return { toPeerId: input.toPeerId, text: input.text, ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}) };
}
export function payloadHash(input: SendInput): string { return createHash('sha256').update(JSON.stringify(validateInput(input))).digest('hex'); }
export function newLedger(authorityId: string): Ledger {
  if (!uuid.test(authorityId)) fail('validation', 'Invalid authority ID');
  return { version: 2, authorityId, sequence: 0, groups: {}, peers: {}, messages: {} };
}
function validateCommon(value: unknown, authorityId: string, version: 1 | 2): asserts value is LegacyLedger | Ledger {
  const s = value as LegacyLedger | Ledger;
  if (!s || s.version !== version || ![s.groups, s.peers, s.messages].every(map => map && typeof map === 'object' && !Array.isArray(map)) || !Number.isSafeInteger(s.sequence) || s.sequence < 0) fail('corrupt', 'Unsupported or corrupt messaging ledger');
  if (s.authorityId !== authorityId) fail('authority', 'Messaging authority mismatch; refusing replacement state');
  if (Object.keys(s.groups).length > 32 || Object.keys(s.peers).length > 512 || Object.keys(s.messages).length > 2000) fail('corrupt', 'Ledger exceeds bounds');
  for (const [id, g] of Object.entries(s.groups)) {
    if (!uuid.test(id) || g.id !== id || g.authorityId !== authorityId || !/^[a-z][a-z0-9-]{0,47}$/.test(g.label) || !['paused', 'armed', 'exhausted'].includes(g.mode) || ![g.used, g.limit, g.round].every(n => Number.isSafeInteger(n) && n >= 0) || g.used > g.limit || g.limit > 100 || (g.mode === 'exhausted' && g.used !== g.limit) || (g.mode === 'armed' && g.used >= g.limit)) fail('corrupt', 'Invalid group ledger');
  }
  for (const [id, peer] of Object.entries(s.peers)) {
    if (!uuid.test(id) || peer.id !== id || !Object.hasOwn(s.groups, peer.groupId) || typeof peer.active !== 'boolean' || typeof peer.sessionId !== 'string' || !Number.isFinite(peer.lastSeen)) fail('corrupt', 'Invalid peer ledger');
    validateDisplayName(peer.displayName);
    if (version === 2) {
      const current = peer as PeerRecord;
      if (typeof current.suspended !== 'boolean' || (!current.active && current.suspended) || !uuid.test(current.leaseId)) fail('corrupt', 'Invalid peer lifecycle or lease');
    }
  }
  for (const [id, m] of Object.entries(s.messages)) {
    if (!uuid.test(id) || m.id !== id || !Object.hasOwn(s.groups, m.groupId) || !Object.hasOwn(s.peers, m.senderPeerId) || !Object.hasOwn(s.peers, m.recipientPeerId) || s.peers[m.senderPeerId].groupId !== m.groupId || s.peers[m.recipientPeerId].groupId !== m.groupId || !['queued', 'attempted', 'observed', 'canceled', 'dismissed'].includes(m.state) || !Number.isSafeInteger(m.sequence) || m.sequence < 1 || m.sequence > s.sequence || typeof m.requestKey !== 'string' || !/^[0-9a-f]{64}$/.test(m.hash) || !Number.isFinite(m.createdAt)) fail('corrupt', 'Invalid message ledger');
    if (['attempted', 'observed', 'dismissed'].includes(m.state) && (!uuid.test(m.attemptId ?? '') || !Number.isSafeInteger(m.attemptRound) || !Number.isFinite(m.attemptedAt))) fail('corrupt', 'Invalid attempt ledger');
  }
}
export function validateLedger(value: unknown, authorityId: string): asserts value is Ledger { validateCommon(value, authorityId, 2); }
export function migrateLedger(value: unknown, authorityId: string): { ledger: Ledger; migrated: boolean } {
  if ((value as { version?: unknown })?.version === 2) { validateLedger(value, authorityId); return { ledger: value, migrated: false }; }
  validateCommon(value, authorityId, 1);
  const legacy = value as LegacyLedger;
  const ledger: Ledger = {
    version: 2,
    authorityId: legacy.authorityId,
    sequence: legacy.sequence,
    groups: Object.fromEntries(Object.entries(legacy.groups).map(([id, group]) => [id, { ...group }])),
    peers: Object.fromEntries(Object.entries(legacy.peers).map(([id, peer]) => [id, { ...peer, suspended: false, leaseId: randomUUID() }])),
    messages: Object.fromEntries(Object.entries(legacy.messages).map(([id, message]) => [id, { ...message }])),
  };
  validateLedger(ledger, authorityId); return { ledger, migrated: true };
}
export function peerLifecycle(peer: Peer, now = Date.now()): PeerLifecycle {
  if (!peer.active) return 'left';
  if (peer.suspended) return 'suspended';
  return now - peer.lastSeen <= ONLINE_WINDOW_MS ? 'online' : 'stale';
}
export function groupOf(s: Ledger, ref: GroupRef): Group {
  if (ref.authorityId !== s.authorityId) fail('authority', 'Messaging authority mismatch');
  const group = Object.hasOwn(s.groups, ref.id) ? s.groups[ref.id] : undefined;
  if (!group) fail('missing', 'Group does not exist');
  return group;
}
export function activePeer(s: Ledger, id: string): PeerRecord {
  const peer = Object.hasOwn(s.peers, id) ? s.peers[id] : undefined;
  if (!peer?.active) fail('participation', 'Peer is not active; explicitly join again');
  return peer;
}
export function requireLease(s: Ledger, lease: ParticipantLease): PeerRecord {
  const peer = activePeer(s, lease.peerId);
  if (peer.suspended || !uuid.test(lease.leaseId) || peer.leaseId !== lease.leaseId) fail('participation', 'Peer lease is no longer current; explicitly resume or join again');
  return peer;
}
export function refOf(g: Group): GroupRef { return { authorityId: g.authorityId, id: g.id, label: g.label }; }
export function createGroup(s: Ledger, label: string): GroupRef {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(label)) fail('validation', 'Group label must be 1–48 lowercase letters/digits/hyphens, starting with a letter');
  const existing = Object.values(s.groups).find(group => group.label === label);
  if (existing) return refOf(existing);
  if (Object.keys(s.groups).length >= 32) fail('full', 'Group store full; prune inactive groups');
  const group: Group = { authorityId: s.authorityId, id: randomUUID(), label, mode: 'paused', round: 0, limit: 0, used: 0 };
  s.groups[group.id] = group; return refOf(group);
}
export function joinPeer(s: Ledger, ref: GroupRef, info: { sessionId: string; displayName: string }): PeerRecord {
  const group = groupOf(s, ref);
  if (!info.sessionId || info.sessionId.length > 256) fail('validation', 'Invalid session ID');
  if (Object.values(s.peers).some(peer => peer.groupId === group.id && peer.sessionId === info.sessionId && peer.active)) fail('participation', 'This Pi session already has an existing messaging peer; resume it instead of creating a duplicate');
  if (Object.keys(s.peers).length >= 512 || Object.values(s.peers).filter(peer => peer.groupId === group.id && peer.active).length >= 16) fail('full', 'Peer store full; leave/revoke and prune old peers');
  const peer: PeerRecord = { id: randomUUID(), groupId: group.id, sessionId: info.sessionId, displayName: validateDisplayName(info.displayName), active: true, suspended: false, lastSeen: Date.now(), leaseId: randomUUID() };
  s.peers[peer.id] = peer; return peer;
}
export function resumePeer(s: Ledger, ref: GroupRef, sessionId: string, peerId: string, now = Date.now()): PeerRecord {
  const group = groupOf(s, ref); const peer = Object.hasOwn(s.peers, peerId) ? s.peers[peerId] : undefined;
  if (!peer || peer.groupId !== group.id || peer.sessionId !== sessionId) fail('participation', 'Peer does not belong to this session and group');
  if (!peer.active) fail('participation', 'Peer was explicitly left or revoked');
  if (peerLifecycle(peer, now) === 'online') fail('participation', 'Matching messaging peer is still online; return to it or explicitly revoke it');
  peer.suspended = false; peer.lastSeen = now; peer.leaseId = randomUUID(); return peer;
}
export function suspendPeer(s: Ledger, lease: ParticipantLease): void { const peer = requireLease(s, lease); peer.suspended = true; peer.leaseId = randomUUID(); }
export function leavePeer(s: Ledger, lease: ParticipantLease): void { const peer = requireLease(s, lease); peer.active = false; peer.suspended = false; peer.leaseId = randomUUID(); }
export function revokePeer(s: Ledger, ref: GroupRef, id: string): void {
  groupOf(s, ref); const peer = Object.hasOwn(s.peers, id) ? s.peers[id] : undefined;
  if (!peer || peer.groupId !== ref.id) fail('missing', 'Peer not in group');
  peer.active = false; peer.suspended = false; peer.leaseId = randomUUID();
}
export function heartbeat(s: Ledger, lease: ParticipantLease, displayName?: string): void { const peer = requireLease(s, lease); peer.lastSeen = Date.now(); if (displayName !== undefined) peer.displayName = validateDisplayName(displayName); }
export function arm(s: Ledger, ref: GroupRef, limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('validation', 'Allowance must be an integer from 1 to 100');
  const group = groupOf(s, ref); group.round++; group.limit = limit; group.used = 0; group.mode = 'armed';
}
export function pause(s: Ledger, ref: GroupRef): void { groupOf(s, ref).mode = 'paused'; }
export function prepareMessage(s: Ledger, senderLease: ParticipantLease, input: SendInput, requestKey: string): MessageStatus {
  const sender = requireLease(s, senderLease); validateInput(input);
  if (!requestKey || requestKey.length > 512) fail('validation', 'Invalid request key');
  const hash = payloadHash(input);
  const existing = Object.values(s.messages).find(message => message.senderPeerId === sender.id && message.requestKey === requestKey);
  if (existing) { if (existing.hash !== hash) fail('conflict', 'Send idempotency conflict'); return existing; }
  const recipient = activePeer(s, input.toPeerId);
  if (sender.id === recipient.id || sender.groupId !== recipient.groupId) fail('validation', 'Recipient must be another peer in the same group');
  if (input.inReplyTo && (!Object.hasOwn(s.messages, input.inReplyTo) || s.messages[input.inReplyTo].groupId !== sender.groupId)) fail('validation', 'Reply reference is not in this group');
  if (Object.keys(s.messages).length >= 2000 || Object.values(s.messages).filter(message => message.groupId === sender.groupId && ['queued', 'attempted'].includes(message.state)).length >= 64) fail('full', 'Message queue/store full; cancel, dismiss, or prune from the human inbox');
  if (s.sequence >= Number.MAX_SAFE_INTEGER) fail('full', 'Sequence exhausted');
  const message: MessageStatus = { id: randomUUID(), sequence: ++s.sequence, groupId: sender.groupId, senderPeerId: sender.id, recipientPeerId: recipient.id, senderName: sender.displayName, requestKey, hash, createdAt: Date.now(), state: 'queued', ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}) };
  s.messages[message.id] = message; return message;
}
export function canReceive(s: Ledger, lease: ParticipantLease): boolean {
  const peer = requireLease(s, lease); const group = s.groups[peer.groupId];
  return group.mode === 'armed' && group.used < group.limit && !Object.values(s.messages).some(message => message.recipientPeerId === peer.id && message.state === 'attempted');
}
export function admit(s: Ledger, lease: ParticipantLease, messageId: string): Reservation | null {
  if (!canReceive(s, lease)) return null;
  const peer = requireLease(s, lease); const message = Object.hasOwn(s.messages, messageId) ? s.messages[messageId] : undefined;
  if (!message || message.recipientPeerId !== peer.id || message.state !== 'queued') return null;
  const group = s.groups[message.groupId];
  message.state = 'attempted'; message.attemptId = randomUUID(); message.attemptRound = group.round; message.attemptedAt = Date.now();
  if (++group.used === group.limit) group.mode = 'exhausted';
  return { group: refOf(group), peerId: peer.id, message: { ...message }, attemptId: message.attemptId, round: group.round };
}
export function observe(s: Ledger, lease: ParticipantLease, reservation: Reservation): void {
  const peer = requireLease(s, lease); groupOf(s, reservation.group);
  const message = Object.hasOwn(s.messages, reservation.message.id) ? s.messages[reservation.message.id] : undefined;
  if (peer.id !== reservation.peerId || !message || message.groupId !== reservation.group.id || message.recipientPeerId !== reservation.peerId || message.attemptId !== reservation.attemptId || message.attemptRound !== reservation.round || !['attempted', 'observed', 'dismissed'].includes(message.state)) fail('receipt', 'Invalid receipt correlation');
  message.observedAt ??= Date.now();
  if (message.state === 'attempted') { message.state = 'observed'; message.terminalAt = Date.now(); }
}
export function resolveMessage(s: Ledger, ref: GroupRef, id: string, state: 'canceled' | 'dismissed'): void {
  groupOf(s, ref); const message = Object.hasOwn(s.messages, id) ? s.messages[id] : undefined;
  if (!message || message.groupId !== ref.id || (state === 'canceled' ? message.state !== 'queued' : state !== 'dismissed' || message.state !== 'attempted')) fail('validation', 'Message is not eligible for that recovery action');
  message.state = state; message.terminalAt = Date.now();
}
export function prunable(s: Ledger, ref: GroupRef, before: number): string[] {
  groupOf(s, ref);
  return Object.values(s.messages).filter(message => message.groupId === ref.id && ['observed', 'canceled', 'dismissed'].includes(message.state) && !s.peers[message.senderPeerId].active && (message.terminalAt ?? Infinity) < before).map(message => message.id);
}
export function summary(s: Ledger, ref: GroupRef): GroupSummary {
  const group = groupOf(s, ref);
  return { group: refOf(group), mode: group.mode, roundNumber: group.round, limit: group.limit, used: group.used, remaining: group.limit - group.used, onlinePeers: Object.values(s.peers).filter(peer => peer.groupId === group.id && peerLifecycle(peer) === 'online').length, pendingCount: Object.values(s.messages).filter(message => message.groupId === group.id && ['queued', 'attempted'].includes(message.state)).length };
}
export function envelope(s: Ledger, message: MessageStatus, text: string): Envelope {
  return { version: 1, authorityId: s.authorityId, groupId: message.groupId, messageId: message.id, senderPeerId: message.senderPeerId, recipientPeerId: message.recipientPeerId, senderName: message.senderName, createdAt: message.createdAt, text, ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}) };
}
export function validateEnvelope(envelope: Envelope, s: Ledger, message: MessageStatus): void {
  if (!envelope || envelope.version !== 1 || envelope.authorityId !== s.authorityId || envelope.groupId !== message.groupId || envelope.messageId !== message.id || envelope.senderPeerId !== message.senderPeerId || envelope.recipientPeerId !== message.recipientPeerId || envelope.senderName !== message.senderName || envelope.createdAt !== message.createdAt || envelope.inReplyTo !== message.inReplyTo || payloadHash({ toPeerId: envelope.recipientPeerId, text: envelope.text, ...(envelope.inReplyTo ? { inReplyTo: envelope.inReplyTo } : {}) }) !== message.hash) fail('corrupt', 'Message envelope does not match authoritative metadata');
}
