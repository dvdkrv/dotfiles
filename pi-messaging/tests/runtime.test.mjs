import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createJiti } from 'jiti';
const { MessagingRuntime } = await createJiti(import.meta.url).import('../src/runtime.ts');
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const group = { authorityId: randomUUID(), id: randomUUID(), label: 'review' };
  const peer = { id: randomUUID(), groupId: group.id };
  const r = { group, peerId: peer.id, message: { id: randomUUID() }, attemptId: randomUUID(), round: 1 };
  r.envelope = { version: 1, authorityId: group.authorityId, groupId: group.id, messageId: r.message.id, recipientPeerId: peer.id, senderPeerId: randomUUID(), senderName: 'Alice', createdAt: 10, text: 'peer text\x1b[31m' };
  const calls = []; const observed = []; const errors = [];
  let next = r; let ready = true;
  const backend = { peer, closed: false, getGroupSummary: async () => ({ group, remaining: 11, mode: 'armed' }), reserve: async () => { const value = next; next = null; return value; }, observe: async x => { observed.push(x); }, suspend: async () => {}, leave: async () => {}, heartbeat: async () => {}, onChange: () => () => {} };
  const runtime = new MessagingRuntime(backend, group, { ready: () => ready, deliver: (...args) => calls.push(args), status: () => {}, error: text => errors.push(text) });
  return { runtime, backend, group, r, calls, observed, errors, setReady: x => { ready = x; } };
}

test('idle readiness hands off attributed custom content once as a follow-up and receipts never trigger a model turn', async () => {
  const f = fixture(); await f.runtime.wake();
  assert.equal(f.calls.length, 1); const [message, options] = f.calls[0];
  assert.deepEqual(options, { triggerTurn: true, deliverAs: 'followUp' });
  assert.equal(message.customType, 'pi-messaging.peer.v1'); assert.equal(message.display, true);
  assert.ok(message.content.includes('Alice')); assert.ok(message.content.includes('peer text\\u001b'));
  assert.equal(message.content.includes('\x1b'), false);
  assert.equal(await f.runtime.receipt({ ...message, role: 'custom', details: { ...message.details, attemptId: randomUUID() } }), false);
  assert.equal(await f.runtime.receipt({ ...message, role: 'assistant' }), false);
  assert.equal(await f.runtime.receipt({ ...message, role: 'custom' }), true);
  assert.equal(await f.runtime.receipt({ ...message, role: 'custom' }), false);
  assert.equal(f.observed.length, 1); assert.equal(f.calls.length, 1);
  await f.runtime.stop();
});

test('leave during an asynchronous reservation never touches the replacement context or refunds', async () => {
  const f = fixture(); const waiting = deferred(); const started = deferred();
  f.backend.reserve = async () => { started.resolve(); return waiting.promise; };
  const pending = f.runtime.wake(); await started.promise;
  await f.runtime.stop(); waiting.resolve(f.r); await pending;
  assert.equal(f.calls.length, 0); assert.equal(f.observed.length, 0); assert.equal(f.errors.length, 0);
});

test('retry/compaction gaps defer admission; simultaneous notifications coalesce', async () => {
  const f = fixture(); let reserves = 0; const original = f.backend.reserve;
  f.backend.reserve = async () => { reserves++; return original(); };
  f.setReady(false); await f.runtime.wake(); assert.equal(reserves, 0);
  f.setReady(true); await Promise.all([f.runtime.wake(), f.runtime.wake(), f.runtime.wake()]);
  assert.equal(f.calls.length, 1); assert.ok(reserves <= 2);
  await f.runtime.stop();
});

test('work starting during reservation uses a quiet follow-up rather than steering or reserving twice', async () => {
  const f = fixture(); const waiting = deferred(); const started = deferred(); let reserves = 0;
  f.backend.reserve = async () => { reserves++; started.resolve(); return waiting.promise; };
  const pending = f.runtime.wake(); await started.promise;
  f.setReady(false); waiting.resolve(f.r); await pending;
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0][1], { triggerTurn: true, deliverAs: 'followUp' });
  await f.runtime.wake(); assert.equal(reserves, 1); assert.equal(f.observed.length, 0);
  await f.runtime.stop();
});

test('uncertain transport outcome stops automatic admissions and emits one diagnostic', async () => {
  const f = fixture(); let reserves = 0;
  f.backend.reserve = async () => { reserves++; throw new Error('uncertain reservation'); };
  await f.runtime.wake(); await f.runtime.wake(); await f.runtime.wake();
  assert.equal(reserves, 1); assert.equal(f.calls.length, 0); assert.equal(f.errors.length, 1);
  await f.runtime.stop();
});

test('matching synchronous receipt is accepted because correlation is installed before the Pi call', async () => {
  const f = fixture(); let receipt;
  const runtime = new MessagingRuntime(f.backend, f.group, { ready: () => true, status: () => {}, error: e => { throw Error(e); }, deliver: message => { receipt = runtime.receipt({ ...message, role: 'custom' }); } });
  await runtime.wake(); assert.equal(await receipt, true); assert.equal(f.observed.length, 1); await runtime.stop();
});
