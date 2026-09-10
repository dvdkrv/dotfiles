import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const p = await jiti.import('../src/policy.ts');

function fixture() {
  const state = p.newLedger(randomUUID());
  const group = p.createGroup(state, 'review');
  const a = p.joinPeer(state, group, { sessionId: 'session-a', displayName: 'Alice' });
  const b = p.joinPeer(state, group, { sessionId: 'session-b', displayName: 'Bob' });
  return { state, group, a, b };
}
const lease = peer => ({ peerId: peer.id, leaseId: peer.leaseId });
function send(f, key = randomUUID(), text = 'hello') {
  return p.prepareMessage(f.state, lease(f.a), { toPeerId: f.b.id, text }, key);
}

test('joining cannot grant credits; admissions consume a shared non-refilling budget', () => {
  const f = fixture();
  const first = send(f);
  assert.equal(p.admit(f.state, lease(f.b), first.id), null);
  p.arm(f.state, f.group, 2);
  const r = p.admit(f.state, lease(f.b), first.id);
  assert.equal(f.state.groups[f.group.id].used, 1);
  assert.equal(p.admit(f.state, lease(f.b), first.id), null);
  const second = send(f);
  assert.equal(p.admit(f.state, lease(f.b), second.id), null, 'unresolved attempt gates recipient');
  p.observe(f.state, lease(f.b), r);
  assert.ok(p.admit(f.state, lease(f.b), second.id));
  assert.equal(f.state.groups[f.group.id].mode, 'exhausted');
  p.arm(f.state, f.group, 12);
  assert.equal(p.admit(f.state, lease(f.b), second.id), null, 'rearming cannot replay attempts');
});

test('send retries preserve identity and quotas, conflicting requests fail', () => {
  const f = fixture();
  const m = send(f, 'call-1');
  assert.equal(send(f, 'call-1').id, m.id);
  assert.throws(() => send(f, 'call-1', 'changed'), /conflict/i);
  for (let i = 1; i < 64; i++) send(f);
  assert.throws(() => send(f), /full/i);
  assert.equal(send(f, 'call-1').id, m.id);
});

test('reject invalid bodies, names, groups, cross-group routing, replies, self-send and departed senders', () => {
  const f = fixture();
  for (const text of ['', '   ', '🙂'.repeat(2049)]) assert.throws(() => send(f, randomUUID(), text));
  for (const name of ['../bad', 'x.*', 'Upper', 'a'.repeat(49)]) assert.throws(() => p.createGroup(f.state, name));
  assert.throws(() => p.joinPeer(f.state, f.group, { sessionId: 's', displayName: '\x1b[31mname' }));
  assert.throws(() => p.prepareMessage(f.state, lease(f.a), { toPeerId: f.a.id, text: 'x' }, 'self'));
  const g2 = p.createGroup(f.state, 'other');
  const outsider = p.joinPeer(f.state, g2, { sessionId: 's', displayName: 'Other' });
  assert.throws(() => p.prepareMessage(f.state, lease(f.a), { toPeerId: outsider.id, text: 'x' }, 'cross'));
  assert.throws(() => p.prepareMessage(f.state, lease(f.a), { toPeerId: f.b.id, text: 'x', inReplyTo: randomUUID() }, 'reply'));
  p.leavePeer(f.state, lease(f.a));
  assert.throws(() => send(f), /active|lease|participation/i);
});

test('fresh join cannot duplicate an active same-session membership', () => {
  const f = fixture();
  assert.throws(() => p.joinPeer(f.state, f.group, { sessionId: f.a.sessionId, displayName: 'Duplicate' }), /resume|existing|session/i);
  assert.equal(Object.values(f.state.peers).filter(peer => peer.sessionId === f.a.sessionId).length, 1);
});

test('membership and retained-group bounds reject overflow without changing existing state', () => {
  const f = fixture();
  for (let i = 2; i < 16; i++) p.joinPeer(f.state, f.group, { sessionId: `s-${i}`, displayName: `Peer ${i}` });
  assert.throws(() => p.joinPeer(f.state, f.group, { sessionId: 'extra', displayName: 'Extra' }), /full/i);
  assert.equal(Object.keys(f.state.peers).length, 16);
  for (let i = 1; i < 32; i++) p.createGroup(f.state, `group-${i}`);
  assert.throws(() => p.createGroup(f.state, 'extra'), /full/i);
  assert.equal(Object.keys(f.state.groups).length, 32);
  assert.ok(send(f, 'utf8-boundary', '🙂'.repeat(2048)));
  assert.equal(f.state.groups[f.group.id].used, 0);
});

