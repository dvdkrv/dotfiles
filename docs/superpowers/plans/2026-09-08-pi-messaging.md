# Pi Messaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Human-controlled, bounded messaging between independent local Pi sessions, with a replaceable network-capable backend.

**Architecture:** One explicitly started, token-authenticated loopback NATS server owns both JetStream message storage and a bounded KV admission ledger. A compare-and-set update of that ledger atomically checks participation, reserves a message, and consumes group allowance; broker acknowledgments never authorize model turns. Separate policy, NATS adapter, runtime, and UI modules keep queue mechanics out of Pi-facing code.

**Tech Stack:** TypeScript; Node >=22.19; official `@nats-io/transport-node`, `@nats-io/jetstream`, and `@nats-io/kv` pinned to 3.4.0; nats-server 2.14.6; existing Pi development pins 0.82.0; Node test runner and jiti 2.7.0.

## Global Constraints

- Messaging only; no task launching, project tracking, vault integration, or automatic membership restoration.
- Human-only TUI join/arm/pause/recovery; tool has only peers/status/send.
- Default 12 admissions per group round; explicit human choice 1–100; receipts/retries/restarts never grant credits.
- At most one unresolved handoff per recipient; never replay an attempted message, even in a new round.
- Pause cannot retract an already admitted Pi message. Generation checks precede and follow asynchronous reservations.
- Same machine/user in v1; loopback plus private random token. No automatic broker startup from the extension; no remote configuration yet.
- Body <=8 KiB UTF-8; name <=64 code points; 16 active peers/group; 32 groups; 64 queued/attempted messages/group; 2,000 message records and 512 peer records globally.
- Pending/uncertain messages survive pruning; no silent replacement of a missing authority or ledger.
- Use deterministic tests for safety; bounded live tests use a cheap available model, no built-in shell/file tools, at most $0.50 estimated spend, and explicit timeouts.
- No global Pi activation, repository-wide Pi upgrade, push, or merge as an incidental implementation step.

## Broker protocol refinement

This replaces the historical SQLite mechanics in the review draft without changing the approved user-visible contract.

1. Provision fixed `PM_MESSAGES` stream (file, limits retention, discard-new, no age expiry, 2,000 messages/32 MiB, max message size 64 KiB) and `PM_CONTROL` KV bucket (file, history 1, no expiry). A single bounded `state` key contains authority UUID, schema version, groups, peers, and message metadata—but **not message bodies**. One CAS domain preserves exact global quotas as well as group-wide budgets; this trades throughput for simplicity at this deliberately small scale.
2. Enqueue first reserves metadata/idempotency/quota in the ledger. Publish a versioned body to `pm.message.<groupId>.<peerId>.<messageId>` with expected last subject sequence 0. This rejects duplicate publication for the entire retained subject lifetime, not only a deduplication time window. A crash before publication can leave a queued reservation with no body; human inspection exposes it and cancellation recovers space. Retrying the same send key may safely finish publication, but never repeats an admitted Pi handoff.
3. Each peer has a durable filtered pull consumer with explicit acknowledgments and max_ack_pending=1. Fetch one body, then CAS the ledger from queued to attempted together with allowance increment and recipient in-flight gate. Redelivery of attempted/terminal records is acknowledged without returning a new reservation. If paused/exhausted while fetching, leave the body eligible for later broker delivery without spending allowance.
4. Only the successful CAS caller receives a new attempt token. A lost/uncertain CAS acknowledgment stops that runtime; discovering an attempted record later does not confer handoff authority. Acknowledge the broker after commit; duplicate broker deliveries cannot pass the ledger gate. Pi call follows an asynchronous return and a generation check, without another await. Matching live custom-message receipt changes attempted to observed; it does not wake the model itself.
5. Control-change notifications wake joined runtimes; a 5-second heartbeat also reconciles missed notifications. Fetch waits are bounded; no LLM polling. Disconnect/uncertain transport errors stop automatic admissions until explicit leave/rejoin. Rejoining does not reset group credits.
6. Pruning removes only terminal records from inactive senders. Delete their body before CAS removal of metadata so partial failure retains recoverable metadata; admissions are impossible for those records. Delete unused consumers when peers leave/prune. Automatic maintenance uses a seven-day terminal retention threshold; explicit prune previews eligible IDs.
7. Broker bootstrap persists a private authority/config before initialization and an initialized marker after successful provisioning. Existing initialized stores are opened, never recreated. Server persistence uses `sync_interval: always`; verify server config and hard-restart behavior. Do not advertise resistance to filesystem rollback, disk loss, or malicious same-user programs.

## File structure and interfaces

