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
function send(f, key = randomUUID(), text = 'hello') {
  return p.prepareMessage(f.state, f.a.id, { toPeerId: f.b.id, text }, key);
}
function addPeer(f, suffix) {
  return p.joinPeer(f.state, f.group, { sessionId: `session-${suffix}`, displayName: `Peer ${suffix}` });
}
function sendFrom(f, sender, key = randomUUID(), text = 'hello') {
  return p.prepareMessage(f.state, sender.id, { toPeerId: f.b.id, text }, key);
}

test('joining cannot grant queue capacity; admissions consume a shared non-refilling budget', () => {
  const f = fixture();
  assert.throws(() => send(f), /allowance|capacity/i);
  p.arm(f.state, f.group, 2);
  const first = send(f);
  const r = p.admit(f.state, f.b.id, first.id);
  assert.equal(f.state.groups[f.group.id].used, 1);
  assert.equal(p.admit(f.state, f.b.id, first.id), null);
  const second = sendFrom(f, addPeer(f, 'c'));
  assert.equal(p.admit(f.state, f.b.id, second.id), null, 'unresolved attempt gates recipient');
  p.observe(f.state, r);
  assert.ok(p.admit(f.state, f.b.id, second.id));
  assert.equal(f.state.groups[f.group.id].mode, 'exhausted');
  p.arm(f.state, f.group, 12);
  assert.equal(p.admit(f.state, f.b.id, second.id), null, 'rearming cannot replay attempts');
});

test('send retries preserve identity after capacity closes while new sender work is bounded', () => {
  const f = fixture(); p.arm(f.state, f.group, 1);
  const m = send(f, 'call-1');
  assert.equal(send(f, 'call-1').id, m.id);
  assert.throws(() => send(f, 'call-1', 'changed'), /conflict/i);
  assert.throws(() => sendFrom(f, addPeer(f, 'c')), /allowance|capacity/i);
  assert.equal(send(f, 'call-1').id, m.id);
  assert.equal(Object.keys(f.state.messages).length, 1);
});

test('queued messages reserve allowance and cancellation releases it while pause preserves it', () => {
  const f = fixture(); const c = addPeer(f, 'c'); const d = addPeer(f, 'd');
  p.arm(f.state, f.group, 2); p.pause(f.state, f.group);
  const first = send(f, 'a-one');
  const second = sendFrom(f, c, 'c-one');
  assert.equal(f.state.groups[f.group.id].used, 0);
  assert.throws(() => sendFrom(f, d, 'd-one'), /allowance|capacity/i);
  p.resolveMessage(f.state, f.group, second.id, 'canceled');
  assert.ok(sendFrom(f, d, 'd-one'));
  assert.throws(() => p.arm(f.state, f.group, 1), /queued|allowance|limit/i);
  assert.equal(f.state.groups[f.group.id].limit, 2);
  assert.equal(f.state.messages[first.id].state, 'queued');
});

test('one sender may have only one unresolved outbound until it becomes terminal', () => {
  const f = fixture(); p.arm(f.state, f.group, 4);
  const first = send(f, 'first');
  assert.throws(() => send(f, 'second'), /sender|unresolved|busy/i);
  p.resolveMessage(f.state, f.group, first.id, 'canceled');
  const second = send(f, 'second'); const reservation = p.admit(f.state, f.b.id, second.id);
  assert.throws(() => send(f, 'third'), /sender|unresolved|busy/i);
  p.observe(f.state, reservation);
  assert.ok(send(f, 'third'));
});

test('one recipient accepts at most eight queued messages', () => {
  const f = fixture(); p.arm(f.state, f.group, 9);
  const senders = [f.a, ...Array.from({ length: 8 }, (_, i) => addPeer(f, `sender-${i}`))];
  for (let i = 0; i < 8; i++) assert.ok(sendFrom(f, senders[i], `message-${i}`));
  assert.throws(() => sendFrom(f, senders[8], 'message-8'), /eight|recipient|full/i);
  assert.equal(Object.values(f.state.messages).filter(m => m.state === 'queued').length, 8);
});

