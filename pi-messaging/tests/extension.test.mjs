import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { registerMessaging } = await jiti.import('../extensions/messaging.ts');
const p = await jiti.import('../src/policy.ts');
const { NAMING_GUIDANCE, QUIET_GUIDANCE } = await jiti.import('../src/identity.ts');
import { randomUUID } from 'node:crypto';
import { CombinedAutocompleteProvider } from '@earendil-works/pi-tui';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createAssistantMessageEventStream, validateToolArguments } from '@earendil-works/pi-ai';
const sdkEntry = process.env.PI_MESSAGING_PI_SDK ? pathToFileURL(process.env.PI_MESSAGING_PI_SDK).href : import.meta.resolve('@earendil-works/pi-coding-agent');
const sdkRequire = createRequire(sdkEntry); const corePackage = '@earendil-works/pi-agent-core/package.json';
const { Agent } = await import(new URL(sdkRequire(corePackage).main, pathToFileURL(sdkRequire.resolve(corePackage))).href);
const { wrapToolDefinition } = await import(new URL('./core/tools/tool-definition-wrapper.js', sdkEntry).href);

function fixture(t, options = {}) {
  const state = p.newLedger(randomUUID()); const group = p.createGroup(state, 'review');
  const other = p.joinPeer(state, group, { sessionId: 'other', displayName: 'Other' });
  const events = new Map(); const commands = new Map(); const tools = new Map(); const renderers = new Map();
  const bodies = new Map(); const activeTools = ['peer_message'];
  const delivered = []; const notices = []; const statuses = []; const confirmations = []; const connectCalls = []; const ensureCalls = [];
  let ensureError = options.ensureError; let participant; let closed = false;
  const currentLease = () => ({ peerId: participant.id, leaseId: participant.leaseId });
  const backend = {
    get peer() { if (!participant) return undefined; const { leaseId: _leaseId, ...peer } = participant; return peer; }, get closed() { return closed; },
    listGroups: async () => Object.values(state.groups).map(p.refOf), createGroup: async label => p.createGroup(state, label),
    getGroupSummary: async g => p.summary(state, g), peers: async g => Object.values(state.peers).filter(x => x.groupId === g.id),
    join: async (g, info) => { participant = p.joinPeer(state, g, info); return backend.peer; },
    leave: async () => { if (participant) p.leavePeer(state, currentLease()); participant = undefined; }, close: async () => { closed = true; },
    heartbeat: async name => { if (participant) p.heartbeat(state, currentLease(), name); }, onChange: () => () => {}, reserve: async () => null,
    arm: async (g, limit) => p.arm(state, g, limit), pause: async g => p.pause(state, g),
    send: async (input, key) => { const m = p.prepareMessage(state, currentLease(), input, key); bodies.set(m.id, input.text); return m; },
    listMessages: async g => Object.values(state.messages).filter(m => m.groupId === g.id).sort((a, b) => b.sequence - a.sequence),
    readBody: async (_g, id) => p.envelope(state, state.messages[id], bodies.get(id)),
    resolveMessage: async (g, id, action) => p.resolveMessage(state, g, id, action),
    revoke: async (g, id) => p.revokePeer(state, g, id),
    prune: async (g, execute) => { const ids = p.prunable(state, g, Infinity); if (execute) for (const id of ids) delete state.messages[id]; return ids; },
  };
  const pi = {
    on: (name, handler) => events.set(name, handler), registerCommand: (name, command) => commands.set(name, command),
    registerTool: tool => tools.set(tool.name, tool), registerMessageRenderer: (name, renderer) => renderers.set(name, renderer),
    sendMessage: (...args) => delivered.push(args), getSessionName: () => 'Local', getActiveTools: () => activeTools,
  };
  const ctx = { mode: 'tui', hasUI: true, isIdle: () => true, sessionManager: { getSessionFile: () => '/tmp/session.jsonl', getSessionId: () => 'local', getSessionName: () => 'Local' },
    ui: { notify: (...args) => notices.push(args), setStatus: (...args) => statuses.push(args),
      confirm: async (...args) => { confirmations.push(args); return true; }, input: async () => 'Local', select: async (_, choices) => choices[0], editor: async () => 'human text' } };
  registerMessaging(pi, async () => { connectCalls.push(1); return backend; }, async () => { ensureCalls.push(1); if (ensureError) throw ensureError; });
  t.after(async () => { await events.get('session_shutdown')?.({}, ctx); });
  return { state, group, other, backend, currentLease, events, commands, tools, renderers, delivered, notices, statuses, confirmations, connectCalls, ensureCalls, activeTools, ctx, pi,
    succeedEnsure: () => { ensureError = undefined; } };
}
async function execute(f, action, fields = {}) { return f.tools.get('peer_message').execute(randomUUID(), { action, ...fields }, undefined, undefined, f.ctx); }