test('pause, dismissal, and revocation cannot refund or replay; forged receipts fail', () => {
  const f = fixture(); p.arm(f.state, f.group, 3);
  const first = send(f); const r = p.admit(f.state, lease(f.b), first.id);
  assert.throws(() => p.observe(f.state, lease(f.b), { ...r, attemptId: randomUUID() }), /receipt/i);
  p.pause(f.state, f.group);
  p.resolveMessage(f.state, f.group, first.id, 'dismissed');
  p.observe(f.state, lease(f.b), r);
  assert.equal(f.state.messages[first.id].state, 'dismissed');
  assert.ok(f.state.messages[first.id].observedAt);
  assert.equal(f.state.groups[f.group.id].used, 1);
  const next = send(f); assert.equal(p.admit(f.state, lease(f.b), next.id), null);
  p.arm(f.state, f.group, 1); p.leavePeer(f.state, lease(f.b));
  assert.throws(() => p.admit(f.state, lease(f.b), next.id), /active|lease|participation/i);
});

test('pruning preserves unresolved work and live-sender deduplication', () => {
  const f = fixture(); const queued = send(f); const canceled = send(f);
  p.resolveMessage(f.state, f.group, canceled.id, 'canceled');
  assert.deepEqual(p.prunable(f.state, f.group, Infinity), []);
  p.leavePeer(f.state, lease(f.a));
  assert.deepEqual(p.prunable(f.state, f.group, Infinity), [canceled.id]);
  assert.equal(f.state.messages[queued.id].state, 'queued');
});

test('resume rotates the lease, preserves routing, and fences every old-owner mutation', () => {
  const f = fixture(); const now = 100_000;
  const aLease = { peerId: f.a.id, leaseId: f.a.leaseId };
  const oldLease = { peerId: f.b.id, leaseId: f.b.leaseId };
  p.suspendPeer(f.state, oldLease);
  assert.equal(f.state.peers[f.b.id].active, true); assert.equal(f.state.peers[f.b.id].suspended, true);
  const queued = p.prepareMessage(f.state, aLease, { toPeerId: f.b.id, text: 'queued while suspended' }, 'suspended');
  const resumed = p.resumePeer(f.state, f.group, f.b.sessionId, f.b.id, now);
  const resumedLease = { peerId: resumed.id, leaseId: resumed.leaseId };
  assert.equal(resumed.id, f.b.id); assert.equal(resumed.displayName, f.b.displayName); assert.notEqual(resumed.leaseId, oldLease.leaseId);
  assert.equal(queued.recipientPeerId, resumed.id); assert.equal(p.peerLifecycle(resumed, now), 'online');
  assert.throws(() => p.heartbeat(f.state, oldLease), /lease|participation/i);
  assert.throws(() => p.suspendPeer(f.state, oldLease), /lease|participation/i);
  assert.throws(() => p.leavePeer(f.state, oldLease), /lease|participation/i);
  p.heartbeat(f.state, resumedLease);
  assert.throws(() => p.resumePeer(f.state, f.group, f.b.sessionId, f.b.id, now), /online/i);
  p.leavePeer(f.state, resumedLease);
  assert.throws(() => p.resumePeer(f.state, f.group, f.b.sessionId, f.b.id, now + 31_000), /left|active|participation/i);
});

test('attempted work remains attempted and unrefunded after peer resume', () => {
  const f = fixture(); const aLease = { peerId: f.a.id, leaseId: f.a.leaseId }; const bLease = { peerId: f.b.id, leaseId: f.b.leaseId };
  const message = p.prepareMessage(f.state, aLease, { toPeerId: f.b.id, text: 'once' }, 'once');
  p.arm(f.state, f.group, 2); const reservation = p.admit(f.state, bLease, message.id);
  p.suspendPeer(f.state, bLease); const resumed = p.resumePeer(f.state, f.group, f.b.sessionId, f.b.id, Date.now());
  assert.equal(p.admit(f.state, { peerId: resumed.id, leaseId: resumed.leaseId }, message.id), null);
  assert.equal(f.state.messages[message.id].state, 'attempted'); assert.equal(f.state.groups[f.group.id].used, 1);
  assert.throws(() => p.observe(f.state, bLease, reservation), /lease|participation/i);
});

