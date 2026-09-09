import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createJiti } from 'jiti';
import { brokerFixture } from './helpers/broker.mjs';
const { connectBackend } = await createJiti(import.meta.url).import('../src/nats-backend.ts');
async function fixture(t) {
  const f = await brokerFixture(t); if (!f) return null;
  const a = await connectBackend(f.config, { initialize: true }); t.after(() => a.close());
  const b = await connectBackend(f.config); t.after(() => b.close());
  const g = await a.createGroup('testing');
  await a.join(g, { sessionId: 'a', displayName: 'Alice' }); await b.join(g, { sessionId: 'b', displayName: 'Bob' });
  return { ...f, a, b, g };
}

test('real queue: opt-in, shared allowance, exact envelope, idempotency and terminal recovery', async t => {
  const f = await fixture(t); if (!f) return;
  const { a, b, g } = f;
  const input = { toPeerId: b.peer.id, text: 'Hello Bob' };
  const m = await a.send(input, 'call-1');
  assert.equal((await a.send(input, 'call-1')).id, m.id);
  await assert.rejects(a.send({ ...input, text: 'changed' }, 'call-1'), /conflict/i);
  assert.equal(await b.reserve(), null);
  await a.arm(g, 2);
  const r = await b.reserve(); assert.equal(r.message.id, m.id); assert.equal(r.envelope.text, 'Hello Bob');
  assert.equal((await a.getGroupSummary(g)).used, 1);
  const second = await a.send(input, 'call-2');
  assert.equal(await b.reserve(), null);
  await b.observe(r); const r2 = await b.reserve(); assert.equal(r2.message.id, second.id);
  await a.resolveMessage(g, second.id, 'dismissed');
  await a.send(input, 'call-3'); assert.equal(await b.reserve(), null);
  assert.equal((await a.getGroupSummary(g)).mode, 'exhausted');
  await a.arm(g, 1); const r3 = await b.reserve(); assert.notEqual(r3.message.id, second.id);
  assert.equal((await a.listMessages(g)).length, 3);
});

test('role tool publishes self-name without rerouting queued work or inheriting an old session inbox', async t => {
  const f = await fixture(t); if (!f) return;
  const { registerMessaging } = await createJiti(import.meta.url).import('../extensions/messaging.ts');
  const commands = new Map(); const tools = new Map(); const events = new Map(); const delivered = [];
  const ctx = { mode: 'tui', isIdle: () => true,
    sessionManager: { getSessionFile: () => '/tmp/naming-session.jsonl', getSessionId: () => 'a' },
    ui: { confirm: async () => true, input: async () => { throw Error('No name input'); }, notify: () => {}, setStatus: () => {} } };
  registerMessaging({ on: (name, fn) => events.set(name, fn), registerCommand: (name, command) => commands.set(name, command),
    registerTool: tool => tools.set(tool.name, tool), registerMessageRenderer: () => {}, getActiveTools: () => ['peer_message'],
    sendMessage: (...args) => delivered.push(args) }, async () => f.a);
  t.after(() => events.get('session_shutdown')({}, ctx));
  await f.a.leave(); await commands.get('messages').handler('join testing', ctx);
  const oldId = f.a.peer.id;
  const before = await f.a.send({ toPeerId: f.b.peer.id, text: 'before rename' }, 'before');
  const incoming = await f.b.send({ toPeerId: oldId, text: 'old inbox' }, 'incoming');
  await tools.get('peer_message').execute('role', { action: 'rename', displayName: 'test-reviewer' }, undefined, undefined, ctx);
  const discovered = (await f.b.peers(f.g)).find(p => p.id === oldId);
  assert.equal(discovered.sessionId, 'a'); assert.equal(discovered.displayName, 'test-reviewer');
  assert.equal(f.a.peer.displayName, 'test-reviewer');
  const after = await f.a.send({ toPeerId: f.b.peer.id, text: 'after rename' }, 'after');
  assert.equal((await f.b.readBody(f.g, before.id)).senderName, 'a');
  assert.equal((await f.b.readBody(f.g, after.id)).senderName, 'test-reviewer');
  assert.equal(after.senderPeerId, before.senderPeerId);
  await commands.get('messages').handler('leave', ctx);
  await commands.get('messages').handler('join testing', ctx);
  assert.notEqual(f.a.peer.id, oldId); assert.equal(f.a.peer.sessionId, 'a'); assert.equal(f.a.peer.displayName, 'a');
  const oldInbox = (await f.a.listMessages(f.g)).find(m => m.id === incoming.id);
  assert.equal(oldInbox.recipientPeerId, oldId); assert.equal(oldInbox.state, 'queued');
  const summary = await f.a.getGroupSummary(f.g); assert.equal(summary.limit, 0); assert.equal(summary.used, 0);
  assert.equal(delivered.length, 0);
});

test('an overlapping unnamed heartbeat rebases rather than reverting a role rename', async t => {
  const f = await fixture(t); if (!f) return;
  let release; let started; const ready = new Promise(r => { started = r; });
  const barrier = new Promise(r => { release = r; }); t.after(() => release());
  const snapshot = f.a.snapshot.bind(f.a); let reads = 0;
  f.a.snapshot = async () => {
    const result = await snapshot();
    if (++reads === 1) { started(); await barrier; }
    return result;
  };
  const pending = f.a.heartbeat(); await ready;
  await f.a.heartbeat('test-reviewer');
  // Advance lastSeen past its previous millisecond, ensuring the stale write takes the CAS path.
  await new Promise(resolve => setTimeout(resolve, 2));
  release(); await pending;
  assert.ok(reads >= 3, 'The stale heartbeat must reread after a revision conflict');
  assert.equal(f.a.peer.displayName, 'test-reviewer');
  assert.equal((await f.b.peers(f.g)).find(p => p.id === f.a.peer.id).displayName, 'test-reviewer');
  await assert.rejects(f.a.heartbeat('\x1b[31minvalid'), /display name/i);
  assert.equal(f.a.peer.displayName, 'test-reviewer');
  assert.equal((await f.b.peers(f.g)).find(p => p.id === f.a.peer.id).displayName, 'test-reviewer');
});

