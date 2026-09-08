# Local Pi messaging — design for implementation review

Date: 2026-09-08
Status: **Detailed proposal; awaiting user review before implementation planning.**
Scope: the messaging slice only. The user accepted the overall separation and sequencing, not every new mechanism below. Project management, knowledge storage, and intent promotion remain separate, evolving designs.

## 1. Purpose

Let explicitly connected Pi sessions on one machine exchange addressed messages without the user copying them between terminals. Preserve independent contexts and human-assigned work boundaries. Make automatic activity finite, inspectable, and stoppable.

Deliver a locally owned `pi-messaging/` package in this repository. Do not install a third-party messaging/orchestration package, run a service, launch other agents, or manage projects/worktrees.

### Requirements carried forward

- One OS user, one machine, local storage; no messaging network listener.
- Explicit participation; independent sessions do not discover or share content globally by default.
- Automatic handoff to open idle/busy participants after human opt-in.
- A shared finite budget, initially 12 automatic handoffs per explicitly armed group round. Replies, restarts, and time cannot replenish it.
- Human-visible status, attribution, pause, and recovery from ambiguous delivery.
- No automatic launch of closed sessions or inherited participation for new/forked sessions.
- Small reviewable code and no additional third-party runtime dependencies beyond Pi's existing packages.

### New implementation proposals requiring review

1. Use a private SQLite file through Node's built-in `node:sqlite`, rather than implementing transactional queue/budget updates with multiple JSON files and stale locks.
2. Use bounded polling, rather than filesystem notifications, for transport discovery.
3. Treat handoff as an **at-most-once attempt per message ID**, not guaranteed delivery. Never automatically replay an ambiguous attempt.
4. Do not retain membership across reload, restart, or session replacement. Joining again creates a new peer identity; old inboxes remain inspectable, not automatically redirected.

## 2. Non-goals

No task planner, coordinator agent, broadcast tool, role presets, transcript sharing, automatic spec acceptance, memory extraction, embeddings, Obsidian integration, Git operations, worktree operations, tmux automation, cross-machine transport, attachment copying, encryption service, or global token accounting.

This is not a sandbox against malicious code running as the same OS user. It is not a claim that 12 handoffs bound the work performed inside an individual agent run, or inside another extension's loop.

## 3. Verified Pi/runtime constraints

The repository pins Pi development packages to 0.82.0; the installed interactive Pi is 0.84.1. The published 0.82.0 declarations and installed 0.84.1 implementation both expose:

- `pi.registerCommand`, `pi.registerTool`, `pi.registerMessageRenderer`;
- `pi.sendMessage(message, { triggerTurn, deliverAs })`;
- `session_start`, `session_shutdown`, `session_info_changed`, `session_before_tree`, `agent_start`, `agent_end`, and `message_end` events;
- session IDs and session-file references through `ctx.sessionManager`;
- TUI notification, selection, status, and component APIs.

`pi.sendMessage` returns **void**. The installed core calls an async `sendCustomMessage` internally and reports failures through the extension runner; the caller does not receive a completion promise. With `deliverAs: "steer"`, streaming sessions queue the custom message. With `triggerTurn: true`, idle sessions can start a run. The API does not provide a per-custom-message withdrawal operation.

Consequences:

- Count an admission/attempt, not a successful response.
- A custom-message `message_end` event can establish that Pi observed that message, not that the model reasoned correctly, completed a task, or durably synced its transcript to disk.
- Do not call `sendUserMessage`: peer text must not impersonate the human or enter slash-command routing.
- Pause and leave cannot retract an already admitted message from Pi's own queue.

Runtime baseline: Node >=22.19.0, consistent with installed Pi's engine requirement. Node 22.19 documents `node:sqlite` as active-development API; use only `DatabaseSync`, prepared statements, and explicit transactions. The local Node 26.5 runtime was probed successfully; CI currently uses Node 24. Implementation must test the supported minimum and CI runtime rather than assume identical native-module behavior. If SQLite is unavailable, disable this extension with a clear diagnostic; do not install a fallback package.