test('v1 ledger migration preserves authoritative state and adds private peer lifecycle records', () => {
  const authorityId = randomUUID(); const groupId = randomUUID();
  const activeId = randomUUID(); const inactiveId = randomUUID();
  const queuedId = randomUUID(); const attemptedId = randomUUID(); const attemptId = randomUUID();
  const queuedInput = { toPeerId: inactiveId, text: 'queued body' };
  const attemptedInput = { toPeerId: inactiveId, text: 'attempted body' };
  const v1 = {
    version: 1, authorityId, sequence: 2,
    groups: { [groupId]: { authorityId, id: groupId, label: 'legacy', mode: 'armed', round: 4, limit: 3, used: 1 } },
    peers: {
      [activeId]: { id: activeId, groupId, sessionId: 'active-session', displayName: 'Active', active: true, lastSeen: 100 },
      [inactiveId]: { id: inactiveId, groupId, sessionId: 'inactive-session', displayName: 'Inactive', active: false, lastSeen: 90 },
    },
    messages: {
      [queuedId]: { id: queuedId, sequence: 1, groupId, senderPeerId: activeId, recipientPeerId: inactiveId, senderName: 'Active', requestKey: 'queued', hash: p.payloadHash(queuedInput), createdAt: 101, state: 'queued' },
      [attemptedId]: { id: attemptedId, sequence: 2, groupId, senderPeerId: activeId, recipientPeerId: inactiveId, senderName: 'Active', requestKey: 'attempted', hash: p.payloadHash(attemptedInput), createdAt: 102, state: 'attempted', attemptId, attemptRound: 4, attemptedAt: 103 },
    },
  };
  const before = structuredClone(v1);
  const { ledger, migrated } = p.migrateLedger(v1, authorityId);
  assert.equal(migrated, true); assert.equal(ledger.version, 2);
  assert.deepEqual(ledger.groups, before.groups); assert.deepEqual(ledger.messages, before.messages); assert.equal(ledger.sequence, before.sequence);
  for (const [id, oldPeer] of Object.entries(before.peers)) {
    const { suspended, leaseId, ...preserved } = ledger.peers[id];
    assert.deepEqual(preserved, oldPeer); assert.equal(suspended, false); assert.match(leaseId, /^[0-9a-f-]{36}$/);
  }
  assert.deepEqual(v1, before, 'migration must not mutate its input');
  const current = p.migrateLedger(ledger, authorityId);
  assert.equal(current.migrated, false); assert.equal(current.ledger, ledger);
  assert.equal(p.newLedger(authorityId).version, 2);
  assert.throws(() => p.migrateLedger({ ...v1, version: 3 }, authorityId), /unsupported|corrupt/i);
});

test('peer lifecycle distinguishes online, stale, suspended, and final leave', () => {
  const base = { id: randomUUID(), groupId: randomUUID(), sessionId: 's', displayName: 'role', active: true, suspended: false, lastSeen: 70_000 };
  assert.equal(p.peerLifecycle(base, 100_000), 'online');
  assert.equal(p.peerLifecycle({ ...base, lastSeen: 69_999 }, 100_000), 'stale');
  assert.equal(p.peerLifecycle({ ...base, suspended: true }, 100_000), 'suspended');
  assert.equal(p.peerLifecycle({ ...base, active: false }, 100_000), 'left');
});

test('summaries omit bodies and authority mismatch or invalid state fails closed', () => {
  const f = fixture(); send(f, 'key', 'secret-body');
  assert.equal(JSON.stringify(p.summary(f.state, f.group)).includes('secret-body'), false);
  assert.throws(() => p.summary(f.state, { ...f.group, authorityId: randomUUID() }), /authority/i);
  assert.throws(() => p.validateLedger({ ...f.state, version: 900 }, f.state.authorityId));
  for (const field of ['groups', 'peers', 'messages']) assert.throws(() => p.validateLedger({ ...p.newLedger(f.state.authorityId), [field]: [] }, f.state.authorityId));
  f.state.groups[f.group.id].used = -1;
  assert.throws(() => p.validateLedger(f.state, f.state.authorityId));
  assert.equal(p.safeText('\x1b[31mhello\u202e'), '\\u001b[31mhello\\u202e');
  assert.equal(p.safeText('a\rb\tc\nend'), 'a\\u000db\\u0009c\nend');
});