test('concurrent sends preserve one identity and metadata reads cannot change allowance', async t => {
  const f = await fixture(t); if (!f) return;
  const { a, b, g } = f;
  const messages = await Promise.all(Array.from({ length: 8 }, () => a.send({ toPeerId: b.peer.id, text: 'once' }, 'same-call')));
  assert.equal(new Set(messages.map(m => m.id)).size, 1);
  await a.arm(g, 2); const r = await b.reserve(); await b.observe(r);
  assert.equal(await b.reserve(), null);
  assert.equal((await a.getGroupSummary(g)).used, 1);
  const before = (await a.listMessages(g)).length;
  await assert.rejects(a.getGroupSummary({ ...g, authorityId: randomUUID() }), /authority/i);
  assert.equal((await a.listMessages(g)).length, before);
});

test('hard broker restart preserves attempted records, budgets and old inboxes', async t => {
  const f = await fixture(t); if (!f) return;
  const { a, b, g } = f;
  await a.arm(g, 2); const m = await a.send({ toPeerId: b.peer.id, text: 'uncertain' }, 'c');
  await b.reserve(); await f.stop('SIGKILL'); await f.start();
  const c = await connectBackend(f.config); t.after(() => c.close());
  assert.equal((await c.getGroupSummary(g)).remaining, 1);
  assert.equal((await c.listMessages(g))[0].state, 'attempted');
  await c.join(g, { sessionId: 'b', displayName: 'Bob' });
  assert.notEqual(c.peer.id, b.peer.id); assert.equal(await c.reserve(), null);
  assert.equal((await c.readBody(g, m.id)).text, 'uncertain');
});

test('prune deletes only terminal inactive-sender records; pending and counters survive', async t => {
  const f = await fixture(t); if (!f) return;
  const { a, b, g } = f;
  const m = await a.send({ toPeerId: b.peer.id, text: 'terminal' }, 'one');
  const pending = await a.send({ toPeerId: b.peer.id, text: 'pending' }, 'two');
  await a.resolveMessage(g, m.id, 'canceled');
  assert.deepEqual(await a.prune(g), []);
  await a.leave(); assert.deepEqual(await b.prune(g), [m.id]);
  assert.deepEqual(await b.prune(g, true), [m.id]);
  assert.equal((await b.listMessages(g))[0].id, pending.id);
  assert.equal((await b.getGroupSummary(g)).limit, 0);
});

test('public reader exposes only summaries and never creates groups or grants allowance', async t => {
  const f = await fixture(t); if (!f) return;
  const { connectReader } = await createJiti(import.meta.url).import('../src/public.ts');
  const reader = await connectReader(f.config); t.after(() => reader.close());
  assert.deepEqual(Object.keys(reader).sort(), ['close', 'getGroupSummary']);
  assert.equal((await reader.getGroupSummary(f.g)).remaining, 0);
  assert.equal(await reader.getGroupSummary({ ...f.g, id: randomUUID() }), null);
  await assert.rejects(reader.getGroupSummary({ ...f.g, authorityId: randomUUID() }), /authority/i);
  assert.equal((await f.a.listGroups()).length, 1);
});

test('missing publication is inspectable without inventing a body or deleting the reservation', async t => {
  const f = await fixture(t); if (!f) return;
  const { connect } = await import('@nats-io/transport-node');
  const { jetstreamManager } = await import('@nats-io/jetstream');
  const nc = await connect({ servers: f.config.server, token: f.config.token }); t.after(() => nc.close());
  const m = await f.a.send({ toPeerId: f.b.peer.id, text: 'body' }, 'missing');
  await (await jetstreamManager(nc)).streams.purge('PM_MESSAGES', { filter: `pm.message.${f.g.id}.${f.b.peer.id}.${m.id}` });
  assert.equal(await f.a.readBody(f.g, m.id), null);
  assert.equal((await f.a.listMessages(f.g))[0].state, 'queued');
});

test('14 independent receiver processes admit exactly 12, not merely at most 12', { timeout: 60000 }, async t => {
  const f = await brokerFixture(t); if (!f) return;
  const sender = await connectBackend(f.config, { initialize: true }); t.after(() => sender.close());
  const g = await sender.createGroup('race'); await sender.join(g, { sessionId: 'sender', displayName: 'Sender' });
  const children = await Promise.all(Array.from({ length: 14 }, async (_, i) => {
    const child = fork(new URL('./helpers/contender.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const ready = once(child, 'message'); child.send({ config: f.config, g, i });
    const [peer] = await ready; assert.ok(peer.id, JSON.stringify(peer));
    await sender.send({ toPeerId: peer.id, text: 'one handoff' }, `race-${i}`);
    return child;
  }));
  await sender.arm(g, 12);
  const results = await Promise.all(children.map(async child => { const next = once(child, 'message'); child.send('reserve'); return (await next)[0]; }));
  assert.equal(results.filter(r => r.attemptId).length, 12);
  assert.equal(results.filter(r => r.error).length, 0, JSON.stringify(results));
  assert.equal((await sender.getGroupSummary(g)).used, 12);
  assert.equal((await sender.listMessages(g)).filter(m => m.state === 'queued').length, 2);
});
