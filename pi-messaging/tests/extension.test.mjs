import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { registerMessaging } = await jiti.import('../extensions/messaging.ts');
const p = await jiti.import('../src/policy.ts');
import { randomUUID } from 'node:crypto';

function fixture(t) {
  const state = p.newLedger(randomUUID()); const group = p.createGroup(state, 'review');
  const other = p.joinPeer(state, group, { sessionId: 'other', displayName: 'Other' });
  const events = new Map(); const commands = new Map(); const tools = new Map(); const renderers = new Map();
  const bodies = new Map();
  const delivered = []; const notices = []; const statuses = []; const confirmations = []; const connectCalls = [];
  let peer; let closed = false;
  const backend = {
    get peer() { return peer; }, get closed() { return closed; },
    listGroups: async () => Object.values(state.groups).map(p.refOf), createGroup: async label => p.createGroup(state, label),
    getGroupSummary: async g => p.summary(state, g), peers: async g => Object.values(state.peers).filter(x => x.groupId === g.id),
    join: async (g, info) => { peer = p.joinPeer(state, g, info); return peer; },
    leave: async () => { if (peer) p.leavePeer(state, peer.id); peer = undefined; }, close: async () => { closed = true; },
    heartbeat: async name => { if (peer) p.heartbeat(state, peer.id, name); }, onChange: () => () => {}, reserve: async () => null,
    arm: async (g, limit) => p.arm(state, g, limit), pause: async g => p.pause(state, g),
    send: async (input, key) => { const m = p.prepareMessage(state, peer.id, input, key); bodies.set(m.id, input.text); return m; },
    listMessages: async g => Object.values(state.messages).filter(m => m.groupId === g.id).sort((a, b) => b.sequence - a.sequence),
    readBody: async (_g, id) => p.envelope(state, state.messages[id], bodies.get(id)),
    resolveMessage: async (g, id, action) => p.resolveMessage(state, g, id, action),
    revoke: async (_g, id) => p.leavePeer(state, id),
    prune: async (g, execute) => { const ids = p.prunable(state, g, Infinity); if (execute) for (const id of ids) delete state.messages[id]; return ids; },
  };
  const pi = {
    on: (name, handler) => events.set(name, handler), registerCommand: (name, command) => commands.set(name, command),
    registerTool: tool => tools.set(tool.name, tool), registerMessageRenderer: (name, renderer) => renderers.set(name, renderer),
    sendMessage: (...args) => delivered.push(args), getSessionName: () => 'Local',
  };
  const ctx = { mode: 'tui', isIdle: () => true, sessionManager: { getSessionFile: () => '/tmp/session.jsonl', getSessionId: () => 'local', getSessionName: () => 'Local' },
    ui: { notify: (...args) => notices.push(args), setStatus: (...args) => statuses.push(args),
      confirm: async (...args) => { confirmations.push(args); return true; }, input: async () => 'Local', select: async (_, choices) => choices[0], editor: async () => 'human text' } };
  registerMessaging(pi, async () => { connectCalls.push(1); return backend; });
  t.after(async () => { await events.get('session_shutdown')?.({}, ctx); });
  return { state, group, other, backend, events, commands, tools, renderers, delivered, notices, statuses, confirmations, connectCalls, ctx };
}
async function execute(f, action, fields = {}) { return f.tools.get('peer_message').execute(randomUUID(), { action, ...fields }, undefined, undefined, f.ctx); }

test('factory/session_start are inert and non-TUI controls fail before connection', async t => {
  const f = fixture(t); assert.equal(f.connectCalls.length, 0);
  await f.events.get('session_start')({}, f.ctx); assert.equal(f.connectCalls.length, 0);
  for (const mode of ['rpc', 'json', 'print']) await assert.rejects(f.commands.get('messages').handler('join review', { ...f.ctx, mode }), /TUI/i);
  await assert.rejects(execute(f, 'send', { toPeerId: f.other.id, text: 'x' }), /join/i);
  assert.equal(f.connectCalls.length, 0);
});

test('human join and arm are explicit; agent cannot grant itself controls or read pending bodies', async t => {
  const f = fixture(t);
  await f.commands.get('messages').handler('join review', f.ctx);
  assert.equal(f.state.groups[f.group.id].limit, 0);
  await f.commands.get('messages').handler('arm 2', f.ctx);
  assert.equal(f.state.groups[f.group.id].limit, 2); assert.ok(f.confirmations.length >= 2);
  for (const action of ['join', 'arm', 'rearm', 'inbox']) await assert.rejects(execute(f, action), /action/i);
  const sent = await execute(f, 'send', { toPeerId: f.other.id, text: 'PRIVATE_BODY' });
  assert.ok(sent.content[0].text.includes('queued'));
  const status = await execute(f, 'status'); assert.equal(JSON.stringify(status).includes('PRIVATE_BODY'), false);
  assert.equal(f.delivered.length, 0);
  const peers = await execute(f, 'peers'); assert.ok(peers.content[0].text.includes(f.other.id));
});

