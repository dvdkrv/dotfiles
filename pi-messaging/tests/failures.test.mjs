import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect as tcpConnect } from 'node:net';
import { once } from 'node:events';
import { connect } from '@nats-io/transport-node';
import { jetstreamManager, AckPolicy, DeliverPolicy } from '@nats-io/jetstream';
import { Kvm } from '@nats-io/kv';
import { createJiti } from 'jiti';
import { brokerFixture } from './helpers/broker.mjs';
const { connectBackend } = await createJiti(import.meta.url).import('../src/nats-backend.ts');
const consumerName = id => `peer_${id.replaceAll('-', '')}`;
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
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
  await f.a.arm(f.g, 2); await f.a.send({ toPeerId: receiver.peer.id, text: 'uncertain' }, 'lost-ack');
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
  await f.a.arm(f.g, 3);
  await Promise.all(Array.from({ length: 5 }, () => f.a.send(input, 'same')));
  await new Promise(r => setTimeout(r, 150)); // Deliberately exceed the broker deduplication window.
  await f.a.send(input, 'same');
  assert.equal((await f.jsm.streams.info('PM_MESSAGES')).state.messages, 1, 'expected-subject-sequence prevents duplicate publication');
  const r = await f.b.reserve(); await f.b.observe(r);
  const old = await f.jsm.consumers.info('PM_MESSAGES', consumerName(f.b.peer.id));
  await f.jsm.consumers.delete('PM_MESSAGES', old.name);
  await f.jsm.consumers.add('PM_MESSAGES', { durable_name: old.name, filter_subject: old.config.filter_subject, ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All, max_ack_pending: 8 });
  assert.deepEqual(await f.b.reserve(), []);
  assert.equal((await f.a.getGroupSummary(f.g)).used, 1);
  assert.ok((await f.jsm.consumers.info('PM_MESSAGES', old.name)).delivered.stream_seq > 0, 'broker really replayed the body');
});

test('a body published after the reservation high-water waits for the next batch', { timeout: 10000 }, async t => {
  const f = await fixture(t); if (!f) return;
  await f.a.arm(f.g, 1);
  const publicationStarted = deferred(); const releasePublication = deferred();
  const publish = f.a.js.publish.bind(f.a.js);
  f.a.js.publish = async (...args) => { publicationStarted.resolve(); await releasePublication.promise; return publish(...args); };
  const sending = f.a.send({ toPeerId: f.b.peer.id, text: 'after boundary' }, 'after-boundary');
  await publicationStarted.promise;
  const streamInfo = f.b.jsm.streams.info.bind(f.b.jsm.streams); let highWaterReads = 0;
  f.b.jsm.streams.info = async name => { if (name === 'PM_MESSAGES') highWaterReads++; return streamInfo(name); };
  const fetch = f.b.consumer.fetch.bind(f.b.consumer); const fetchStarted = deferred(); const releaseFetch = deferred();
  f.b.consumer.fetch = async options => {
    const messages = await fetch(options); const iterator = messages[Symbol.asyncIterator](); let first = true;
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          const pending = iterator.next();
          if (first) { first = false; fetchStarted.resolve(); await releaseFetch.promise; }
          return pending;
        },
        return: value => iterator.return?.(value),
      }),
      close: () => messages.close(),
    };
  };
  const reserving = f.b.reserve(); await fetchStarted.promise;
  releasePublication.resolve(); await sending; releaseFetch.resolve();
  assert.deepEqual(await reserving, []);
  assert.equal(highWaterReads, 1, 'reservation must capture one stream sequence boundary');
  const next = await f.b.reserve(); assert.equal(next.length, 1); assert.equal(next[0].envelope.text, 'after boundary');
});

test('a pre-boundary body without ledger metadata is acknowledged as stale', async t => {
  const f = await fixture(t); if (!f) return;
  await f.a.arm(f.g, 1);
  const message = await f.a.send({ toPeerId: f.b.peer.id, text: 'orphan' }, 'orphan');
  const { state, revision } = await f.b.snapshot(); delete state.messages[message.id];
  await f.b.kv.update('state', JSON.stringify(state), revision);
  assert.deepEqual(await f.b.reserve(), []);
  const info = await f.jsm.consumers.info('PM_MESSAGES', consumerName(f.b.peer.id));
  assert.ok(info.ack_floor.stream_seq > 0, 'stale body must not be NAKed forever');
});

test('a pause committed before the admission CAS prevents the whole batch', { timeout: 10000 }, async t => {
  const f = await fixture(t); if (!f) return;
  await f.a.arm(f.g, 1); await f.a.send({ toPeerId: f.b.peer.id, text: 'wait' }, 'paused');
  const snapshot = f.b.snapshot.bind(f.b); let reads = 0; let release; let blocked;
  const waiting = new Promise(resolve => { release = resolve; }); const reached = new Promise(resolve => { blocked = resolve; });
  f.b.snapshot = async () => { const value = await snapshot(); if (++reads === 2) { blocked(); await waiting; } return value; };
  const pulling = f.b.reserve(); await reached;
  await f.a.pause(f.g); release();
  assert.deepEqual(await pulling, []); assert.equal((await f.a.getGroupSummary(f.g)).used, 0);
  assert.equal((await f.a.listMessages(f.g))[0].state, 'queued');
});

test('leave during join invalidates the new identity before a consumer can activate', async t => {
  const f = await fixture(t); if (!f) return;
  await f.b.leave();
  const joining = f.b.join(f.g, { sessionId: 'late', displayName: 'Late' });
  await f.b.leave(); await assert.rejects(joining, /canceled/i);
  assert.equal(f.b.peer, undefined);
  assert.equal((await f.b.peers(f.g)).some(p => p.displayName === 'Late' && p.active), false);
  assert.equal((await f.jsm.streams.info('PM_MESSAGES')).state.consumer_count, 1);
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
  await f.a.arm(f.g, 2);
  const terminal = await f.a.send({ toPeerId: f.b.peer.id, text: 'old' }, 'old');
  await f.a.resolveMessage(f.g, terminal.id, 'canceled');
  const pending = await f.a.send({ toPeerId: f.b.peer.id, text: 'retain' }, 'pending');
  await f.a.leave();
  const kv = await new Kvm(f.nc).open('PM_CONTROL'); const entry = await kv.get('state'); const state = entry.json();
  state.messages[terminal.id].terminalAt = Date.now() - 8 * 86400000; await kv.update('state', JSON.stringify(state), entry.revision);
  await f.a.join(f.g, { sessionId: 'fresh', displayName: 'Fresh' });
  await f.b.send({ toPeerId: f.a.peer.id, text: 'new' }, 'maintenance');
  const all = await f.b.listMessages(f.g);
  assert.equal(all.some(m => m.id === terminal.id), false);
  assert.equal(all.some(m => m.id === pending.id), true);
  assert.equal((await f.b.getGroupSummary(f.g)).used, 0);
});
