import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect as tcpConnect } from 'node:net';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { connect } from '@nats-io/transport-node';
import { jetstreamManager, AckPolicy, DeliverPolicy } from '@nats-io/jetstream';
import { Kvm } from '@nats-io/kv';
import { createJiti } from 'jiti';
import { brokerFixture } from './helpers/broker.mjs';
const { connectBackend } = await createJiti(import.meta.url).import('../src/nats-backend.ts');
const consumerName = id => `peer_${id.replaceAll('-', '')}`;
async function fixture(t) {
  const f = await brokerFixture(t); if (!f) return null;
  const a = await connectBackend(f.config, { initialize: true }); t.after(() => a.close());
  const b = await connectBackend(f.config); t.after(() => b.close());
  const g = await a.createGroup('faults'); await a.join(g, { sessionId: 'a', displayName: 'Alice' }); await b.join(g, { sessionId: 'b', displayName: 'Bob' });
  const nc = await connect({ servers: f.config.server, token: f.config.token }); t.after(() => nc.close());
  return { ...f, a, b, g, nc, jsm: await jetstreamManager(nc) };
}

test('lost CAS acknowledgment consumes credit but returns no reservation or automatic refund', { timeout: 15000 }, async t => {
  const f = await fixture(t); if (!f) return;
  let drop = false; let dropped = false; const sockets = new Set();
  const proxy = createServer(client => {
    const upstream = tcpConnect({ host: '127.0.0.1', port: Number(new URL(f.config.server).port) });
    sockets.add(client); sockets.add(upstream);
    client.on('error', () => {}); upstream.on('error', () => {});
    client.pipe(upstream);
    upstream.on('data', chunk => {
      if (drop && /"stream"\s*:\s*"KV_PM_CONTROL"/.test(chunk.toString())) {
        dropped = true; drop = false; client.destroy(); upstream.destroy();
      } else client.write(chunk);
    });
    client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(r => proxy.close(r)); });
  const receiver = await connectBackend({ ...f.config, server: `nats://127.0.0.1:${proxy.address().port}` }); t.after(() => receiver.close());
  await receiver.join(f.g, { sessionId: 'proxied', displayName: 'Proxied' });
  await f.a.send({ toPeerId: receiver.peer.id, text: 'uncertain' }, 'lost-ack'); await f.a.arm(f.g, 2);
  drop = true;
  await assert.rejects(receiver.reserve(), /uncertain/i); assert.equal(dropped, true);
  assert.equal((await f.a.getGroupSummary(f.g)).used, 1);
  assert.equal((await f.a.listMessages(f.g))[0].state, 'attempted');
  await assert.rejects(receiver.reserve(), /unavailable|join/i);
  assert.equal((await f.a.getGroupSummary(f.g)).used, 1);
});

test('broker replay of an observed message is consumed without a second Pi reservation', async t => {
  const f = await fixture(t); if (!f) return;
  const input = { toPeerId: f.b.peer.id, text: 'once' };
  await f.jsm.streams.update('PM_MESSAGES', { duplicate_window: 100_000_000 });
  await Promise.all(Array.from({ length: 5 }, () => f.a.send(input, 'same')));
  await new Promise(r => setTimeout(r, 150)); // Deliberately exceed the broker deduplication window.
  await f.a.send(input, 'same');
  assert.equal((await f.jsm.streams.info('PM_MESSAGES')).state.messages, 1, 'expected-subject-sequence prevents duplicate publication');
  await f.a.arm(f.g, 3); const r = await f.b.reserve(); await f.b.observe(r);
  const old = await f.jsm.consumers.info('PM_MESSAGES', consumerName(f.b.peer.id));
  await f.jsm.consumers.delete('PM_MESSAGES', old.name);
  await f.jsm.consumers.add('PM_MESSAGES', { durable_name: old.name, filter_subject: old.config.filter_subject, ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All, max_ack_pending: 1 });
  assert.equal(await f.b.reserve(), null);
  assert.equal((await f.a.getGroupSummary(f.g)).used, 1);
  assert.ok((await f.jsm.consumers.info('PM_MESSAGES', old.name)).delivered.stream_seq > 0, 'broker really replayed the body');
});

