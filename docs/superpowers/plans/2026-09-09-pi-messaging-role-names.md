# Pi Messaging Role Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Join without naming dialogs, default to the Pi session ID, and let agents discover peers and select role-bearing names during normal work.

**Architecture:** Preserve the existing broker identity/routing schema. Reuse the existing heartbeat name mutation behind an own-only agent action. Add transient membership guidance through Pi's context hook, never by starting a naming turn or reading other conversations.

**Tech Stack:** TypeScript, native Pi extension API (development 0.82.0, installed 0.84.1), node:test/Jiti, existing NATS JetStream backend.

## Global Constraints

- Pi session ID is the default; custom role name plus session ID is the user-facing identity.
- Preserve fresh per-join routing IDs and independent contexts.
- No automatic join/arm/task assignment, no new admission credits, no broker lifecycle changes.
- Nonempty, single-line, terminal-control-safe names, maximum 64 code points.
- No dependencies, ledger/envelope migration, or unrelated refactoring.
- Use the existing isolated `.worktrees/pi-messaging` branch; keep existing sessions/broker untouched. No merge/push.
- Live tests: cheap Google Flash model only, bounded requests/tokens/time/estimated cost.

---

### Task 1: Session-ID defaults and readable identity

**Files:** modify `pi-messaging/src/ui.ts`, `pi-messaging/extensions/messaging.ts`, `pi-messaging/tests/extension.test.mjs`; create `pi-messaging/src/identity.ts`.

**Interfaces:** `peerLabel(peer: Pick<Peer, 'displayName' | 'sessionId'>): string` produces terminal-safe role/session labels. Simplify `HumanControls.joined(ref: GroupRef): void`; remove title-following state/event behavior.

- [x] Add/adjust tests before implementation. Replace the obsolete title-following test, and move the delayed join test's barrier from input to confirmation:
  ```js
  f.ctx.ui.input = async () => { throw Error('No name input expected'); };
  await f.commands.get('messages').handler('join review', f.ctx);
  assert.equal(f.backend.peer.displayName, f.ctx.sessionManager.getSessionId());
  assert.equal(f.backend.peer.sessionId, f.ctx.sessionManager.getSessionId());
  assert.equal(f.delivered.length, 0);
  ```
  Add role/session-label and duplicate-name/session-prefix selector tests; verify selecting the second identical-looking peer still sends to its own routing ID.
- [x] Run `node --test pi-messaging/tests/extension.test.mjs` and confirm failures are missing behavior, not a hanging old dialog test.
- [x] Remove only the join input dialog and title-following behavior; include the session ID in confirmation. Implement `peerLabel` (no repeated ID while unnamed), use numbered peer choices in send/revoke, and role/session labels in status/arm/footer.
  ```ts
  const sessionId = ctx.sessionManager.getSessionId();
  await b.join(group, { sessionId, displayName: sessionId });
  controls.joined(group);
  ```
- [x] Run focused tests/typecheck green before continuing.

### Task 2: Scoped self-renaming and normal-turn discovery

**Files:** modify `pi-messaging/extensions/messaging.ts`, `pi-messaging/src/policy.ts`, `pi-messaging/src/identity.ts`, `pi-messaging/tests/extension.test.mjs`, `pi-messaging/tests/backend.test.mjs`.

**Interfaces:** export existing `validateDisplayName(value: string): string`; `peer_message({action:'rename', displayName:string})` returns `{id, sessionId, displayName}`. Retain `peers.selfId` and `peers[].id`; add `selfSessionId` and `peers[].sessionId`. `IDENTITY_CONTEXT_TYPE = 'pi-messaging.identity.v1'` identifies transient context only.

- [x] Add failing tests for rename, bad names/target selectors, unjoined/non-TUI callers, unchanged routing/allowance/history, duplicate or late rename fencing, and discovery session IDs:
  ```js
  const before = f.backend.peer.id;
  await execute(f, 'rename', { displayName: 'test-reviewer' });
  assert.equal(f.backend.peer.id, before);
  assert.equal(f.backend.peer.displayName, 'test-reviewer');
  assert.equal(f.other.displayName, 'Other');
  ```
  Add context tests: original messages unchanged; one extension-origin metadata message; no body reads/connection/delivery; no guidance after leave, disabled tool, closed backend, or non-TUI mode; stale context replaced rather than accumulated.