- `pi-messaging/src/contracts.ts`: portable IDs, errors, DTOs, `MessagingBackend` and `MessagingReader` interfaces.
- `pi-messaging/src/policy.ts`: pure bounded ledger validation/transitions and text sanitization.
- `pi-messaging/src/nats-backend.ts`: connection, ledger CAS, JetStream consumers/publication, read-only adapter.
- `pi-messaging/src/config.ts`: private loopback config and ownership/symlink checks.
- `pi-messaging/src/broker.ts`: explicit foreground broker startup/bootstrap; owns child shutdown.
- `pi-messaging/src/runtime.ts`: generation fencing, notification coalescing, heartbeat, live receipt matching.
- `pi-messaging/src/ui.ts`: human dialogs and non-model inbox inspection.
- `pi-messaging/src/public.ts`: read-only summary interface/export, no hidden initialization.
- `pi-messaging/extensions/messaging.ts`: thin registration, human-only guards, tool and renderer.
- `pi-messaging/tests/`: unit, real-broker, multi-process, runtime and extension tests; temporary resources only.
- `pi-messaging/scripts/`: opt-in bounded live smoke test, not an installed extension/control backdoor.

Backend operations: `listGroups`, `createGroup`, `getGroupSummary`, `join`, `leave`, `heartbeat`, `arm`, `pause`, `send`, `reserve`, `observe`, `listMessages`, `readBody`, `resolveMessage`, `revoke`, `prune`, `onChange`, `close`. Participation is bound to a backend instance; no model-provided sender/group identity. Public reader exposes only `getGroupSummary(ref): Promise<GroupSummary | null>` and connection close.

### Task 1: Policy and broker admission protocol

**Files:** create contracts.ts, policy.ts, nats-backend.ts, package.json, tests/policy.test.mjs, tests/backend.test.mjs, tests/helpers/broker.mjs, tests/helpers/contender.mjs.

**Interfaces:** produces `connectBackend(config, { initialize? }): Promise<MessagingBackend>` and pure ledger transitions. `GroupRef={authorityId,id,label}`; `Reservation={group,peerId,message,attemptId,round}`; body is portable `Envelope={version:1,authorityId,messageId,groupId,senderPeerId,recipientPeerId,senderName,createdAt,text,inReplyTo?}`.

- [x] Write policy tests proving quota/identity validation and the finite shared budget. Example independent expectation:
  ```js
  const result = await Promise.all(receivers.map(b => b.reserve()));
  assert.equal(result.filter(Boolean).length, 12);
  assert.equal((await sender.getGroupSummary(group)).remaining, 0);
  assert.equal((await sender.listMessages(group)).filter(m => m.state === 'queued').length, 4);
  ```
- [x] Run `node --test pi-messaging/tests/policy.test.mjs`; observe missing-feature failure, then implement pure validation/transitions and rerun.
- [x] Write real-broker tests for two peers, duplicate sends/conflicts, paused fetch, observation/dismissal, retained uncertain attempts, wrong authority, and pruning. Launch nats-server with private temp config and token; never reuse the user broker.
- [x] Write a child-process contender that connects, joins, and reserves against a shared armed group. Assert exactly 12 admitted messages with surplus remaining; killing a committed consumer cannot refund or replay after broker restart.
- [x] Run real-broker tests red, implement NATS adapter, rerun green. Reject CAS conflicts safely with bounded retries; only retry the broker's known wrong-revision response, never an uncertain timeout.
- [x] Inspect dependency APIs and assert real publication dedup beyond a configured short broker dedup window. Confirm max_ack_pending and consumer filters against actual server state.
- [x] Commit `feat: add bounded JetStream messaging backend` after targeted tests and typecheck pass.

### Task 2: Safe local broker lifecycle/configuration

**Files:** create config.ts, broker.ts, tests/config.test.mjs, tests/broker.test.mjs.

**Interfaces:** consumes `connectBackend`; produces `readConfig(agentDir)`, `prepareConfig(agentDir,port)`, `runBroker(agentDir,serverPath,port)`; runtime config includes `{version:1,authorityId,server,token,initialized}`.

- [x] Write tests that reject non-loopback URLs, world-readable files, symlinked messaging/config paths, and unknown versions; missing config must not create files.
- [x] Run tests red; implement owner-only configuration and exclusive creation, using fixed config-derived paths rather than agent input.
- [x] Write broker subprocess tests that start on a free loopback port, initialize paused state, authenticate clients, reject missing token, shut down only the owned child, and refuse to recreate an initialized missing ledger.
- [x] Run tests red; implement explicit foreground startup, durable server config, bounded readiness and signal cleanup; rerun green.
- [x] Commit `feat: add explicit private messaging broker lifecycle`.

### Task 3: Pi runtime and human-facing command/tool

**Files:** create runtime.ts, ui.ts, public.ts, extensions/messaging.ts, tests/runtime.test.mjs, tests/extension.test.mjs.

**Interfaces:** consumes MessagingBackend. `MessagingRuntime` owns joined generation and `wake`, `stop`, `receipt`, `setRunActive`; `registerMessaging(pi, connect?)` wires the production extension with injectable backend creation for tests. Public registration has no I/O.

- [x] Write delayed-backend tests where `reserve()` is held pending, `stop()` invalidates participation, and resolving the reservation does not call Pi:
  ```js
  const pending = runtime.wake();
  await reservationStarted;
  await runtime.stop();
  resolveReservation(reservation);
  await pending;
  assert.equal(deliveries.length, 0);
  ```
