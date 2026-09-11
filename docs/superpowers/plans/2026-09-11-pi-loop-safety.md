# Pi Loop Fail-Safe Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent repeated loop-control model cycles, enforce finite iteration/context bounds, and keep the control tool active only while one loop decision is expected.

**Architecture:** Preserve the existing persisted state shape while adding a volatile one-decision latch and an idempotent helper that toggles only `loop_control` in Pi's active tool set. Control results terminate the current tool cycle; `agent_settled` remains the sole scheduler and checks iteration/context bounds before queuing one follow-up.

**Tech Stack:** TypeScript, Pi extension API 0.82.0/0.84.1, TypeBox, Node test runner, jiti, scripted `pi-ai` provider

## Global Constraints

- Default maximum is 12 agent runs; explicit maximum must be an integer from 1 through 100.
- Known context usage at or above 85% stops before another follow-up.
- One decision appends at most one state entry and returns `terminate: true`.
- Inactive/duplicate/stale decisions append nothing and terminate without throwing.
- Only `loop_control` may be added/removed; preserve every other active tool.
- Interrupted persisted `shouldContinue: true` state stops on restoration without automatic inference.
- No live-model calls, affected-session edits, package activation, merge, or push.

---

### Task 1: Terminal one-decision state machine and safety bounds

**Files:**
- Modify: `pi-loop-package/extensions/loop.ts`
- Modify: `pi-loop-package/tests/loop.test.mjs`

**Interfaces:**
- Consumes: `pi.getActiveTools()`, `pi.setActiveTools(names)`, terminating tool results, `ctx.getContextUsage()`.
- Produces: unchanged `/loop` commands and `loop_control` schema; tool results additionally return `terminate: true`.

- [ ] **Step 1: Add failing unit regressions**

Extend the fake ExtensionAPI with mutable active tools and assertions that:

```js
assert.equal((await tool.execute('one', { action: 'continue' })).terminate, true);
assert.equal((await tool.execute('two', { action: 'continue' })).terminate, true);
assert.equal(entries.filter(entry => entry.data.shouldContinue).length, 1);
assert.equal(activeTools.includes('loop_control'), false);
```

Also assert inactive stop/continue append nothing; start defaults to 12; `--max 0`, `--max 101`, and malformed suffixes send no user message; unrelated tools survive enable/disable; `--max 1` stops after the initial run; known 85% usage stops without a follow-up; unknown/84.9% usage allows one; enqueue failure finalizes inactive; and restored `active && shouldContinue` state fails closed.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
node --test pi-loop-package/tests/loop.test.mjs
```

Expected: failures show non-terminating results, repeated persistence, globally active control, default 100, and absent context guard.

- [ ] **Step 3: Implement tool activation and decision gating**

Add constants:

```ts
const DEFAULT_MAX_ITERATIONS = 12;
const MAX_ITERATIONS = 100;
const MAX_CONTEXT_PERCENT = 85;
const TOOL_NAME = "loop_control";
```

Add `decisionRecorded`, `setControlEnabled(enabled)`, and an idempotent `stopLoop(reason, persistTransition = true)`. `setControlEnabled` reads the current active list, adds/removes only `TOOL_NAME`, and calls `setActiveTools` only when the result differs.

The first active tool call sets `decisionRecorded = true` before any persistence, disables the tool, records stop/continue once, and returns `terminate: true`. Calls while inactive or already decided return a terminating no-op with no append.

- [ ] **Step 4: Implement bounded settled scheduling**

In `agent_settled`, require an active recorded continue decision. Stop when the next iteration reaches the configured maximum or known context percent is at least 85. Otherwise increment once, reset `shouldContinue`/`decisionRecorded`, persist `continuedAt`, enable the tool, and queue one follow-up. Catch enqueue failure, stop, clear status, and notify a warning.

On `session_start`, restore the latest valid entry. If it is active with `shouldContinue`, stop it as interrupted; otherwise synchronize tool activation to active/inactive without triggering work.

Parse `--max` strictly as a final decimal integer; reject values outside 1–100 instead of silently falling back. Human inactive stop remains idempotent without persistence.

- [ ] **Step 5: Run unit tests and typecheck GREEN**

```bash
node --test pi-loop-package/tests/loop.test.mjs
npm run typecheck
```

Expected: all loop unit tests pass and TypeScript reports no errors.

- [ ] **Step 6: Commit the state-machine fix**

```bash
git add pi-loop-package/extensions/loop.ts pi-loop-package/tests/loop.test.mjs
git commit -m "fix: make Pi prompt loops fail-safe"
```

---

### Task 2: Prove termination with the real Pi agent loop

**Files:**
- Create: `pi-loop-package/tests/loop-sdk.test.mjs`
- Modify: `pi-loop-package/README.md`
- Create: `docs/superpowers/reviews/2026-09-11-pi-loop-safety.md`

**Interfaces:**
- Consumes: `createAgentSession`, `DefaultResourceLoader`, `ModelRuntime`, `SessionManager`, `SettingsManager`, and a scripted `createAssistantMessageEventStream` provider.
- Produces: compatibility evidence only; no production API changes.

- [ ] **Step 1: Add a real-SDK scripted provider test**

Create an isolated temporary agent/session directory with extensions/skills/context disabled except `loopExtension`. Script request one to return a sole `loop_control {action:"continue"}` call and request two to return a sole `loop_control {action:"stop"}` call. Reject a third request:

```js
assert.ok(requests.length < 3, 'terminating loop control must prevent repeated model calls');
```

Start `/loop start bounded objective --max 3`, wait for the session to become idle, and assert exactly two provider requests, one `continuedAt` state at iteration 1, one final stop, no duplicate decisions, and inactive tool status.

- [ ] **Step 2: Run the SDK test against both supported Pi versions**

```bash
PI_OFFLINE=1 node --test pi-loop-package/tests/loop-sdk.test.mjs
PI_OFFLINE=1 PI_LOOP_PI_SDK=/home/linuxbrew/.linuxbrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js \
  node --test pi-loop-package/tests/loop-sdk.test.mjs
```

Expected: both runs pass with exactly two scripted requests and no paid inference.

- [ ] **Step 3: Document the fail-safe contract**

Update the package README with default 12, explicit 1–100 maximum, 85% context stop, one terminating decision per iteration, inactive tool behavior, reload recovery, and the fact that the extension does not impose a monetary budget because model pricing/session totals are not a stable extension control surface.

- [ ] **Step 4: Run full verification**

```bash
NATS_SERVER=/tmp/pi-message-queue-review/bin/nats-server PI_MESSAGING_REQUIRE_BROKER=1 npm test
npm run typecheck
npm run lint:shell
npm run check
git diff --check
```

Expected: every suite passes with zero broker skips. Record aggregate/loop counts and both SDK versions in the review file.

- [ ] **Step 5: Review and commit evidence**

Review specifically for parallel tool calls, dynamic-tool collateral changes, duplicate `agent_settled`, restored state, queue errors, off-by-one maximum behavior, and context percent nullability. Record findings and corrections in the review file, then commit:

```bash
git add pi-loop-package/tests/loop-sdk.test.mjs pi-loop-package/README.md \
  docs/superpowers/specs/2026-09-11-pi-loop-safety-design.md \
  docs/superpowers/plans/2026-09-11-pi-loop-safety.md \
  docs/superpowers/reviews/2026-09-11-pi-loop-safety.md
git commit -m "docs: document fail-safe Pi loops"
```

- [ ] **Step 6: Stop before activation**

Report the signed branch and verification. Do not reload the affected SAP pane, change its session file, or update global Pi package registration without separate user approval.
