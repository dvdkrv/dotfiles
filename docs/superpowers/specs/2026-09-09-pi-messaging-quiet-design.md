# Quiet Pi messaging — approved follow-up

The user chose quiet after reviewing enqueue-and-continue behavior and deferring incoming messages until a natural stopping point. This supersedes the original busy-session steering default. Implement inline under the existing autonomous implementation/testing approval; no coordinator/task engine, urgent mode, automatic join/arm, or broker lifecycle work.

## Delivery

- While `ctx.isIdle()` is false (including active work, retry, compaction, and queued continuation), do not start a new reservation. Messages normally remain queued in the broker without spending allowance.
- Idle sessions may still wake automatically within the human-armed shared allowance. Existing notifications, agent lifecycle events, and five-second non-model heartbeat reconcile readiness.
- Send all admitted messages with Pi's `deliverAs: 'followUp'`, never `steer`. If the session becomes busy while an asynchronous reservation is in flight, that already-admitted message waits in Pi's follow-up queue until the current work completes, rather than interrupting between tool steps. The credit is already spent in this narrow race; no refund/replay or new local pending-delivery mechanism is introduced.
- Pi 0.82.0 and 0.84.1 both define `isIdle` as the inverse of their full `_isAgentRunActive` state, and `sendCustomMessage` queues follow-ups when that state is active. `_runAgentPrompt` sets it before its first await. Use these existing semantics rather than inventing another idle flag.
- Preserve generation/peer fencing after reservation and the unresolved-attempt gate. Pause/leave still cannot retract an already admitted Pi message. A crash or lost acknowledgment remains uncertain, never grounds for automatic replay.
- A natural stopping point is completion of the current agent work run, not completion of an individual tool call. An agent that needs a reply must report its blocker and yield, not keep a polling/sleep loop alive. A separate continuously running loop extension can delay delivery; messaging does not control it.

## Outgoing flow and identity

- Sending waits for queue publication, not recipient processing. Its result tells the sender to continue its existing assignment rather than wait/poll or begin periodic updates.
- Stable tool guidance discourages polling, receipt acknowledgments, and periodic check-ins unless explicitly requested. Substantive blockers, contract changes, and required completion reports remain appropriate. These are model behavior guidelines, not a claim that the extension can enforce semantic intent or remove normal tool-cycle costs.
- Supply quiet-flow onboarding on the first eligible model request per joined participation. Naming guidance is available for at most the first **two** eligible requests, only while still using the session-ID default, so discovery and rename can be separate tool steps. Stop it earlier once named. Later requests receive compact current identity metadata only. Do not reset this window on another agent run. Disabled tools/non-TUI/unjoined states do not consume onboarding.
- This bounded setup window is a validation-driven refinement: a single transient hint disappeared after discovery, and live agents omitted naming. Two initial hints restored role naming without returning to indefinite per-request reminders. The explicit initial-setup exception in quiet guidance prevents confusing naming with unsolicited messaging.
- Self-renaming and peer discovery remain available at any time during explicitly joined work. Unknown roles keep the session-ID default; no additional naming inference is started. Rejoin uses a fresh routing ID and gets fresh onboarding.
- No other session's transcript is read or shared by the plugin. No new dependency, ledger schema, DTO migration, tool action, or allowance control is added.

## Validation

Test the busy/idle extension gate, follow-up delivery and idle-to-busy admission races, one-time onboarding with compact current identity thereafter, and no recipient waiting in send. Use real SDK sessions with a bounded scripted provider and deferred work tools to prove that messages remain queued/unused while busy and never appear between two tool steps. Exercise the race where a reservation completes after work begins, checking one spent credit and delayed observation. Run these tests on development and installed Pi, preserve existing failure/concurrency tests, and run the bounded cheap Flash smoke for role naming and exchange behavior.

Existing user sessions and their broker remain untouched. Users load the change with `/reload` and explicit rejoining; no re-arming or broker restart is required. No merge/push.
