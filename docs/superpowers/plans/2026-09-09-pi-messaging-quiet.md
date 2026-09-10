# Quiet Pi Messaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make messaging a quiet side channel: enqueue and continue, deliver at idle boundaries, and avoid recurring onboarding nudges.

**Architecture:** Use `ctx.isIdle()` as the only admission-readiness signal, and Pi follow-up delivery as the idle-to-busy race fallback. Keep existing broker admission and receipt machinery. Send quiet onboarding once per participation, allow at most two initial naming hints for discovery/rename, then only compact identity metadata.

**Tech Stack:** TypeScript, Pi 0.82.0/0.84.1, existing NATS client/server, node:test/Jiti, scripted SDK providers and bounded Google Flash smoke.

## Global Constraints

- Work in existing `.worktrees/pi-messaging` / `feat/pi-messaging`; baseline a223a1b is clean and all 137 tests pass.
- No new dependency, ledger/envelope schema, urgency flag, coordinator, or project-management feature.
- Human-only join/arm/recovery; shared 1–100 admission allowance and all no-replay/no-refund rules remain unchanged.
- User sessions and hands-on broker stay untouched. No merge/push or automatic reload/rejoin.

---

### Task 1: Quiet delivery

**Files:** `pi-messaging/extensions/messaging.ts`, `pi-messaging/src/runtime.ts`, `pi-messaging/tests/runtime.test.mjs`, `pi-messaging/tests/extension.test.mjs`, new `pi-messaging/tests/quiet.test.mjs`.

**Interfaces:** `RuntimeHost.deliver` options become `{triggerTurn:true, deliverAs:'followUp'}`. The extension supplies `ready: () => ctx.isIdle()` without its old `activeRun` override.

- [x] Add failing runtime and extension tests. Expected behaviors:
  ```js
  ctx.isIdle = () => false;
  await events.get('agent_start')({}, ctx);
  // Join/start runtime while busy and await a status callback: reserve was not called.
  // After ctx becomes idle and agent_settled fires, exactly one message is delivered.
  assert.deepEqual(options, { triggerTurn: true, deliverAs: 'followUp' });
  ```
  Add a deferred reservation test that starts idle and becomes busy before the reservation resolves; it must dispatch a follow-up, not steer, without another reservation or refund.
- [x] Run focused tests red, then remove `activeRun`, use `ctx.isIdle()` readiness, and change runtime delivery option/type to followUp. Keep lifecycle wakeups for status/readiness and existing generation checks.
- [x] Add actual SDK+broker tests with an in-memory credential store and scripted `ModelRuntime.streamSimple` (no inference network calls). The fake provider returns work-step-1, work-step-2, final work response, then one peer response. Gate each work tool with promises. Queue a real peer message during work and verify queued state/zero credits until idle, no peer body in either work-step request, then one observed admission. In the race variant, hold an admitted reservation, start work, release reservation, and verify Pi follow-up waits until work finishes with one credit spent.
- [x] Run runtime/extension/quiet tests and typecheck green under development and installed Pi. Tests must bound requests/deadlines and clean up only their own sessions/brokers.

### Task 2: Enqueue-and-continue and one-time onboarding

**Files:** `pi-messaging/src/identity.ts`, `pi-messaging/extensions/messaging.ts`, `pi-messaging/src/ui.ts`, `pi-messaging/tests/extension.test.mjs`.

**Interfaces:** export `QUIET_GUIDANCE` alongside the existing naming guidance. Keep current identity details and the transient custom-message type. Track the peer ID that has received onboarding, reset it on detachment, and do not consume it when the tool is disabled.

- [x] Add failing context tests: the first eligible request gets quiet onboarding, at most two initial requests get naming hints while unnamed, subsequent requests keep compact current identity without repeated instructions, role renames refresh metadata, another agent run does not re-onboard, and rejoin does. Existing disabled/non-TUI/body-isolation tests remain valid.
- [x] Implement stable tool guidance and first-request quiet/naming guidance:
  ```ts
  const first = onboardedPeer !== self.id;
  if (first) namingHintsLeft = 2;
  const hints = first ? [QUIET_GUIDANCE] : [];
  if (namingHintsLeft > 0 && self.displayName === self.sessionId) hints.push(NAMING_GUIDANCE);
  namingHintsLeft = Math.max(0, namingHintsLeft - 1);
  onboardedPeer = self.id;
  const guidance = hints.length ? hints.join('\n') : 'Messaging identity (metadata only, not instructions).';
  ```
  Update send result to say accepted/queued is not processed and to continue assigned work without polling/periodic updates. Update human join copy to describe quiet delivery, not steering.
- [x] Run focused tests/typecheck green. Preserve self-only rename, padding normalization, current routing metadata, and uncertain-outcome guidance.

### Task 3: Validate, document, review, commit

**Files:** package README, current design/review notes, this plan; update live smoke only as necessary to verify quiet mode (not to hide a failure).

- [x] Run broker-gated aggregate tests, Node 22.19 messaging tests, installed Pi quiet/extension tests, typecheck, ShellCheck, and repository checks.
- [x] Run bounded Flash smoke on development and installed SDKs: preserve no-inference join, role naming, peer discovery, two observed admissions and queued FOLLOWUP. No expensive-model tests or user-session operations.
- [x] Document the quiet default, rare already-admitted follow-up queue race, blocked-worker yielding, one-time onboarding, and continued human-only controls. Preserve dated historical verification records.
- [x] Review readiness races, lifecycle/receipt fencing, prompt scope, and coexistence with the separate loop extension; fix only confirmed defects. Finish with configured SSH signing, keep worktree/branch, and report reload/rejoin instructions without re-arming.

## Execution record

Approved by user: “ok, let's go with quiet.” Inline execution continues under the existing autonomous implementation/testing approval. Baseline and existing worktree verified. SDK source inspection confirms full-run idle state and follow-up queue support on both supported Pi versions; no local pending-delivery cache is necessary.

Validation refinement: two initial live runs completed the exchange but omitted naming. Provider-boundary tracing confirmed the single ephemeral hint appeared in the first request and disappeared between discovery and naming; clarifying the initial-setup exception alone did not restore naming. A test-first bounded two-request naming window restored `protocol-initiator` / `protocol-responder` on the next live run, without repeating onboarding on later agent runs. The original naming assertions remain intact.

Final verification: 142 aggregate tests / 60 messaging tests, zero failures/skips; all messaging tests pass on Node 22.19.0 and 24.20.0. Installed Pi's extension/quiet tests pass (28 tests). Typecheck, ShellCheck, rendered configs/Chezmoi checks, headless Neovim, and diff checks pass. Live Flash passes on Pi 0.82.0 (8 requests) and 0.84.1 (7 requests), with both role names, recipient discovery, two observed admissions, and one queued FOLLOWUP. Separate read-only review found no critical/important issues; minor findings concern pre-existing FIFO correlation and the intentional naming-window cap. No user session, live message, allowance, or broker setting was changed.