test('a pause committed while a pull is waiting prevents admission', { timeout: 10000 }, async t => {
  const f = await fixture(t); if (!f) return;
  await f.a.arm(f.g, 1); const pulling = f.b.reserve();
  const deadline = Date.now() + 3000;
  while ((await f.jsm.consumers.info('PM_MESSAGES', consumerName(f.b.peer.id))).num_waiting === 0) {
    if (Date.now() > deadline) throw Error('Pull request never started');
    await new Promise(r => setTimeout(r, 10));
  }
  await f.a.pause(f.g); await f.a.send({ toPeerId: f.b.peer.id, text: 'wait' }, 'paused');
  assert.equal(await pulling, null); assert.equal((await f.a.getGroupSummary(f.g)).used, 0);
  assert.equal((await f.a.listMessages(f.g))[0].state, 'queued');
});

test('departure during join suspends the new identity before a consumer can activate', async t => {
  const f = await fixture(t); if (!f) return;
  await f.b.leave();
  const joining = f.b.join(f.g, { sessionId: 'late', displayName: 'Late' });
  await f.b.leave(); await assert.rejects(joining, /canceled/i);
  assert.equal(f.b.peer, undefined);
  const late = (await f.b.peers(f.g)).find(peer => peer.displayName === 'Late');
  assert.equal(late.active, true); assert.equal(late.suspended, true);
  assert.equal((await f.jsm.streams.info('PM_MESSAGES')).state.consumer_count, 1);
});

test('rotated lease fences every old backend operation without deactivating the resumed peer', async t => {
  const f = await fixture(t); if (!f) return;
  const oldId = f.b.peer.id;
  const message = await f.a.send({ toPeerId: oldId, text: 'attempted before resume' }, 'before-resume');
  await f.a.arm(f.g, 2); const reservation = await f.b.reserve(); assert.equal(reservation.message.id, message.id);
  const kv = await new Kvm(f.nc).open('PM_CONTROL'); const entry = await kv.get('state'); const state = entry.json();
  state.peers[oldId].lastSeen = Date.now() - 31_000; await kv.update('state', JSON.stringify(state), entry.revision);
  const resumed = await connectBackend(f.config); t.after(() => resumed.close()); await resumed.resume(f.g, oldId, 'b');
  await assert.rejects(f.b.heartbeat(), /lease|current|resume/i);
  await assert.rejects(f.b.send({ toPeerId: f.a.peer.id, text: 'must not send' }, 'old-send'), /lease|current|resume/i);
  await assert.rejects(f.b.reserve(), /lease|current|resume/i);
  await assert.rejects(f.b.observe(reservation), /lease|current|resume/i);
  await assert.rejects(f.b.leave(), /lease|current|resume/i);
  await resumed.heartbeat();
  const peer = (await f.a.peers(f.g)).find(item => item.id === oldId);
  assert.equal(peer.active, true); assert.equal(peer.suspended, false);
  assert.equal((await f.a.listMessages(f.g)).some(item => item.requestKey === 'old-send'), false);
  assert.equal((await f.a.getGroupSummary(f.g)).used, 1);
});

