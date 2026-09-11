# Pi Loop Prompt-Cache Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate loop-owned prompt/tool mutations at iteration boundaries while preserving every fail-safe loop bound and proving request-visible cache structure remains stable.

**Architecture:** Keep `loop_control` registered and stationary for the session, remove active-only prompt metadata, and move all loop instructions into one constant `before_agent_start` suffix. Observe tool availability without changing it and fail closed before starts, restored runs, or continuations when an external actor disables the tool.

**Tech Stack:** TypeScript, Pi extension API, Node test runner, Jiti, scripted Pi SDK provider, Node 22.19+/24, Pi 0.82.0/0.84.1.

## Global Constraints

- The loop extension must never call `pi.setActiveTools()`.
- `loop_control` must have no `promptSnippet` or `promptGuidelines`.
- Warm continuations must expose identical system prompts and canonical tool definitions; conversation messages are expected to grow.
- All tool results remain terminating, and one synchronous decision latch remains authoritative.
- Preserve the default 12 runs, explicit 1–100 range, initial-run counting, 85% context stop, queue-error stop, and fail-closed interrupted restoration.
- Token budgets, dollar budgets, provider settings, and Pi messaging behavior are out of scope.
- Use scripted providers only; do not make paid model calls.
- Do not reload Pi, activate the package, or modify the SAP pane/session.

---

### Task 1: Stationary tool and fail-closed availability

**Files:**
- Modify: `pi-loop-package/tests/loop.test.mjs`
- Modify: `pi-loop-package/extensions/loop.ts`

**Interfaces:**
- Consumes: Pi `getActiveTools(): string[]`, `before_agent_start`, `agent_settled`, and existing persisted `LoopState`.
- Produces: `toolIsAvailable(): boolean`; constant `ACTIVE_LOOP_INSTRUCTION`; unchanged `loop_control` input/result contract.

- [ ] **Step 1: Make tool mutation fail loudly in the test fixture**

Change the fixture to retain externally controlled tools while rejecting extension mutations:

```javascript
function setup({ initialTools = ['read', 'loop_control'], failMessageAt } = {}) {
  let activeTools = [...initialTools];
  // Existing registration omitted here.
  loop.default({
    // Existing Pi methods.
    getActiveTools() { return [...activeTools]; },
    setActiveTools() { throw new Error('loop extension must not mutate active tools'); },
  });
  return {
    // Existing fixture fields.
    activeTools: () => [...activeTools],
    externalSetActiveTools(names) { activeTools = [...names]; },
  };
}
```

Replace assertions that expected removal/re-addition with assertions that the complete tool list remains unchanged after startup, start, decision, settlement, stop, duplicate calls, and session replacement.

- [ ] **Step 2: Add failing schema and stable-prompt tests**

Add tests with these exact assertions:

```javascript
test('loop tool has stationary cache-friendly prompt metadata', () => {
  const { tool } = setup();
  assert.equal(Object.hasOwn(tool, 'promptSnippet'), false);
  assert.equal(Object.hasOwn(tool, 'promptGuidelines'), false);
});

test('active loop instruction is byte-stable across continuations', async () => {
  const f = setup(); const c = context();
  await f.commands.get('loop')('start cache stable --max 3', c.ctx);
  const first = await f.events.get('before_agent_start')({ systemPrompt: 'base' }, c.ctx);
  await f.tool.execute('decision', { action: 'continue' });
  await f.events.get('agent_settled')({}, c.ctx);
  const second = await f.events.get('before_agent_start')({ systemPrompt: 'base' }, c.ctx);
  assert.equal(first.systemPrompt, second.systemPrompt);
  assert.doesNotMatch(first.systemPrompt, /cache stable|iteration|3/);
});
```

Also assert an inactive `before_agent_start` returns `undefined`.

- [ ] **Step 3: Add failing unavailable-tool tests**

Cover all admission boundaries:

```javascript
test('start fails closed when loop_control is unavailable', async () => {
  const f = setup({ initialTools: ['read'] }); const c = context();
  await f.commands.get('loop')('start cannot run --max 3', c.ctx);
  assert.equal(f.messages.length, 0);
  assert.equal(f.entries.length, 0);
  assert.match(c.notifications.at(-1).message, /loop_control.*unavailable/i);
});

test('continuation fails closed if an external actor disables loop_control', async () => {
  const f = setup(); const c = context();
  await f.commands.get('loop')('start bounded --max 3', c.ctx);
  await f.tool.execute('decision', { action: 'continue' });
  f.externalSetActiveTools(['read']);
  await f.events.get('agent_settled')({}, c.ctx);
  assert.equal(f.messages.length, 1);
  assert.equal(f.entries.at(-1).data.active, false);
  assert.match(f.entries.at(-1).data.reason, /unavailable/i);
});
```

Add equivalent assertions for restored waiting state and for disablement immediately before `before_agent_start`: persisted state becomes inactive, no instruction patch is returned, no automatic message is sent, and a warning is shown.

- [ ] **Step 4: Run focused tests and verify RED**

Run:

```bash
node --test pi-loop-package/tests/loop.test.mjs
```

Expected failures: calls to forbidden `setActiveTools`, existing removal assertions, present prompt metadata, missing availability validation, and/or unstable behavior. Existing safety cases not involving these changes must continue to pass.

- [ ] **Step 5: Implement the stationary tool contract**

In `loop.ts`, add:

```typescript
const ACTIVE_LOOP_INSTRUCTION = "An autonomous prompt loop is active. At the end of this run, call loop_control exactly once as your sole final tool call. Stop if the objective is complete; otherwise continue.";

function toolIsAvailable(): boolean {
  return pi.getActiveTools().includes(TOOL_NAME);
}
```

Delete `setControlEnabled()` and every call to it. Remove `promptSnippet` and `promptGuidelines`. Replace the tool description with a static conditional contract:

```typescript
description: "Record the one final stop/continue decision for a prompt loop. Call only when the current system prompt says an autonomous loop is active.",
```

Before `startLoop()` in the command handler, reject an unavailable tool with a warning and no mutation. On restoration, stop active waiting state if unavailable. In `before_agent_start`, stop and warn if unavailable; otherwise append `"\n\n" + ACTIVE_LOOP_INSTRUCTION`. In `agent_settled`, after validating a continue decision but before scheduling, stop and warn if unavailable.