test('tree navigation detaches and does not inherit membership or credits when joining again', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx);
  const oldId = f.backend.peer.id;
  await f.commands.get('messages').handler('arm 2', f.ctx);
  await f.events.get('session_before_tree')({}, f.ctx);
  assert.equal(f.backend.peer, undefined); assert.equal(f.state.peers[oldId].active, false);
  await assert.rejects(execute(f, 'status'), /join/i);
  assert.equal(f.state.groups[f.group.id].limit, 2);
});

test('an old selected group is never silently replaced by another group with the same label', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx);
  await f.commands.get('messages').handler('leave', f.ctx);
  f.state.groups = {}; f.state.peers = {}; p.createGroup(f.state, 'review');
  await assert.rejects(f.commands.get('messages').handler('status', f.ctx), /no longer|missing|not found/i);
});

test('leave during a status read returns a participation error rather than following the replacement peer', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx);
  let release; let started; const ready = new Promise(r => { started = r; });
  f.backend.listMessages = () => { started(); return new Promise(r => { release = r; }); };
  const pending = execute(f, 'status'); await ready;
  await f.commands.get('messages').handler('leave', f.ctx); release([]);
  await assert.rejects(pending, /participation|session changed/i);
});

test('blank display name follows session renames while explicit nicknames stay unchanged', async t => {
  const f = fixture(t); f.ctx.ui.input = async () => '';
  await f.commands.get('messages').handler('join review', f.ctx);
  assert.equal(f.backend.peer.displayName, 'Local');
  await f.events.get('session_info_changed')({ name: 'Renamed' }, f.ctx);
  assert.equal(f.backend.peer.displayName, 'Renamed');
  await f.commands.get('messages').handler('leave', f.ctx);
  f.ctx.ui.input = async () => 'Explicit';
  await f.commands.get('messages').handler('join review', f.ctx);
  await f.events.get('session_info_changed')({ name: 'Another name' }, f.ctx);
  assert.equal(f.backend.peer.displayName, 'Explicit');
});

test('human composition queues as the joined peer and inbox viewing/cancellation never enters model context', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx);
  await f.commands.get('messages').handler('send', f.ctx);
  const m = Object.values(f.state.messages)[0]; assert.equal(m.senderPeerId, f.backend.peer.id);
  const choices = ['message', 'View body', 'message', 'Cancel queued message', 'Close'];
  let views = 0;
  f.ctx.ui.select = async (_title, options) => { const choice = choices.shift(); return choice === 'message' ? options[0] : choice; };
  f.ctx.ui.editor = async (_title, text) => { assert.equal(text, 'human text'); views++; return 'must not be sent'; };
  await f.commands.get('messages').handler('inbox', f.ctx);
  assert.equal(views, 1); assert.equal(m.state, 'canceled'); assert.equal(f.delivered.length, 0);
  assert.equal(Object.keys(f.state.messages).length, 1);
});

test('human dismissal, revocation and pruning preserve spent allowance', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx);
  await f.commands.get('messages').handler('arm 2', f.ctx);
  const m = p.prepareMessage(f.state, f.other.id, { toPeerId: f.backend.peer.id, text: 'uncertain' }, 'other-send');
  p.admit(f.state, f.backend.peer.id, m.id);
  const choices = ['message', 'Dismiss uncertain attempt', 'Close'];
  f.ctx.ui.select = async (_title, options) => { const choice = choices.shift(); return choice === 'message' ? options[0] : choice; };
  await f.commands.get('messages').handler('inbox', f.ctx);
  assert.equal(m.state, 'dismissed');
  f.ctx.ui.select = async (_title, options) => options[0];
  await f.commands.get('messages').handler('revoke', f.ctx);
  assert.equal(f.state.peers[f.other.id].active, false);
  await f.commands.get('messages').handler('prune', f.ctx);
  assert.equal(Object.keys(f.state.messages).length, 0);
  assert.equal(f.state.groups[f.group.id].used, 1);
});

test('a late join dialog cannot mutate participation after tree navigation', async t => {
  const f = fixture(t); let release; let begun; const started = new Promise(r => { begun = r; });
  f.ctx.ui.input = async () => { begun(); return new Promise(r => { release = r; }); };
  const joining = f.commands.get('messages').handler('join review', f.ctx); await started;
  await f.events.get('session_before_tree')({}, f.ctx); release('Too late');
  await assert.rejects(joining, /session change/i);
  assert.equal(f.backend.peer, undefined); assert.equal(Object.keys(f.state.peers).length, 1);
});

test('canceled join confirmation makes no participation; renderer escapes terminal controls and wraps narrow widths', async t => {
  const f = fixture(t); f.ctx.ui.confirm = async () => false;
  await f.commands.get('messages').handler('join review', f.ctx); assert.equal(f.backend.peer, undefined);
  const render = f.renderers.get('pi-messaging.peer.v1');
  const component = render({ content: 'peer\x1b[31m'.repeat(8) }, {}, {});
  for (const width of [8, 20, 80]) {
    const lines = component.render(width); assert.ok(lines.length); assert.ok(lines.every(line => !line.includes('\x1b[31m')));
  }
});