test('reject invalid bodies, names, groups, cross-group routing, replies, self-send and departed senders', () => {
  const f = fixture();
  for (const text of ['', '   ', '🙂'.repeat(2049)]) assert.throws(() => send(f, randomUUID(), text));
  for (const name of ['../bad', 'x.*', 'Upper', 'a'.repeat(49)]) assert.throws(() => p.createGroup(f.state, name));
  assert.throws(() => p.joinPeer(f.state, f.group, { sessionId: 's', displayName: '\x1b[31mname' }));
  assert.throws(() => p.prepareMessage(f.state, f.a.id, { toPeerId: f.a.id, text: 'x' }, 'self'));
  const g2 = p.createGroup(f.state, 'other');
  const outsider = p.joinPeer(f.state, g2, { sessionId: 's', displayName: 'Other' });
  assert.throws(() => p.prepareMessage(f.state, f.a.id, { toPeerId: outsider.id, text: 'x' }, 'cross'));
  assert.throws(() => p.prepareMessage(f.state, f.a.id, { toPeerId: f.b.id, text: 'x', inReplyTo: randomUUID() }, 'reply'));
  p.leavePeer(f.state, f.a.id);
  assert.throws(() => send(f), /active/i);
});

test('membership and retained-group bounds reject overflow without changing existing state', () => {
  const f = fixture();
  for (let i = 2; i < 16; i++) p.joinPeer(f.state, f.group, { sessionId: `s-${i}`, displayName: `Peer ${i}` });
  assert.throws(() => p.joinPeer(f.state, f.group, { sessionId: 'extra', displayName: 'Extra' }), /full/i);
  assert.equal(Object.keys(f.state.peers).length, 16);
  for (let i = 1; i < 32; i++) p.createGroup(f.state, `group-${i}`);
  assert.throws(() => p.createGroup(f.state, 'extra'), /full/i);
  assert.equal(Object.keys(f.state.groups).length, 32);
  p.arm(f.state, f.group, 1);
  assert.ok(send(f, 'utf8-boundary', '🙂'.repeat(2048)));
  assert.equal(f.state.groups[f.group.id].used, 0);
});

test('pause, dismissal, and revocation cannot refund or replay; forged receipts fail', () => {
  const f = fixture(); p.arm(f.state, f.group, 3);
  const first = send(f); const r = p.admit(f.state, f.b.id, first.id);
  assert.throws(() => p.observe(f.state, { ...r, attemptId: randomUUID() }), /receipt/i);
  p.pause(f.state, f.group);
  p.resolveMessage(f.state, f.group, first.id, 'dismissed');
  p.observe(f.state, r);
  assert.equal(f.state.messages[first.id].state, 'dismissed');
  assert.ok(f.state.messages[first.id].observedAt);
  assert.equal(f.state.groups[f.group.id].used, 1);
  const next = send(f); assert.equal(p.admit(f.state, f.b.id, next.id), null);
  p.arm(f.state, f.group, 1); p.leavePeer(f.state, f.b.id);
  assert.equal(p.admit(f.state, f.b.id, next.id), null);
});

test('pruning preserves unresolved work and live-sender deduplication', () => {
  const f = fixture(); p.arm(f.state, f.group, 2);
  const canceled = send(f); p.resolveMessage(f.state, f.group, canceled.id, 'canceled');
  const queued = send(f);
  assert.deepEqual(p.prunable(f.state, f.group, Infinity), []);
  p.leavePeer(f.state, f.a.id);
  assert.deepEqual(p.prunable(f.state, f.group, Infinity), [canceled.id]);
  assert.equal(f.state.messages[queued.id].state, 'queued');
});

test('summaries omit bodies and authority mismatch or invalid state fails closed', () => {
  const f = fixture(); p.arm(f.state, f.group, 1); send(f, 'key', 'secret-body');
  assert.equal(JSON.stringify(p.summary(f.state, f.group)).includes('secret-body'), false);
  assert.throws(() => p.summary(f.state, { ...f.group, authorityId: randomUUID() }), /authority/i);
  assert.throws(() => p.validateLedger({ ...f.state, version: 900 }, f.state.authorityId));
  for (const field of ['groups', 'peers', 'messages']) assert.throws(() => p.validateLedger({ ...p.newLedger(f.state.authorityId), [field]: [] }, f.state.authorityId));
  f.state.groups[f.group.id].used = -1;
  assert.throws(() => p.validateLedger(f.state, f.state.authorityId));
  assert.equal(p.safeText('\x1b[31mhello\u202e'), '\\u001b[31mhello\\u202e');
  assert.equal(p.safeText('a\rb\tc\nend'), 'a\\u000db\\u0009c\nend');
});