## 4. Storage choice

Alternatives considered:

| Choice | Benefit | Cost |
|---|---|---|
| Individual JSON inbox files and lock directories | Direct inspection with ordinary tools | Atomic budget + message claim requires a transaction protocol, crash recovery, and lock ownership rules |
| **Built-in SQLite** | One transaction for allowance, claim, and recipient ownership; OS releases locks after process death | Binary runtime file, minimum runtime/API compatibility to test |
| Daemon or socket broker | Central coordinator | Extra lifecycle/security surface; unnecessary for this scale |

Choose SQLite for operational state only. This does not change the proposal to keep future knowledge/spec documents in ordinary files.

### Location and permissions

`<agent-dir>/messaging/transport.sqlite3`, where `agent-dir` is `PI_CODING_AGENT_DIR` or `~/.pi/agent`.

- Resolve the configured agent directory once; do not take storage paths from messages, group names, model arguments, or repository settings.
- Create the messaging directory owner-only (`0700`) and database owner-only (`0600`). Validate existing messaging directory/database ownership and permissions; fail rather than silently use an unsafe path.
- Reject symlinks for the messaging directory, database, and SQLite sidecar paths. A user-configured agent-directory alias may be canonicalized before these checks.
- The directory is private runtime state, outside repositories/vaults. Never commit or export it automatically.
- Use prepared statements, foreign keys, `journal_mode=DELETE`, `synchronous=FULL`, and `busy_timeout=50` ms. Small rollback journals avoid a persistent WAL/checkpoint service.
- No network calls, subprocesses, `loadExtension`, arbitrary SQL tool, or remote content execution.
- No database connection or timer is created by the extension factory. Lazily open storage on a human command; start delivery polling only after joining.

Use a schema version (`user_version=1`). Initialize a genuinely new database atomically. Unknown versions, corruption, unsafe paths, and failed schema checks disable new handoffs and present a diagnostic. Never replace a damaged database with an empty armed one.

## 5. Identity and participation

### Identifiers

- **Group ID:** extension-generated UUID; stable across sessions.
- **Group label:** human shorthand, unique locally, 1–48 lowercase letters/digits/hyphens starting with a letter. Not a filesystem path.
- **Peer ID:** fresh UUID for each explicit join. Identifies this session runtime's participation, not a reusable role name.
- **Session ID:** Pi's session UUID, recorded as metadata. Not sufficient to route messages by itself.
- **Message ID:** generated UUID, with a separate sender/request idempotency key.

Names are display metadata only. Routing requires the exact group and peer IDs. Resolve a human label through a picker; never silently choose between ambiguous names.

V1 supports one joined group per session runtime. Joining another requires leaving the current one. This limits accidental cross-project sharing and avoids cross-group forwarding behavior.

### Human-only joining