- [x] Run focused tests red. Extend the fixture only at external Pi/broker boundaries; retain real policy mutations.
- [x] Extend the tool enum/schema with rename. Validate and normalize through the existing policy validator, reject fields other than action/displayName, guard concurrent renames per peer ID, and use `await b.heartbeat(displayName)`. Preserve the existing generation/peer checks; do not restore membership or names.
- [x] Add a synchronous context callback using only local `backend.peer`, `joined`, `backend.closed`, and `pi.getActiveTools()`. Append a custom message with static naming instructions and JSON metadata, not interpolated peer instructions in the system prompt. Remove old identity-context messages before rebuilding. Do not call `sendMessage`, `sendUserMessage`, broker reads, or model APIs.
- [x] Run focused tests/typecheck green and a real broker rename/readback/queued-message/rejoin test.

### Task 3: Behavioral smoke, documentation, and review

**Files:** modify `pi-messaging/scripts/live-smoke.mjs`, `pi-messaging/README.md`, current messaging design/review docs, and this plan.

- [x] Update live smoke before running: UI input throws; identify test sessions by session ID, not manually supplied A/B names. Give each agent an ordinary ping/pong role assignment; do not instruct discovery or naming in test prompts. Observe tool calls/results to assert recipient discovery and self-renaming by both agents. Do not require a responder with an already known sender ID to make a redundant discovery call. Retain two spent admissions, two observed messages, and one queued FOLLOWUP. Assert joining makes zero inference requests and transient identity context is not persisted.
- [x] Keep existing 512 output tokens/request, 20,000-byte request context, 90-second deadline, and $0.50 estimated cap; use maximum 16 requests to cover discovery+rename in both existing normal runs. No production inference is added.
- [x] Run bounded live smoke with `PI_MESSAGING_TEST_MODEL=ai-gw-google/gemini-3-flash-preview` against development and installed SDKs. Report actual evidence and model limitations, never infer compliance from prompt text alone.
- [x] Update README and authoritative spec: four tool actions, new default, session-ID display, no naming-only turns; preserve historical validation records with a dated follow-up.
- [x] Run aggregate broker-gated tests, typecheck, `git diff --check`; review all changes for stale callbacks, wrong-recipient paths, authority expansion, and leaked bodies. Leave branch unmerged/unpushed. Finish with configured SSH signing and tell the user to `/reload` and explicitly rejoin.

## Execution record

Baseline at 42e2586: all 125 aggregate tests passed, including 43 messaging tests. Existing worktree verified, no tracked changes before this design/plan. User approved implementation; execute inline under existing autonomous approval without another execution-choice prompt.

Live-test refinement: initial runs correctly self-named both agents, but exposed an overly prescriptive assertion requiring each to list peers before renaming. The responder already knew its sender. The final test instead withholds the recipient address from the human prompt, requires discovery before the initiator's send, and still requires exactly one role rename by each agent. Both Pi 0.82.0 (8 requests) and 0.84.1 (7 requests) passed, choosing `protocol-initiator` / `protocol-responder`, preserving two admissions and one queued FOLLOWUP. Combined estimated usage for these two passing runs: $0.00954 at published rates; gateway billing unverified.

Final verification: 133 aggregate tests, including 51 messaging tests, zero failures/skips. Messaging tests also pass under Node 22.19.0 and 24.20.0. Typecheck, ShellCheck, repository rendering/Chezmoi checks, headless Neovim, and diff checks pass. Independent read-only Flash review claims were evaluated against code; a real-broker regression confirms unnamed-heartbeat CAS conflicts cannot revert role names and invalid names cannot reach the local cache. No production fix was required. See the dated follow-up in the review notes. Existing user sessions and the active hands-on broker remain untouched.