test('native slash completion lists subcommands with hints and replaces the full argument prefix', async t => {
  const f = fixture(t); const command = f.commands.get('messages');
  assert.equal(typeof command.getArgumentCompletions, 'function');
  const provider = new CombinedAutocompleteProvider([{ name: 'messages', ...command }], '/tmp');
  const options = { signal: new AbortController().signal };
  const menu = await provider.getSuggestions(['/messages '], 0, '/messages '.length, options);
  assert.deepEqual(menu.items.map(i => i.value.trim()).sort(), ['arm', 'inbox', 'join', 'leave', 'pause', 'prune', 'revoke', 'send', 'status']);
  assert.ok(menu.items.every(i => i.description));
  assert.match(menu.items.find(i => i.value.trim() === 'join').label, /group/i);
  assert.match(menu.items.find(i => i.value.trim() === 'arm').label, /1.*100/);
  const typed = '/messages jo';
  const suggestions = await provider.getSuggestions([typed], 0, typed.length, options);
  assert.equal(suggestions.items.length, 1);
  const completed = provider.applyCompletion([typed], 0, typed.length, suggestions.items[0], suggestions.prefix);
  assert.deepEqual(completed.lines, ['/messages join ']);
  assert.equal(f.connectCalls.length, 0); assert.equal(f.confirmations.length, 0); assert.equal(f.delivered.length, 0);
});

test('allowance completion supplies hints without arming and never suggests invalid arguments', async t => {
  const f = fixture(t); const complete = f.commands.get('messages').getArgumentCompletions;
  assert.equal(typeof complete, 'function');
  const choices = complete('arm ');
  assert.ok(choices.some(i => i.value === 'arm 2'));
  assert.ok(choices.some(i => i.value === 'arm 12' && /default/i.test(i.description)));
  assert.deepEqual(complete('arm 37').map(i => i.value), ['arm 37']);
  for (const prefix of ['arm 0', 'arm 101', 'arm -1', 'arm 2 extra', 'pause extra', 'unknown']) assert.equal(complete(prefix), null);
  const provider = new CombinedAutocompleteProvider([{ name: 'messages', ...f.commands.get('messages') }], '/tmp');
  const typed = '/messages arm 2';
  const suggestions = await provider.getSuggestions([typed], 0, typed.length, { signal: new AbortController().signal });
  assert.deepEqual(provider.applyCompletion([typed], 0, typed.length, suggestions.items[0], suggestions.prefix).lines, ['/messages arm 2']);
  assert.equal(f.state.groups[f.group.id].limit, 0); assert.equal(f.confirmations.length, 0); assert.equal(f.connectCalls.length, 0);
});

test('join completion uses groups learned by human commands without broker reads while typing', async t => {
  const f = fixture(t); const complete = f.commands.get('messages').getArgumentCompletions;
  assert.equal(typeof complete, 'function'); assert.equal(complete('join re'), null);
  p.createGroup(f.state, 'release');
  await f.commands.get('messages').handler('status', f.ctx);
  f.backend.listGroups = async () => { throw Error('Completion must not read the broker'); };
  assert.deepEqual(complete('join re').map(i => i.value), ['join release', 'join review']);
  assert.equal(f.backend.peer, undefined); assert.equal(f.state.groups[f.group.id].limit, 0);
  await f.events.get('session_shutdown')({}, f.ctx);
  assert.equal(complete('join re'), null);
});

test('newly created groups become completable without retaining them across reload', async t => {
  const f = fixture(t); const complete = f.commands.get('messages').getArgumentCompletions;
  assert.equal(typeof complete, 'function');
  await f.commands.get('messages').handler('join new-group', f.ctx);
  assert.deepEqual(complete('join new').map(i => i.value), ['join new-group']);
  await f.events.get('session_start')({}, f.ctx);
  assert.equal(complete('join new'), null);
});

