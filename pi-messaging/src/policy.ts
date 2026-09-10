import { createHash, randomUUID } from 'node:crypto';
import { MessagingError, type Envelope, type Group, type GroupRef, type GroupSummary, type MessageStatus, type Peer, type Reservation, type SendInput } from './contracts.ts';

export interface Ledger { version: 1; authorityId: string; sequence: number; groups: Record<string, Group>; peers: Record<string, Peer>; messages: Record<string, MessageStatus> }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const control = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
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
  return { version: 1, authorityId, sequence: 0, groups: {}, peers: {}, messages: {} };
}
export function validateLedger(value: unknown, authorityId: string): asserts value is Ledger {
  const s = value as Ledger;
  if (!s || s.version !== 1 || ![s.groups, s.peers, s.messages].every(map => map && typeof map === 'object' && !Array.isArray(map)) || !Number.isSafeInteger(s.sequence) || s.sequence < 0) fail('corrupt', 'Unsupported or corrupt messaging ledger');
  if (s.authorityId !== authorityId) fail('authority', 'Messaging authority mismatch; refusing replacement state');
  if (Object.keys(s.groups).length > 32 || Object.keys(s.peers).length > 512 || Object.keys(s.messages).length > 2000) fail('corrupt', 'Ledger exceeds bounds');
  for (const [id, g] of Object.entries(s.groups)) {
    if (!uuid.test(id) || g.id !== id || g.authorityId !== authorityId || !/^[a-z][a-z0-9-]{0,47}$/.test(g.label) || !['paused', 'armed', 'exhausted'].includes(g.mode) || ![g.used, g.limit, g.round].every(n => Number.isSafeInteger(n) && n >= 0) || g.used > g.limit || g.limit > 100 || (g.mode === 'exhausted' && g.used !== g.limit) || (g.mode === 'armed' && g.used >= g.limit)) fail('corrupt', 'Invalid group ledger');
  }
  for (const [id, p] of Object.entries(s.peers)) {
    if (!uuid.test(id) || p.id !== id || !Object.hasOwn(s.groups, p.groupId) || typeof p.active !== 'boolean' || typeof p.sessionId !== 'string' || !Number.isFinite(p.lastSeen)) fail('corrupt', 'Invalid peer ledger');
    validateDisplayName(p.displayName);
  }
  for (const [id, m] of Object.entries(s.messages)) {
    if (!uuid.test(id) || m.id !== id || !Object.hasOwn(s.groups, m.groupId) || !Object.hasOwn(s.peers, m.senderPeerId) || !Object.hasOwn(s.peers, m.recipientPeerId) || s.peers[m.senderPeerId].groupId !== m.groupId || s.peers[m.recipientPeerId].groupId !== m.groupId || !['queued', 'attempted', 'observed', 'canceled', 'dismissed'].includes(m.state) || !Number.isSafeInteger(m.sequence) || m.sequence < 1 || m.sequence > s.sequence || typeof m.requestKey !== 'string' || !/^[0-9a-f]{64}$/.test(m.hash) || !Number.isFinite(m.createdAt)) fail('corrupt', 'Invalid message ledger');
    if (['attempted', 'observed', 'dismissed'].includes(m.state) && (!uuid.test(m.attemptId ?? '') || !Number.isSafeInteger(m.attemptRound) || !Number.isFinite(m.attemptedAt))) fail('corrupt', 'Invalid attempt ledger');
  }
}
export function groupOf(s: Ledger, ref: GroupRef): Group {
  if (ref.authorityId !== s.authorityId) fail('authority', 'Messaging authority mismatch');
  const g = Object.hasOwn(s.groups, ref.id) ? s.groups[ref.id] : undefined;
  if (!g) fail('missing', 'Group does not exist');
  return g;
}
export function activePeer(s: Ledger, id: string): Peer {
  const peer = Object.hasOwn(s.peers, id) ? s.peers[id] : undefined;
  if (!peer?.active) fail('participation', 'Peer is not active; explicitly join again');
  return peer;
}
export function refOf(g: Group): GroupRef { return { authorityId: g.authorityId, id: g.id, label: g.label }; }
export function createGroup(s: Ledger, label: string): GroupRef {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(label)) fail('validation', 'Group label must be 1–48 lowercase letters/digits/hyphens, starting with a letter');
  const existing = Object.values(s.groups).find(g => g.label === label);
  if (existing) return refOf(existing);
  if (Object.keys(s.groups).length >= 32) fail('full', 'Group store full; prune inactive groups');
  const g: Group = { authorityId: s.authorityId, id: randomUUID(), label, mode: 'paused', round: 0, limit: 0, used: 0 };
  s.groups[g.id] = g; return refOf(g);
}
export function joinPeer(s: Ledger, ref: GroupRef, info: { sessionId: string; displayName: string }): Peer {
  const group = groupOf(s, ref);
  if (Object.keys(s.peers).length >= 512 || Object.values(s.peers).filter(p => p.groupId === group.id && p.active).length >= 16) fail('full', 'Peer store full; leave/revoke and prune old peers');
  if (!info.sessionId || info.sessionId.length > 256) fail('validation', 'Invalid session ID');
  const peer: Peer = { id: randomUUID(), groupId: group.id, sessionId: info.sessionId, displayName: validateDisplayName(info.displayName), active: true, lastSeen: Date.now() };
  s.peers[peer.id] = peer; return peer;
}
export function leavePeer(s: Ledger, id: string): void { if (Object.hasOwn(s.peers, id)) s.peers[id].active = false; }
export function heartbeat(s: Ledger, id: string, displayName?: string): void { const peer = activePeer(s, id); peer.lastSeen = Date.now(); if (displayName !== undefined) peer.displayName = validateDisplayName(displayName); }
export function arm(s: Ledger, ref: GroupRef, limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('validation', 'Allowance must be an integer from 1 to 100');
  const g = groupOf(s, ref); g.round++; g.limit = limit; g.used = 0; g.mode = 'armed';
}
export function pause(s: Ledger, ref: GroupRef): void { groupOf(s, ref).mode = 'paused'; }
export function prepareMessage(s: Ledger, peerId: string, input: SendInput, requestKey: string): MessageStatus {
  const sender = activePeer(s, peerId); validateInput(input);
  if (!requestKey || requestKey.length > 512) fail('validation', 'Invalid request key');
  const hash = payloadHash(input);
  const existing = Object.values(s.messages).find(m => m.senderPeerId === peerId && m.requestKey === requestKey);
  if (existing) { if (existing.hash !== hash) fail('conflict', 'Send idempotency conflict'); return existing; }
  const recipient = activePeer(s, input.toPeerId);
  if (sender.id === recipient.id || sender.groupId !== recipient.groupId) fail('validation', 'Recipient must be another peer in the same group');
  if (input.inReplyTo && (!Object.hasOwn(s.messages, input.inReplyTo) || s.messages[input.inReplyTo].groupId !== sender.groupId)) fail('validation', 'Reply reference is not in this group');
  if (Object.keys(s.messages).length >= 2000 || Object.values(s.messages).filter(m => m.groupId === sender.groupId && ['queued', 'attempted'].includes(m.state)).length >= 64) fail('full', 'Message queue/store full; cancel, dismiss, or prune from the human inbox');
  if (s.sequence >= Number.MAX_SAFE_INTEGER) fail('full', 'Sequence exhausted');
  const m: MessageStatus = { id: randomUUID(), sequence: ++s.sequence, groupId: sender.groupId, senderPeerId: sender.id, recipientPeerId: recipient.id, senderName: sender.displayName, requestKey, hash, createdAt: Date.now(), state: 'queued', ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}) };
  s.messages[m.id] = m; return m;
}
export function canReceive(s: Ledger, peerId: string): boolean {
  const p = Object.hasOwn(s.peers, peerId) ? s.peers[peerId] : undefined;
  if (!p?.active) return false;
  const g = s.groups[p.groupId];
  return g.mode === 'armed' && g.used < g.limit && !Object.values(s.messages).some(m => m.recipientPeerId === peerId && m.state === 'attempted');
}
export function admit(s: Ledger, peerId: string, messageId: string): Reservation | null {
  if (!canReceive(s, peerId)) return null;
  const m = Object.hasOwn(s.messages, messageId) ? s.messages[messageId] : undefined;
  if (!m || m.recipientPeerId !== peerId || m.state !== 'queued') return null;
  const g = s.groups[m.groupId];
  m.state = 'attempted'; m.attemptId = randomUUID(); m.attemptRound = g.round; m.attemptedAt = Date.now();
  if (++g.used === g.limit) g.mode = 'exhausted';
  return { group: refOf(g), peerId, message: { ...m }, attemptId: m.attemptId, round: g.round };
}
export function observe(s: Ledger, r: Reservation): void {
  groupOf(s, r.group);
  const m = Object.hasOwn(s.messages, r.message.id) ? s.messages[r.message.id] : undefined;
  if (!m || m.groupId !== r.group.id || m.recipientPeerId !== r.peerId || m.attemptId !== r.attemptId || m.attemptRound !== r.round || !['attempted', 'observed', 'dismissed'].includes(m.state)) fail('receipt', 'Invalid receipt correlation');
  m.observedAt ??= Date.now();
  if (m.state === 'attempted') { m.state = 'observed'; m.terminalAt = Date.now(); }
}
export function resolveMessage(s: Ledger, ref: GroupRef, id: string, state: 'canceled' | 'dismissed'): void {
  groupOf(s, ref); const m = Object.hasOwn(s.messages, id) ? s.messages[id] : undefined;
  if (!m || m.groupId !== ref.id || (state === 'canceled' ? m.state !== 'queued' : state !== 'dismissed' || m.state !== 'attempted')) fail('validation', 'Message is not eligible for that recovery action');
  m.state = state; m.terminalAt = Date.now();
}
export function prunable(s: Ledger, ref: GroupRef, before: number): string[] {
  groupOf(s, ref);
  return Object.values(s.messages).filter(m => m.groupId === ref.id && ['observed', 'canceled', 'dismissed'].includes(m.state) && !s.peers[m.senderPeerId].active && (m.terminalAt ?? Infinity) < before).map(m => m.id);
}
export function summary(s: Ledger, ref: GroupRef): GroupSummary {
  const g = groupOf(s, ref);
  return { group: refOf(g), mode: g.mode, roundNumber: g.round, limit: g.limit, used: g.used, remaining: g.limit - g.used, onlinePeers: Object.values(s.peers).filter(p => p.groupId === g.id && p.active && Date.now() - p.lastSeen <= 30000).length, pendingCount: Object.values(s.messages).filter(m => m.groupId === g.id && ['queued', 'attempted'].includes(m.state)).length };
}
export function envelope(s: Ledger, m: MessageStatus, text: string): Envelope {
  return { version: 1, authorityId: s.authorityId, groupId: m.groupId, messageId: m.id, senderPeerId: m.senderPeerId, recipientPeerId: m.recipientPeerId, senderName: m.senderName, createdAt: m.createdAt, text, ...(m.inReplyTo ? { inReplyTo: m.inReplyTo } : {}) };
}
export function validateEnvelope(e: Envelope, s: Ledger, m: MessageStatus): void {
  if (!e || e.version !== 1 || e.authorityId !== s.authorityId || e.groupId !== m.groupId || e.messageId !== m.id || e.senderPeerId !== m.senderPeerId || e.recipientPeerId !== m.recipientPeerId || e.senderName !== m.senderName || e.createdAt !== m.createdAt || e.inReplyTo !== m.inReplyTo || payloadHash({ toPeerId: e.recipientPeerId, text: e.text, ...(e.inReplyTo ? { inReplyTo: e.inReplyTo } : {}) }) !== m.hash) fail('corrupt', 'Message envelope does not match authoritative metadata');
}