- [x] Test idle wakeup and busy injection using exact `{triggerTurn:true,deliverAs:'steer'}`, custom type, IDs/attempt token, one matching live receipt, foreign/history receipt rejection, callback coalescing, and disconnect failure.
- [x] Run runtime tests red; implement generation fencing and callback lifecycle; rerun green.
- [x] Capture actual extension registration in tests and exercise command handlers with scripted TUI responses. Non-TUI modes must fail before backend creation. Agent tool must reject join/arm, hide pending bodies, require joined participation, and preserve attribution.
- [x] Implement `/messages` status/join/leave/arm/pause/send/inbox/prune/revoke using standard dialogs; show cancellation/dismissal and already-admitted limitations. No command text is automatically sent to the model.
- [x] Run extension and rendering tests, including terminal-control text, narrow widths, leave/reload/tree events, and coexistence without altering loop extension state.
- [x] Commit `feat: expose human-controlled Pi peer messaging`.

### Task 4: Integration, review, and bounded cheap-model smoke tests

**Files:** modify root package.json/package-lock.json, tsconfig.json, tests/pi-package-dependencies.test.mjs, settings and installer templates, .github/workflows/check.yml, README.md; create pi-messaging/README.md and scripts/live-smoke.mjs.

- [x] Update package contract tests first to require pi-messaging peers/test script/workspace inclusion; observe failure, then update manifests/templates. Keep Pi 0.82.0 overrides unchanged and use `npm install --ignore-scripts` for the lockfile.
- [x] Add a CI broker gate with pinned nats-server; normal offline unit tests must clearly distinguish skipped broker/live tests from passing coverage.
- [x] Document setup, starting/stopping the explicit broker, first join/arm flow, recovery, retention, threat boundary, protocol and test commands. Replace the long historical spec with a concise current design plus link to Git history.
- [x] Run `npm test`, `npm run typecheck`, `npm run lint:shell`, `npm run check`, and broker tests with NATS_SERVER set. Exercise Node 22.19 and the CI Node 24 runtime for the new package. Check standalone production dependency resolution.
- [x] Use the installed Pi SDK or real TUI subprocesses for a two-session live smoke with only peer_message enabled, explicit fake-human join/arm setup isolated in the test harness, allowance 2, short responses and a cheap authenticated model. Default live tests off; require explicit env opt-in, deadline, turn/token cap and estimated-cost cap. Report actual model/cost and whether full TUI or SDK adapter was tested.
- [x] Review failure paths independently of happy-path tests; add regressions for discovered bugs before fixing. Run final verification again.
- [x] Complete the final signed integration commit. The first attempt was blocked by a missing SSH-agent socket. Agent forwarding was restored, all 121 tests and repository checks were rerun, and the integration was finalized using the configured `dd-gitsign` signer without disabling signing.
- [x] Leave the branch unmerged/unpushed and preserve the worktree for review. Report exact test results, costs, known limitations, and setup commands; do not claim model task completion from a message receipt.

## Evidence log

Implementation and review are complete. See [verification/review notes](../reviews/2026-09-08-pi-messaging.md) and [operational README](../../../pi-messaging/README.md). Send-time maintenance was chosen instead of mutating storage during status/reader calls. The independent review's unsupported suggestions were checked and rejected with evidence. Real SDK smoke tests passed with Gemini 3 Flash on both Pi versions; the terminal UI itself was not automated.

- Baseline: repository aggregate `npm test` and `npm run typecheck` passed in `.worktrees/pi-messaging` before implementation.
- nats-server 2.14.6 Linux amd64 archive checksum verified against official release SHA256SUMS: `61c3d55f69f61ec616b75782250936445f2819e9e5f2ae6159b10a31abd2200c`; binary is temporary, not globally installed.
- User explicitly authorized autonomous implementation/testing after reviewing the five behavior priorities; no additional execution-choice prompt required.

## Usability follow-up: command hints and autocomplete

User request: the command should have hints/autocompletion. Use Pi's native `getArgumentCompletions`, not a custom editor. Show all existing subcommands with concise descriptions and `[group]` / `[1–100]` argument hints. Suggest cached group labels for `join` and common or explicitly typed valid allowances for `arm`. Completion is pure: no connection, broker reads, join, arm, or model calls while typing. Populate the group-label cache only from normal human command reads/selections, and discard it on shutdown/reload or backend replacement. Execution still requires the existing confirmations.

- [x] Add failing extension/native-provider tests for subcommand replacement, argument hints, no-side-effect completion, group-cache updates, and lifecycle clearing.
- [x] Add `src/completions.ts`, wire registration/cache callbacks through the existing UI, and run the focused tests green.
- [x] Document Tab completion; run aggregate tests/typecheck and native-provider checks against installed Pi. Keep the active background broker and existing user sessions untouched; the user can `/reload` to load the change.

Validation: the four new tests failed first because no completion callback was registered, then passed with the implementation. Aggregate suite: **125 tests**, including **43 messaging tests**, zero failures/skips; typecheck and `git diff --check` passed. Native command loading, suggestions, hints, and Tab replacement also passed under installed Pi **0.84.1**, with no broker connection or model calls. The owned background broker remains running; no sessions were reloaded or joined.