test('session start ensures infrastructure without joining, allowance, or delivery', async t => {
  const f = fixture(t); assert.equal(f.connectCalls.length, 0); assert.equal(f.ensureCalls.length, 0);
  await f.events.get('session_start')({ reason: 'startup' }, f.ctx);
  assert.equal(f.ensureCalls.length, 1); assert.equal(f.connectCalls.length, 0);
  assert.equal(f.backend.peer, undefined); assert.equal(f.state.groups[f.group.id].limit, 0); assert.equal(f.delivered.length, 0);
  for (const mode of ['rpc', 'json', 'print']) await assert.rejects(f.commands.get('messages').handler('join review', { ...f.ctx, mode }), /TUI/i);
  await assert.rejects(execute(f, 'send', { toPeerId: f.other.id, text: 'x' }), /join/i);
  assert.equal(f.connectCalls.length, 0); assert.equal(f.ensureCalls.length, 1);
});

test('startup failure warns outside model context and a messages command retries readiness', async t => {
  const f = fixture(t, { ensureError: new Error('nats-server missing') });
  await f.events.get('session_start')({ reason: 'startup' }, f.ctx);
  assert.equal(f.ensureCalls.length, 1); assert.match(f.notices.at(-1)[0], /nats-server missing/i);
  assert.equal(f.delivered.length, 0); assert.equal(f.connectCalls.length, 0);
  f.succeedEnsure();
  await f.commands.get('messages').handler('status', f.ctx);
  assert.equal(f.ensureCalls.length, 2); assert.equal(f.connectCalls.length, 1);
  assert.equal(f.delivered.length, 0);
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

test('session-ID defaults require no naming dialog and are independent of session titles', async t => {
  const f = fixture(t); const sessionId = 'a31b7c92-1111-4444-8888-123456789abc';
  f.ctx.sessionManager.getSessionId = () => sessionId;
  f.ctx.ui.input = async () => { throw Error('No name input expected'); };
  await f.commands.get('messages').handler('join review', f.ctx);
  assert.equal(f.backend.peer.displayName, sessionId);
  assert.equal(f.backend.peer.sessionId, sessionId);
  assert.ok(f.confirmations.some(([, text]) => text.includes(sessionId)));
  await f.events.get('session_info_changed')?.({ name: 'Renamed title' }, f.ctx);
  assert.equal(f.backend.peer.displayName, sessionId);
  assert.equal(f.state.groups[f.group.id].limit, 0); assert.equal(f.delivered.length, 0);
});

test('peer selection shows role and session ID without conflating identical labels', async t => {
  const f = fixture(t);
  const sessionId = 'f82e409a-1111-4444-8888-123456789abc';
  f.other.displayName = 'test-reviewer'; f.other.sessionId = sessionId;
  const second = p.joinPeer(f.state, f.group, { sessionId, displayName: 'test-reviewer' });
  await f.commands.get('messages').handler('join review', f.ctx);
  f.ctx.ui.select = async (title, choices) => {
    assert.equal(title, 'Send to peer'); assert.equal(choices.length, 2);
    assert.ok(choices.every(c => c.includes('test-reviewer') && c.includes('f82e409a')));
    assert.notEqual(choices[0], choices[1]); return choices[1];
  };
  await f.commands.get('messages').handler('send', f.ctx);
  assert.equal(Object.values(f.state.messages)[0].recipientPeerId, second.id);
});

test('role rename changes only self while discovery retains session and routing IDs', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx);
  const before = { ...f.backend.peer }; const groupBefore = { ...f.state.groups[f.group.id] };
  const queued = p.prepareMessage(f.state, { peerId: f.other.id, leaseId: f.other.leaseId }, { toPeerId: before.id, text: 'PRIVATE_BODY' }, 'incoming');
  const result = JSON.parse((await execute(f, 'rename', { displayName: '  test-reviewer  ' })).content[0].text);
  assert.deepEqual(result, { id: before.id, sessionId: 'local', displayName: 'test-reviewer' });
  assert.equal(f.backend.peer.displayName, 'test-reviewer'); assert.equal(f.other.displayName, 'Other');
  await f.events.get('session_info_changed')?.({ name: 'Unrelated title' }, f.ctx);
  assert.equal(f.backend.peer.displayName, 'test-reviewer');
  assert.equal(queued.recipientPeerId, before.id); assert.equal(queued.state, 'queued');
  assert.deepEqual(f.state.groups[f.group.id], groupBefore);
  const discovery = JSON.parse((await execute(f, 'peers')).content[0].text);
  assert.equal(discovery.selfId, before.id); assert.equal(discovery.selfSessionId, 'local');
  assert.deepEqual(discovery.peers.find(p => p.id === before.id), { id: before.id, sessionId: 'local', displayName: 'test-reviewer', presence: 'online' });
  assert.equal(discovery.peers.find(p => p.id === f.other.id).sessionId, 'other');
  assert.equal(JSON.stringify(discovery).includes('PRIVATE_BODY'), false); assert.equal(f.delivered.length, 0);
  await f.commands.get('messages').handler('leave', f.ctx);
  await f.commands.get('messages').handler('join review', f.ctx);
  assert.notEqual(f.backend.peer.id, before.id); assert.equal(f.backend.peer.sessionId, before.sessionId);
  assert.equal(f.backend.peer.displayName, 'local'); assert.equal(queued.recipientPeerId, before.id);
});