`/messages join` lets the user select/create a group and choose a display name (defaulting to Pi's session name or a short session ID). Joining an armed group explicitly discloses the remaining allowance and asks for consent to automatic handoffs. Joining a paused group records participation but does not arm it.

Every join creates a new peer ID. Membership is not restored from session entries, environment variables, a prior process, or a fork. Old messages are addressed to old peers and are never silently reassigned, even when a display name or Pi session ID matches.

Creating/joining a group does not grant or reset budget. Human commands can inspect old groups and inboxes without joining them or sending their contents into the model.

### Presence

Record peer ID, group ID, Pi session ID, local session-file reference, display name, PID, joined time, last heartbeat, and active/left state. Do not collect transcripts, credentials, repository content, or user prompts.

Heartbeat every 5 seconds while joined. Display presence as:

- `online`: active record with heartbeat no older than 30 seconds;
- `stale`: active record with an older heartbeat;
- `left`: explicit leave/shutdown or human revocation (show the reason separately).

Staleness is informational, not permission to claim another peer's inbox or reset state. A delayed old process can only act under its own still-active peer ID; human revocation makes future claims fail. No PID-based automatic takeover is needed because new joins have new peer IDs.

## 6. User and agent interfaces

### One human command: `/messages`

Use standard Pi TUI controls, a compact status footer, and an inbox/details view. Do not build a chat dashboard framework.

| Subcommand | Behavior |
|---|---|
| `/messages` or `status` | Show selected/joined group, peers, allowance, and queue counts; offer group selection when unjoined |
| `join [group]` | Select/create and explicitly join a group |
| `leave` | Stop this runtime's new admissions, mark peer left, and stop its polling |
| `arm [N]` | Confirm a **new** round, default 12, integer 1–100; non-additive and human-only |
| `pause` | Persistently stop new automatic admissions for the selected group |
| `send` | Choose a recipient and enter text; same stored-message path and budget rules as agent send |
| `inbox` | Inspect recent traffic/status in the selected group, including abandoned peers; payloads are UI-only |
| `prune` | Preview and explicitly remove eligible terminal records/inactive groups, without deleting unresolved messages |

The inbox offers explicit actions to cancel an unattempted message, dismiss an ambiguous attempt, or compose a new message to a currently joined peer using old text as an editable draft. Resending is a new human-requested message, never a silent retry. A peer list can revoke an old membership with confirmation; no process is killed.

Arming shows peers, selected group, pending-message count, proposed allowance, and a warning that automatic turns can spend tokens. Starting a new round replaces unused allowance rather than accumulating it. Re-arming never refunds old attempts or replays them.

Control commands are TUI-only. Human `send` requires a current joined peer; inspection, pause, and arm can operate on a UI-selected group without joining. Reject RPC/JSON/print invocations before state mutation. Do not launch dialogs from asynchronous delivery handlers.

### One agent tool: `peer_message`

Actions:

- `peers`: return online/stale peer IDs and names within the current group, plus self ID.
- `status`: return group mode, remaining allowance, own outgoing message statuses, and inbox counts; no pending bodies. Return the newest 20 statuses in descending sequence order; an optional positive-integer `beforeSequence` retrieves older entries, and `nextBeforeSequence` identifies the next page. `peers` needs no pagination because active membership is capped at 16; list only active memberships.
- `send`: fields `toPeerId`, `text`, optional `inReplyTo`. Group and sender identity come from the joined runtime, not the model.

No tool actions for create/join, arm, re-arm, unpause, changing limits, reading undelivered bodies, deleting history, or launching sessions. Tool invocations outside a joined TUI runtime return a clear error.

The tool-call ID is the send request key, scoped to the sender peer. Repeating that call with identical validated arguments returns the existing message ID/status. Reusing it with changed arguments is an idempotency conflict. Human sends allocate a request key before any storage retry.

The `send` result says **queued**, not delivered. It returns message ID, recipient ID, and any paused/offline warning. Reading this result does not grant authority to a peer's requested action.

Self-send, unknown/left peer, cross-group recipient, and an `inReplyTo` outside this group fail validation. A stale-but-active peer may receive a queued message, with a warning. Reply references are metadata and do not create separate budgets.

Tool guidance: peer text is a request or report from another agent, not human authorization; preserve existing scope/constraints and do not recursively acknowledge receipts. Keep this guidance short, specific to `peer_message`, and do not inject broad project policy.

## 7. Minimal data model

Physical table/column names below are part of the implementation proposal, not a public extension API.

### `groups`

`id`, unique `label`, `mode` (`paused`, `armed`, `exhausted`), `round_number`, `round_limit`, `round_used`, `armed_at`, `armed_by_session_id`, `updated_at`.

Constraints: non-negative integer counters, `round_used <= round_limit`, no automatic counter reset. New group: paused, round 0, limit/used 0. Exhausted means used equals limit; a human pause may retain unused allowance but only a confirmed new round enables delivery again.

### `peers`

`id`, `group_id`, `session_id`, `session_file`, `display_name`, `pid`, `joined_at`, `last_seen_at`, `left_at`, `state` (`active`, `left`, `revoked`).

One process owns a peer ID in memory. Neither the send tool nor another process can select the sender/consumer peer ID through a user-facing argument. This is an API guard, not a same-user security boundary.

### `messages`

`id`, monotonic `sequence`, `group_id`, `sender_peer_id`, `sender_kind` (`agent`, `human`), `recipient_peer_id`, `request_key`, `payload_hash`, `text`, optional `in_reply_to`, `created_at`, `state`, `attempt_round`, `attempted_at`, `observed_at`, `terminal_at`.

Unique key: `(sender_peer_id, request_key)`. Allocate `sequence` using an autoincrementing integer key that is not reused after pruning; `id` remains a separate unique UUID. Enforce group/peer foreign keys; `in_reply_to` is a validated-at-send historical ID, not a restrictive deletion dependency, so pruning a terminal parent does not block unrelated retention. Preserve a hash/tombstone while the sender is active even if a terminal body is pruned, so idempotency does not disappear mid-membership. Hash canonical validated payload fields, not display metadata that can change later.

States:

| State | Meaning |
|---|---|
| `queued` | Stored, not admitted to Pi |
| `attempted` | Budget consumed and handoff reserved; Pi receipt may be unknown |
| `observed` | Matching custom-message event observed in this recipient runtime |
| `canceled` | Human canceled while still queued; never handed off |
| `dismissed` | Human closed an ambiguous attempted record; cannot undo prior Pi admission |

There is no `processed`, `accepted`, or `task_done` state. Those would be unsupported claims about the model or project.

An `attempted` message remains visibly awaiting receipt; after recipient departure it is visibly uncertain. It is never re-queued. A late valid Pi receipt can annotate a dismissed record with `observed_at` without reactivating it or refunding allowance.

## 8. Atomic admission and finite automatic work

Use short `BEGIN IMMEDIATE` transactions for state changes. Never hold a transaction while awaiting input, invoking Pi, performing asynchronous work, or waiting for a model.

Before admission, defer if Pi is in a retry/compaction/settling gap: require either `ctx.isIdle()` or an active agent run tracked by `agent_start`/`agent_end`. Do not mistake every non-idle state for a streaming session that accepts steering. A concurrent runtime change can still make a handoff fail; the uncertain-attempt rule remains necessary.

A receiver poll atomically:

1. Checks that its in-memory runtime generation is current and its peer is active.
2. Checks the group is armed and has remaining allowance.
3. Checks this peer has no unresolved `attempted` handoff.
4. Selects its oldest queued message by monotonic sequence.
5. Moves it to `attempted`, records the current round, and increments `round_used` once.
6. Marks the group exhausted if this consumes the last allowance.
7. Commits.

Immediately after a successful commit, with no intervening `await`, the same runtime attempts exactly one call to:

`pi.sendMessage(customPeerMessage, { triggerTurn: true, deliverAs: "steer" })`.

The durable admission is the linearization point. A pause/revocation committed before admission prevents it. A pause/revocation committed after admission cannot retract it; the UI must state that already admitted messages may still appear. At most one unobserved handoff is admitted per receiver.

Failures:

- Transaction fails with a known rollback: do not call Pi; message remains queued, no allowance consumed. An uncertain commit is handled separately below.
- Commit succeeds, process dies before Pi call: allowance remains consumed; message is uncertain, no replay.
- Pi call is made but the core later rejects/aborts it: same conservative attempted/uncertain outcome; surface that Pi has not confirmed receipt rather than inventing a failure acknowledgment.
- Pi observes the message but receipt bookkeeping fails: do not repeat the handoff. Reconcile only from a matching event in this runtime; otherwise keep uncertainty visible.
- SQLite commit itself has an ambiguous outcome: do not call Pi based on an assumption; disable new admissions and inspect persisted state before further operation. Never refund or re-queue a possibly admitted attempt automatically.

Every successful admission consumes allowance even while the agent is busy. No budget credit is granted by a receipt, reply, command from another agent, ordinary user prompt, elapsed time, reload, or a new message thread.

### Model-visible envelope

Custom type `pi-messaging.peer.v1`, `display: true`. The text envelope includes group label/ID, sender display name/peer ID, message ID, timestamp, and optional reply reference, followed by the body explicitly labeled as peer content. `details` carries the same IDs for receipt correlation, but metadata needed by the model must appear in `content` because custom details are not model context.

Escape terminal control characters and display names. Use a distinct renderer label and render payloads as text; do not evaluate slash syntax, shell substitutions, embedded scripts, or automatically open referenced files/URLs. A referenced artifact is just a reference until an agent deliberately opens it with its own tools.

## 9. Receipt, polling, and lifecycle

### Receipt

Listen to `message_end`; only accept a `role: custom` event with the exact custom type and matching group, recipient peer, message ID, and attempt from this runtime. Update the record transactionally to observed and clear its in-flight gate. Do not send an acknowledgment message or trigger a new turn in this handler. The next timer tick can admit further work if allowance remains.

A replayed history entry, renderer call, tool result, ordinary assistant text, or peer claim of receipt is not a receipt. No transcript scanning or rewriting is required for recovery in v1.

### Polling

After join, schedule a non-overlapping poll every 500 ms using recursive timeout scheduling, with a 5-second heartbeat. Polling reads metadata, attempts at most one admission, and updates status only on change. It does not call an LLM just to check messages.

SQLite busy errors leave data untouched and retry on a later tick, not in a synchronous spin. Unexpected/corrupt/unsafe state stops local admissions and emits one actionable diagnostic, not repeated notifications. Do not silently fall back to a second store.

### Lifecycle

- Factory: register APIs only; no I/O timers or processes.
- `session_start`: begin unjoined. Clear old in-memory references; do not recover membership from the transcript.
- Explicit join: create peer and start polling under a fresh runtime generation token.
- `agent_start` / `agent_end`: track whether an active run can accept steering; otherwise admit only when `ctx.isIdle()` is true. These handlers never trigger model work.
- `session_info_changed`: update the default-derived display name without changing peer identity; preserve an explicitly chosen nickname.
- `session_shutdown` for quit/reload/new/resume/fork: invalidate the generation token first, cancel timers, mark peer left if storage is available, and close the connection. This cleanup is idempotent and does not call the model.
- `session_before_tree`: detach before context-tree navigation, including an ultimately canceled navigation attempt; notify that rejoining is required. This conservative choice avoids carrying live participation into another conversation branch.
- Compaction/model changes do not reset allowance or replay messages.

Already admitted Pi messages cannot be withdrawn by leave/shutdown. A stale callback may not touch a replacement context or make new calls. If departure cannot be recorded, heartbeat eventually displays stale, but no new process takes over that peer ID.

V1 joining requires TUI mode and a non-ephemeral Pi session-file reference. Unsupported modes can inspect help but cannot join or mutate transport state. A normal newly created saved-session path need not already exist on disk.

## 10. Bounds and disk policy

Fixed v1 safety limits; only the per-round allowance is selected in the arm UI:

- Body: at most 8 KiB UTF-8, non-empty after trimming.
- Display name: at most 64 Unicode code points, no terminal control characters.
- At most 16 active peers per group and 32 retained groups.
- At most 64 queued/unresolved-attempted messages per group.
- At most 2,000 retained message/tombstone records and 512 peer records globally.
- Agent status/list responses: at most 20 records per call, with explicit pagination, truncated display fields, and no raw pending-message bodies.

Check quotas inside the same transaction as insertion/join; concurrent writers cannot exceed them. Reject with a clear queue/store-full error rather than deleting unresolved work. Idempotent retries return the original result before quota checks, without allocating a new record.

On human commands and send operations, bounded maintenance can remove terminal records whose sender is inactive and whose terminal timestamp is older than seven days, then remove unreferenced inactive peers. Preserve queued/attempted records, current round counters, and active-sender idempotency tombstones. Bodies of old terminal records may be cleared while retaining their identity/hash when the sender is still active. Never prune in the middle of an admission transaction in a way that changes its eligibility.

`/messages prune` previews and confirms removal of eligible terminal records from inactive senders regardless of age, plus groups with no active peers or unresolved messages. It cannot refund counters or recreate groups silently. To clear abandoned unresolved work, the human must explicitly cancel/dismiss it first. A newly recreated group is a new ID and starts paused.

SQLite may retain reusable free pages and temporarily create a rollback journal; the logical caps are not advertised as an exact byte-level disk quota. No duplicate text log, automatic transcript archive, attachment store, or backup daemon is created.

## 11. Boundaries with future project management

Publish small read-only DTOs under `pi-messaging/public`:

- `GroupRef { id, label }`;
- `GroupSummary { group, mode, roundNumber, limit, used, remaining, onlinePeers, pendingCount }`;
- `PeerSummary { id, groupId, sessionId, displayName, presence }`;
- `MessageStatus { id, state, createdAt, attemptedAt?, observedAt? }`.

Provide a read-only `readGroupSummary(agentDir, groupId): GroupSummary | null` that does not create storage, join, arm, or load message bodies. Return `null` for an absent store or unknown group; throw a typed error for unsafe/corrupt/unsupported state or a busy database. Read a consistent snapshot and compute `remaining` from the persisted limit/used counters. Do not perform SQLite hot-journal recovery through this read-only interface; report that writable recovery is required. This is the sole non-Pi integration operation required by slice 1. Caller uses the same explicitly configured local agent directory; no message-controlled path is accepted.

The future project extension may store a `GroupRef`, display this summary, and offer the user a join action through the messaging command flow. It must not parse private tables or bypass human joining/arming. It does not inherit transcripts or assume that a message receipt means a work item is complete.

No dependency on `pi-worktree-core` is needed for messaging. Shared DTOs do not require a generic cross-extension service framework.

## 12. Implementation structure and repository integration

Proposed source boundaries:

- `src/contracts.ts`: IDs, DTOs, limits, validation, payload hashing, error codes; no Pi lifecycle or UI.
- `src/store.ts`: SQLite schema, bounded reads, transactional sends/claims/receipts, quotas and pruning; no Pi APIs.
- `src/runtime.ts`: joined-peer lifecycle, generation fencing, polling, receipt correlation, and the Pi handoff adapter; injectable clock/scheduler for tests.
- `src/ui.ts`: command parsing and small standard TUI views; no SQL or budget arithmetic.
- `src/public.ts`: the read-only future-project interface.
- `extensions/messaging.ts`: thin registration/wiring.

No additional production npm dependencies. Declare imported Pi packages and `typebox` as peers, following local package policy. Tests can use the existing pinned `jiti` and Node test runner.

During implementation, integrate the package into root workspaces/lockfile, TypeScript includes, the local package installation list, and Pi settings template. Update the repository's explicit package-list tests. Keep directory/state exclusions consistent with Chezmoi. Do not upgrade the repository-wide Pi pins as an incidental change. If actual compatibility testing exposes a need for an upgrade, report it as a separate decision.

This document itself does not install or register the package.

## 13. Acceptance tests

### Deterministic storage and multi-process tests

- New group starts paused; joining and ordinary prompts cannot arm it.
- Several real processes contend for a group with allowance 12: at most 12 unique messages become attempted, counters match attempts, and the remainder stays queued. With sufficient queued messages and simulated valid receipts releasing per-recipient gates, the test must reach exactly 12, not pass merely because delivery never ran.
- A process killed before transaction commit leaves no claimed message or consumed allowance; a kill after commit leaves one consumed uncertain attempt.
- Concurrent duplicate request keys create one message; changed payload under the same key errors.
- Self-send, forged sender/group arguments, cross-group replies/recipients, quota races, oversized UTF-8 bodies, malformed IDs, and SQL-like strings are handled without changing invariants.
- Pause versus admission has the documented transaction-order semantics.
- All restart/fork/rejoin operations preserve prior counters and never replay attempted messages.
- Missing/insecure/symlinked paths, unsupported schema, corrupt database, SQLite busy/full errors, and uncertain commits fail closed.
- Pruning cannot delete queued/attempted work, erase live-peer idempotency, exceed caps under concurrent insertion, or reset allowance.

### Pi adapter tests with fakes

- Exact tool and command surfaces; no model-accessible arm/join/control path.
- Calls use custom peer messages, `triggerTurn: true`, `deliverAs: "steer"`, never `sendUserMessage`.
- No handoff before a committed reservation, even if receiving events synchronously.
- Matching live receipt clears the gate; foreign, historical, duplicated, or malformed receipts do not cause a turn or budget change. Retry/compaction/settling gaps defer admission rather than spending allowance on a predictably rejected handoff.
- One unresolved attempt blocks further admission for that recipient without blocking other peers.
- Factory/unjoined/non-TUI modes start no timers or database mutation.
- Reload/new/resume/fork/tree navigation invalidates old callbacks and requires joining again.
- Pause/dismiss acknowledges that already admitted messages cannot be recalled.
- Sender labels and body content cannot escape the displayed peer envelope; tool output and UI remain bounded on narrow terminals.
- Coexistence with `pi-loop-package`: messaging does not change its state, and its separate loop budget is not falsely described as covered by messaging.

### Opt-in live smoke test

Two interactive Pi sessions in temporary directories, with a temporary agent config/state root, a named test group, and an allowance of 2. Ask A to send a short question to B, B to answer A, and then attempt one additional handoff. Verify visible peer attribution, two consumed admissions, the third queued, no automatic re-arm, and pause/reload behavior. Keep the model and credentials user-selected; do not create network services or persist secrets. Record observable counters/events, not an unsupported claim that the model processed every queued message exactly once.

The storage/adapter tests are the deterministic acceptance gate. Live model behavior is a compatibility smoke test, not a substitute for concurrency tests.

## 14. Review and implementation boundary

Review especially the SQLite/runtime requirement, non-restored membership, old-inbox handling, allowance semantics, and pause/crash limitations. These are explicit design choices, not facts inferred from an earlier conversational yes.

After the user approves this scoped document, write a separate implementation plan with test-first tasks and review checkpoints. Until then, no extension code, dependency installation, settings activation, project-management code, or vault changes are authorized by this document.

## References inspected

- Installed Pi 0.84.1 `docs/extensions.md` (read earlier in full), `docs/session-format.md`, `docs/tui.md`, and `docs/packages.md`.
- Installed examples `examples/extensions/file-trigger.ts` and `message-renderer.ts`.
- Installed `dist/core/extensions/types.d.ts` and `dist/core/agent-session.js`, particularly `sendCustomMessage` and `_bindExtensionCore`.
- Published Pi 0.82.0 declarations: <https://unpkg.com/@earendil-works/pi-coding-agent@0.82.0/dist/core/extensions/types.d.ts>.
- Node 22.19 SQLite API: <https://nodejs.org/download/release/v22.19.0/docs/api/sqlite.html>.
- Local `package.json`, `tsconfig.json`, `tests/pi-package-dependencies.test.mjs`, `pi-task/package.json`, `pi-loop-package/extensions/loop.ts`, and existing worktree extension/tests for lifecycle conventions.

Verification performed while drafting: checked both Pi API versions' relevant declarations, inspected installed dispatch behavior, and opened an in-memory database with built-in SQLite on Node 26.5.0. No extension behavior has been implemented or tested yet.