Do not change state shape, decision order, iteration arithmetic, context high-water logic, or queue handling.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
node --test pi-loop-package/tests/loop.test.mjs
npm run typecheck
```

Expected: all loop unit tests pass and TypeScript reports no errors.

- [ ] **Step 7: Review the production diff for forbidden mutations**

Run:

```bash
! rg 'setActiveTools|promptSnippet|promptGuidelines' pi-loop-package/extensions/loop.ts
git diff --check
git diff -- pi-loop-package/extensions/loop.ts pi-loop-package/tests/loop.test.mjs
```

Expected: the negative search succeeds, whitespace check succeeds, and the diff contains no unrelated changes.

- [ ] **Step 8: Commit Task 1 signed**

```bash
git add pi-loop-package/extensions/loop.ts pi-loop-package/tests/loop.test.mjs
git commit -m "fix: preserve prompt cache across loop iterations"
git log -1 --format='%h %G? %s'
```

Expected: signature status `G`.

---

### Task 2: Real SDK request-stability proof and documentation

**Files:**
- Modify: `pi-loop-package/tests/loop-sdk.test.mjs`
- Modify: `pi-messaging/tests/coexistence.test.mjs`
- Modify: `pi-loop-package/README.md`
- Modify: `docs/superpowers/specs/2026-09-11-pi-loop-cache-stability-design.md`
- Modify: `docs/superpowers/plans/2026-09-11-pi-loop-cache-stability.md`
- Create: `docs/superpowers/reviews/2026-09-11-pi-loop-cache-stability.md`

**Interfaces:**
- Consumes: Task 1 stationary `loop_control`, scripted `ModelRuntime.streamSimple`, and Pi request context `systemPrompt`/`tools`.
- Produces: a provider-free acceptance test that proves two requests have equal request-visible cache structure.

- [ ] **Step 1: Strengthen the real SDK request capture**

Change request capture to retain canonical definitions:

```javascript
requests.push({
  systemPrompt: context.systemPrompt,
  tools: (context.tools ?? []).map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  })),
});
```

After the two-request loop, assert:

```javascript
assert.equal(requests.length, 2);
assert.equal(requests[0].systemPrompt, requests[1].systemPrompt);
assert.deepEqual(requests[0].tools, requests[1].tools);
assert.ok(requests[0].tools.some(tool => tool.name === 'loop_control'));
assert.equal(session.getActiveToolNames().includes('loop_control'), true);
```

`getActiveToolNames()` is present in both target SDK declarations. Keep the provider scripted, the third-request assertion fatal, and usage zero.

- [ ] **Step 2: Make coexistence reject tool mutation**

In `pi-messaging/tests/coexistence.test.mjs`, replace the mutable `setActiveTools` mock with:

```javascript
setActiveTools: () => { throw new Error('neither extension may mutate active tools'); },
```

Keep the existing assertions proving messaging does not connect, reset loop state, or govern continuation. Add a final assertion that both `loop_control` and `peer_message` remain in `activeTools`.

- [ ] **Step 3: Run focused acceptance tests**

Run:

```bash
PI_OFFLINE=1 node --test pi-loop-package/tests/loop-sdk.test.mjs pi-messaging/tests/coexistence.test.mjs
```

Expected: both tests pass, exactly two scripted provider requests occur, and no active-tool mutation occurs.

- [ ] **Step 4: Run both Pi SDK versions**

Run the SDK test once with the repository dependency (Pi 0.82.0) and once with the installed SDK path (Pi 0.84.1):

```bash
PI_OFFLINE=1 node --test pi-loop-package/tests/loop-sdk.test.mjs
PI_LOOP_PI_SDK=/home/linuxbrew/.linuxbrew/lib/node_modules/@earendil-works/pi-coding-agent PI_OFFLINE=1 node --test pi-loop-package/tests/loop-sdk.test.mjs
```

Expected: one acceptance test passes in each run with no network/model inference.

- [ ] **Step 5: Update user documentation**

In `pi-loop-package/README.md`, replace dynamic enable/disable language with:

```markdown
`loop_control` stays registered and active so its schema remains stable across requests. It has no active-only prompt snippet or guideline. Loop instructions are injected only while a loop is active, using identical text on every continuation. The extension never changes the active-tool list.
```

Document unavailable-tool fail-closed behavior, the fixed schema overhead, the one-time loop entry/exit prompt change, and the distinction between cache-prefix stability and a guaranteed provider hit percentage. Retain all existing safety-stop and lifecycle documentation.

- [ ] **Step 6: Run the complete verification matrix**

Run:

```bash
NATS_SERVER=/tmp/pi-message-queue-review/bin/nats-server PI_MESSAGING_REQUIRE_BROKER=1 npm test
npm run typecheck
npm run lint:shell
npm run check
git diff --check
```

Then run all loop tests under Node 22.19.0 and 24.20.0 using the locally available binaries. Expected: zero failures/skips under the mandatory broker gate, clean type/lint/repository checks, and all loop tests pass on both Node versions.

- [ ] **Step 7: Perform a bounded review**

Review the final diff against the specification with emphasis on:

- any remaining loop-owned active-tool mutation;
- any dynamic value in the loop system-prompt suffix;
- request schema/order differences between iterations;
- unavailable-tool races at start, request preflight, restoration, and continuation;
- preservation of terminating results and one-decision scheduling;
- no messaging behavior change.

Record concrete findings, dispositions, and verification evidence in `docs/superpowers/reviews/2026-09-11-pi-loop-cache-stability.md`. Fix all Critical and Important findings test-first before proceeding.

- [ ] **Step 8: Mark plan execution accurately and commit signed**

Update this plan's completed checkboxes and change the design status to `Implemented, pending rollout`. Do not claim a live 99% hit rate. Then run:

```bash
git add pi-loop-package/tests/loop-sdk.test.mjs \
  pi-messaging/tests/coexistence.test.mjs \
  pi-loop-package/README.md \
  docs/superpowers/specs/2026-09-11-pi-loop-cache-stability-design.md \
  docs/superpowers/plans/2026-09-11-pi-loop-cache-stability.md \
  docs/superpowers/reviews/2026-09-11-pi-loop-cache-stability.md
git commit -m "test: prove cache-stable Pi prompt loops"
git log -1 --format='%h %G? %s'
```

Expected: signature status `G` and a clean worktree.

- [ ] **Step 9: Stop at the rollout boundary**

Report commits, exact verification counts, and any observational limitations. Do not reload Pi, change global package settings, modify the SAP session/pane, merge, or push without separate explicit authorization.