test('rename rejects administrative targets, invalid names, and unjoined or non-TUI callers', async t => {
  const f = fixture(t);
  await assert.rejects(execute(f, 'rename', { displayName: 'reviewer' }), /join/i);
  assert.equal(f.connectCalls.length, 0);
  await f.commands.get('messages').handler('join review', f.ctx);
  for (const displayName of [undefined, 123, '', ' ', 'x'.repeat(65), 'review\nlead', '\x1b[31mreview', '\u202elead']) {
    await assert.rejects(execute(f, 'rename', { displayName }), /display.?name|rename/i);
  }
  for (const fields of [{ toPeerId: f.other.id }, { text: 'unused' }, { inReplyTo: randomUUID() }]) {
    await assert.rejects(execute(f, 'rename', { displayName: 'reviewer', ...fields }), /rename|only/i);
  }
  for (const mode of ['rpc', 'json', 'print']) {
    await assert.rejects(f.tools.get('peer_message').execute('rename', { action: 'rename', displayName: 'reviewer' }, undefined, undefined, { ...f.ctx, mode }), /TUI/i);
  }
  assert.equal(f.backend.peer.displayName, 'local'); assert.equal(f.other.displayName, 'Other');
  await execute(f, 'rename', { displayName: '🧪'.repeat(64) });
  assert.equal(f.backend.peer.displayName, '🧪'.repeat(64));
});

test('real Pi argument pipeline accepts captured-style padding without changing input or sending extra work', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx);
  const tool = f.tools.get('peer_message');
  const calls = [
    { action: 'peers', displayName: 'test-crawler', toPeerId: '', text: '', inReplyTo: '', beforeSequence: 1 },
    { action: 'rename', displayName: 'test-crawler', toPeerId: '', text: '', inReplyTo: '', beforeSequence: 1 },
    { action: 'send', displayName: 'not-a-rename', toPeerId: f.other.id, text: '  exact body\n', inReplyTo: '', beforeSequence: 1 },
    { action: 'send', displayName: null, toPeerId: f.other.id, text: 'second body', inReplyTo: null, beforeSequence: null },
    { action: 'rename', displayName: null },
    { action: 'send', toPeerId: f.other.id, text: null },
  ];
  const original = structuredClone(calls); let requests = 0;
  const agent = new Agent({
    initialState: { model: { id: 'scripted', name: 'Scripted regression', provider: 'test', api: 'openai-responses', baseUrl: 'https://invalid.example',
      reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      tools: [wrapToolDefinition(tool, () => f.ctx)] },
    streamFn: () => {
      assert.ok(requests <= calls.length, 'Scripted provider must stay bounded');
      const args = calls[requests++];
      const message = { role: 'assistant', api: 'openai-responses', provider: 'test', model: 'scripted', timestamp: 1,
        content: args ? [{ type: 'toolCall', id: `call-${requests}`, name: 'peer_message', arguments: args }] : [{ type: 'text', text: 'done' }],
        stopReason: args ? 'toolUse' : 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: message.stopReason, message }); return stream;
    },
  });
  t.after(() => agent.abort()); await agent.prompt('Exercise the isolated messaging fixture');
  const results = agent.state.messages.filter(m => m.role === 'toolResult');
  assert.equal(results.length, 6);
  const listed = JSON.parse(results[0].content[0].text);
  assert.equal(listed.peers.find(peer => peer.id === listed.selfId).displayName, 'local');
  assert.ok(results.slice(0, 4).every(m => !m.isError), JSON.stringify(results.map(m => m.content)));
  assert.ok(results.slice(4).every(m => m.isError), 'Required nulls must not be coerced into a literal name/body "null"');
  assert.deepEqual(calls, original); assert.equal(f.backend.peer.displayName, 'test-crawler'); assert.equal(f.other.displayName, 'Other');
  const messages = Object.values(f.state.messages);
  assert.equal(messages.length, 2); assert.ok(messages.every(m => m.recipientPeerId === f.other.id && m.inReplyTo === undefined));
  assert.equal((await f.backend.readBody(f.group, messages[0].id)).text, '  exact body\n');
  assert.equal(f.state.groups[f.group.id].used, 0); assert.equal(f.delivered.length, 0); assert.equal(requests, 7);
});