test('a separately running old owner is fenced from every participant mutation after resume', { timeout: 15000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const old = { ...f.b.peer }; await f.b.suspend();
  const child = fork(new URL('./helpers/lease-contender.mjs', import.meta.url), { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => { if (child.connected) child.send({ action: 'close' }); child.kill(); });
  const request = async message => { child.send(message); const [response] = await once(child, 'message'); return response; };
  assert.equal((await request({ action: 'init', config: f.config, group: f.g, peerId: old.id, sessionId: 'b' })).ok, true);
  await f.a.arm(f.g, 1); const message = await f.a.send({ toPeerId: old.id, text: 'old process attempt' }, 'old-process-attempt');
  assert.deepEqual(await request({ action: 'reserve' }), { ok: true, messageId: message.id });
  const kv = await new Kvm(f.nc).open('PM_CONTROL'); const entry = await kv.get('state'); const state = entry.json();
  state.peers[old.id].lastSeen = Date.now() - 31_000; await kv.update('state', JSON.stringify(state), entry.revision);
  const winner = await connectBackend(f.config); t.after(() => winner.close()); await winner.resume(f.g, old.id, 'b');
  for (const action of ['heartbeat', 'rename', 'send', 'reserve', 'observe', 'suspend', 'leave']) {
    const result = await request({ action, toPeerId: f.a.peer.id });
    assert.equal(result.ok, false, `${action} unexpectedly succeeded`); assert.equal(result.code, 'participation');
  }
  const peer = (await f.a.peers(f.g)).find(candidate => candidate.id === old.id);
  assert.equal(peer.active, true); assert.equal(peer.suspended, false); assert.equal(peer.displayName, old.displayName);
  assert.equal((await f.a.listMessages(f.g)).length, 1); assert.equal((await f.a.getGroupSummary(f.g)).used, 1);
});

test('held pull with an old lease is not admitted and redelivers to the resumed owner', { timeout: 15000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const oldId = f.b.peer.id; await f.a.arm(f.g, 2);
  const originalSnapshot = f.b.snapshot.bind(f.b); let reads = 0; let release;
  const blocked = new Promise(resolve => { release = resolve; }); let reached;
  const atAdmission = new Promise(resolve => { reached = resolve; });
  f.b.snapshot = async () => {
    const snapshot = await originalSnapshot();
    if (++reads === 2) { reached(); await blocked; }
    return snapshot;
  };
  const pulling = f.b.reserve();
  const deadline = Date.now() + 3000;
  while ((await f.jsm.consumers.info('PM_MESSAGES', consumerName(oldId))).num_waiting === 0) {
    if (Date.now() > deadline) throw new Error('old pull did not start');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const message = await f.a.send({ toPeerId: oldId, text: 'lease race' }, 'lease-race'); await atAdmission;
  const kv = await new Kvm(f.nc).open('PM_CONTROL'); const entry = await kv.get('state'); const state = entry.json();
  state.peers[oldId].lastSeen = Date.now() - 31_000; await kv.update('state', JSON.stringify(state), entry.revision);
  const resumed = await connectBackend(f.config); t.after(() => resumed.close()); await resumed.resume(f.g, oldId, 'b');
  release(); await assert.rejects(pulling, /lease|current|resume/i); await f.b.close();
  let reservation; const redeliveryDeadline = Date.now() + 7000;
  while (!reservation && Date.now() < redeliveryDeadline) reservation = await resumed.reserve();
  assert.equal(reservation.message.id, message.id); assert.equal((await resumed.getGroupSummary(f.g)).used, 1);
});

test('prune reclaims a durable consumer orphaned after leave metadata committed', async t => {
  const f = await fixture(t); if (!f) return;
  const kv = await new Kvm(f.nc).open('PM_CONTROL'); const entry = await kv.get('state'); const state = entry.json();
  state.peers[f.b.peer.id].active = false; await kv.update('state', JSON.stringify(state), entry.revision);
  assert.equal((await f.jsm.streams.info('PM_MESSAGES')).state.consumer_count, 2);
  await f.a.prune(f.g, true);
  assert.equal((await f.jsm.streams.info('PM_MESSAGES')).state.consumer_count, 1);
});

test('send maintenance removes old terminal inactive-sender history without removing pending work or credits', async t => {
  const f = await fixture(t); if (!f) return;
  const terminal = await f.a.send({ toPeerId: f.b.peer.id, text: 'old' }, 'old');
  const pending = await f.a.send({ toPeerId: f.b.peer.id, text: 'retain' }, 'pending');
  await f.a.resolveMessage(f.g, terminal.id, 'canceled'); await f.a.leave();
  const kv = await new Kvm(f.nc).open('PM_CONTROL'); const entry = await kv.get('state'); const state = entry.json();
  state.messages[terminal.id].terminalAt = Date.now() - 8 * 86400000; await kv.update('state', JSON.stringify(state), entry.revision);
  await f.a.join(f.g, { sessionId: 'fresh', displayName: 'Fresh' });
  await f.b.send({ toPeerId: f.a.peer.id, text: 'new' }, 'maintenance');
  const all = await f.b.listMessages(f.g);
  assert.equal(all.some(m => m.id === terminal.id), false);
  assert.equal(all.some(m => m.id === pending.id), true);
  assert.equal((await f.b.getGroupSummary(f.g)).used, 0);
});