test('direct execution normalizes neutral padding but preserves real reply references and status cursors', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx);
  for (const empty of ['', null, undefined]) {
    await execute(f, 'rename', { displayName: 'test-reviewer', toPeerId: empty, text: empty, inReplyTo: empty, beforeSequence: 1 });
  }
  const first = JSON.parse((await execute(f, 'send', { toPeerId: f.other.id, text: 'one', inReplyTo: '' })).content[0].text);
  await execute(f, 'send', { toPeerId: f.other.id, text: 'reply', inReplyTo: first.id });
  assert.equal(Object.values(f.state.messages)[1].inReplyTo, first.id);
  const tool = f.tools.get('peer_message'); assert.equal(typeof tool.prepareArguments, 'function');
  const statusArgs = tool.prepareArguments({ action: 'status', displayName: '', toPeerId: '', text: '', inReplyTo: '', beforeSequence: 1 });
  assert.equal(statusArgs.beforeSequence, 1);
  const status = JSON.parse((await tool.execute('status', statusArgs, undefined, undefined, f.ctx)).content[0].text);
  assert.equal(status.outgoing.length, 0);
  const firstPage = tool.prepareArguments({ action: 'status', beforeSequence: null });
  assert.equal(JSON.parse((await tool.execute('status', firstPage, undefined, undefined, f.ctx)).content[0].text).outgoing.length, 2);
  assert.throws(() => validateToolArguments(tool, { name: 'peer_message', arguments: tool.prepareArguments({ action: 'status', beforeSequence: 0 }) }), /beforeSequence|minimum/i);
  assert.throws(() => validateToolArguments(tool, { name: 'peer_message', arguments: tool.prepareArguments({ action: 'peers', unexpected: null }) }), /unexpected|additional/i);
  for (const input of [null, undefined, [], 1, 'peers']) {
    assert.throws(() => validateToolArguments(tool, { name: 'peer_message', arguments: tool.prepareArguments(input) }));
  }
});

test('padding compatibility cannot discard meaningful rename targets, malformed IDs, or required values', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx);
  for (const input of [
    { action: 'rename', displayName: 'other-role', toPeerId: f.other.id, beforeSequence: 1 },
    { action: 'rename', displayName: 'other-role', text: 'not harmless padding' },
    { action: 'rename', displayName: '' }, { action: 'rename', displayName: null },
    { action: 'send', toPeerId: '', text: 'body' }, { action: 'send', toPeerId: null, text: 'body' },
    { action: 'send', toPeerId: f.other.id, text: '' }, { action: 'send', toPeerId: f.other.id, text: null },
    ...['not-a-uuid', ' ', 'null'].map(inReplyTo => ({ action: 'send', toPeerId: f.other.id, text: 'body', inReplyTo })),
  ]) await assert.rejects(execute(f, input.action, input), /rename|display.?name|send|body|peer|reply/i);
  assert.equal(f.backend.peer.displayName, 'local'); assert.equal(f.other.displayName, 'Other');
  assert.equal(Object.keys(f.state.messages).length, 0); assert.equal(f.state.groups[f.group.id].limit, 0);
});

test('send validation identifies the bad ID field rather than blaming a valid recipient', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx);
  await assert.rejects(execute(f, 'send', { toPeerId: f.other.id, text: 'body', inReplyTo: 'not-a-message-id' }), /inReplyTo/);
  await assert.rejects(execute(f, 'send', { toPeerId: 'not-a-peer-id', text: 'body' }), /toPeerId/);
  assert.equal(Object.keys(f.state.messages).length, 0); assert.equal(f.state.groups[f.group.id].used, 0);
});

test('concurrent self-renames are rejected instead of racing the local name cache', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx);
  assert.ok(f.tools.get('peer_message').parameters.properties.action.enum.includes('rename'));
  let release; let started; const ready = new Promise(r => { started = r; });
  const barrier = new Promise(r => { release = r; }); const self = f.backend.peer;
  f.backend.heartbeat = async name => { started(); await barrier; p.heartbeat(f.state, f.currentLease(), name); };
  const first = execute(f, 'rename', { displayName: 'first-reviewer' }); await ready;
  await assert.rejects(execute(f, 'rename', { displayName: 'second-reviewer' }), /busy|progress/i);
  release(); await first; assert.equal(f.backend.peer.displayName, 'first-reviewer');
});

test('late rename acknowledgment cannot follow replacement membership or block its naming', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx);
  assert.ok(f.tools.get('peer_message').parameters.properties.action.enum.includes('rename'));
  let release; let started; const ready = new Promise(r => { started = r; });
  const barrier = new Promise(r => { release = r; }); const oldId = f.backend.peer.id;
  const heartbeat = f.backend.heartbeat;
  f.backend.heartbeat = async name => { await heartbeat(name); started(); await barrier; };
  const pending = execute(f, 'rename', { displayName: 'old-reviewer' }); await ready;
  await f.commands.get('messages').handler('leave', f.ctx);
  await f.commands.get('messages').handler('join review', f.ctx);
  f.backend.heartbeat = heartbeat;
  await execute(f, 'rename', { displayName: 'new-reviewer' });
  release(); await assert.rejects(pending, /participation|session changed/i);
  assert.notEqual(f.backend.peer.id, oldId); assert.equal(f.backend.peer.displayName, 'new-reviewer');
});

test('identity guidance is transient, current, and inert outside explicit enabled participation', async t => {
  const f = fixture(t); const context = f.events.get('context'); assert.equal(typeof context, 'function');
  const original = [{ role: 'user', content: 'Review the tests', timestamp: 1 }];
  assert.deepEqual(context({ messages: original }, f.ctx).messages, original);
  assert.equal(f.connectCalls.length, 0);
  await f.commands.get('messages').handler('join review', f.ctx);
  f.backend.peers = async () => { throw Error('Context must not poll the broker'); };
  f.backend.readBody = async () => { throw Error('Context must not read pending bodies'); };
  p.prepareMessage(f.state, { peerId: f.other.id, leaseId: f.other.leaseId }, { toPeerId: f.backend.peer.id, text: 'PRIVATE_BODY' }, 'pending');
  const state = structuredClone(f.state);
  const supplied = context({ messages: original }, f.ctx);
  assert.equal(supplied.messages.length, 2); assert.equal(original.length, 1);
  const identity = supplied.messages[1];
  assert.equal(identity.role, 'custom'); assert.equal(identity.customType, 'pi-messaging.identity.v1'); assert.equal(identity.display, false);
  assert.deepEqual(identity.details, { group: f.group, id: f.backend.peer.id, sessionId: 'local', displayName: 'local' });
  assert.equal(JSON.stringify(supplied).includes('PRIVATE_BODY'), false);
  assert.deepEqual(f.state, state); assert.equal(f.delivered.length, 0);
  await execute(f, 'rename', { displayName: 'test-reviewer' });
  const refreshed = context({ messages: supplied.messages }, f.ctx);
  assert.equal(refreshed.messages.length, 2); assert.equal(refreshed.messages[1].details.displayName, 'test-reviewer');
  f.activeTools.length = 0;
  assert.deepEqual(context({ messages: refreshed.messages }, f.ctx).messages, original);
  f.activeTools.push('peer_message');
  for (const mode of ['rpc', 'json', 'print']) assert.deepEqual(context({ messages: refreshed.messages }, { ...f.ctx, mode }).messages, original);
  await f.commands.get('messages').handler('leave', f.ctx);
  assert.deepEqual(context({ messages: refreshed.messages }, f.ctx).messages, original);
  await f.commands.get('messages').handler('join review', f.ctx); await f.backend.close();
  assert.deepEqual(context({ messages: refreshed.messages }, f.ctx).messages, original);
});

test('busy work cannot enable admission; settling idle admits one queued message', { timeout: 2000 }, async t => {
  const f = fixture(t); let reserves = 0; let statusSeen;
  const status = new Promise(resolve => { statusSeen = resolve; });
  f.ctx.ui.setStatus = () => statusSeen(); f.ctx.isIdle = () => false;
  f.backend.reserve = async () => { reserves++; return null; };
  await f.events.get('agent_start')({}, f.ctx);
  await f.commands.get('messages').handler('join review', f.ctx); await status;
  assert.equal(reserves, 0); assert.equal(f.delivered.length, 0);
  const message = p.prepareMessage(f.state, { peerId: f.other.id, leaseId: f.other.leaseId }, { toPeerId: f.backend.peer.id, text: 'quiet message' }, 'quiet');
  p.arm(f.state, f.group, 1);
  f.backend.reserve = async () => { const r = p.admit(f.state, f.currentLease(), message.id); return r ? { ...r, envelope: p.envelope(f.state, message, 'quiet message') } : null; };
  let delivered; const delivery = new Promise(resolve => { delivered = resolve; });
  f.pi.sendMessage = (...args) => { f.delivered.push(args); delivered(); };
  f.ctx.isIdle = () => true; await f.events.get('agent_settled')({}, f.ctx); await delivery;
  assert.equal(f.delivered.length, 1); assert.equal(f.delivered[0][1].deliverAs, 'followUp');
  assert.equal(f.state.groups[f.group.id].used, 1);
});

test('onboarding permits a bounded discovery/name sequence and never resets on another agent run', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx);
  const context = f.events.get('context'); f.activeTools.length = 0;
  assert.equal(context({ messages: [] }, f.ctx).messages.length, 0);
  f.activeTools.push('peer_message');
  const first = context({ messages: [] }, f.ctx).messages[0]; assert.ok(first.content.includes(NAMING_GUIDANCE));
  assert.ok(first.content.includes(QUIET_GUIDANCE));
  const second = context({ messages: [first] }, f.ctx).messages[0];
  assert.ok(second.content.includes(NAMING_GUIDANCE)); assert.equal(second.content.includes(QUIET_GUIDANCE), false);
  const third = context({ messages: [second] }, f.ctx).messages[0];
  assert.equal(third.content.includes(NAMING_GUIDANCE), false); assert.ok(third.content.length < first.content.length / 2);
  assert.deepEqual(third.details, first.details);
  await f.events.get('agent_start')({}, f.ctx);
  assert.equal(context({ messages: [] }, f.ctx).messages[0].content.includes(NAMING_GUIDANCE), false);
  await execute(f, 'rename', { displayName: 'test-reviewer' });
  assert.equal(context({ messages: [] }, f.ctx).messages[0].details.displayName, 'test-reviewer');
  await f.commands.get('messages').handler('leave', f.ctx); await f.commands.get('messages').handler('join review', f.ctx);
  assert.ok(context({ messages: [] }, f.ctx).messages[0].content.includes(NAMING_GUIDANCE));
  await execute(f, 'rename', { displayName: 'test-reviewer' });
  assert.equal(context({ messages: [] }, f.ctx).messages[0].content.includes(NAMING_GUIDANCE), false, 'Successful naming ends reminders immediately');
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
  const m = p.prepareMessage(f.state, { peerId: f.other.id, leaseId: f.other.leaseId }, { toPeerId: f.backend.peer.id, text: 'uncertain' }, 'other-send');
  p.admit(f.state, f.currentLease(), m.id);
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
  f.ctx.ui.confirm = async () => { begun(); return new Promise(r => { release = r; }); };
  const joining = f.commands.get('messages').handler('join review', f.ctx); await started;
  await f.events.get('session_before_tree')({}, f.ctx); release(true);
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
