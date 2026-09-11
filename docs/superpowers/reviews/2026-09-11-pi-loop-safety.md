# Pi loop fail-safe review

Date: 2026-09-11
Branch: `fix/pi-loop-safety`
Base: `main` at `257a385`

## Incident evidence

The user reported severe behavior in the `sap-erp-observability` tmux Pi pane. Read-only inspection showed 99.7% context usage and a displayed lifetime session total near $3,378. The 49 MB saved session was not modified. Analysis selected only loop-state metadata and aggregate entry types; it did not print conversation bodies.

The active branch contained 762 loop-state entries: one start, 13 active continue decisions, zero `continuedAt` transitions, iteration always zero, and 749 inactive stop writes. Of those stops, 597 repeated the same metadata-only reason. This directly reproduced the source-level failure mode: `loop_control` returned a normal tool result, so the same low-level model run could call it repeatedly before `agent_settled` ever incremented or enforced the maximum. The tool and its unconditional prompt guidelines also remained active outside loops, while inactive stop calls persisted another entry.

The footer total covers the long-lived session and is not attributed entirely to this extension. The repeated provider/tool cycle is nevertheless a confirmed major contributor and an unbounded defect.

## Implemented controls

- `loop_control` decisions return `terminate: true`.
- A synchronous volatile latch permits one persisted decision per iteration, including parallel-call races.
- The extension removes only `loop_control` from active tools while inactive or after a decision, preserving every other tool. It re-enables it only for an explicit start, restored waiting state, or one scheduled next iteration.
- Inactive, stale, and duplicate calls return terminating no-ops without errors or persistence.
- `agent_settled` is the sole scheduler and queues at most one follow-up.
- The default maximum is 12; explicit values are strictly limited to 1–100. The initial run counts.
- Known context usage at or above 85% stops continuation. `agent_end` records only the high-water percentage so auto-compaction cannot hide a dangerous value; it never schedules.
- Initial/follow-up enqueue failure finalizes the loop and disables its tool.
- Session startup resets volatile state before reading the new active branch, preventing cross-session inheritance.
- A restored continue decision at an uncertain scheduling boundary fails closed without automatic inference.

## Review findings and disposition

### Resolved

1. **High context could be hidden by compaction before settlement.** The initial implementation read usage only at `agent_settled`. A failing test demonstrated that a 91% `agent_end` followed by a 20% settled context would continue. The extension now retains the run's high-water percentage and the test passes while proving `agent_end` sends no message.
2. **Replacement sessions inherited in-memory loop state.** The old and initial fixed implementations scanned the new branch without resetting `state`. A failing regression started a loop, emitted `session_start` with an empty replacement branch, and observed the old loop still active. Startup now resets state/latch/high-water first.
3. **Messaging coexistence fixture lacked the newly used active-tool API.** The full aggregate suite caught this test integration gap. The fixture now models active-tool registration/toggling and context usage; it still proves messaging cannot reset or govern loop state.

### Reviewed, no change

- Pi only honors a terminating result immediately when all tools in that parallel batch terminate. If a model violates the sole-final-call guidance and batches another non-terminating tool, one ordinary provider continuation may occur; `loop_control` has already been removed and the decision latch is set, so the pathological repeated control cycle cannot recur. Scheduling still waits for full settlement.
- The 85% guard is a context bound, not a monetary budget. Stable cross-provider pricing and per-loop cost are not exposed as a reliable extension control surface. The lower default and hard run maximum provide deterministic additional bounds.
- Human stop cannot recall a follow-up already handed to Pi, but it makes state inactive; later settlement cannot queue another one. This matches Pi queue semantics.
- Restored active state awaiting a decision does not trigger inference. This preserves explicit user control while preventing automatic replay.

No Critical or unresolved Important finding remains.

### Authorized headless GLM review

After the initial verification, the user explicitly authorized cheap headless agents. A bounded read-only `ai-gw-baseten/baseten/zai-org/GLM-5.2` review examined the approved design and complete package diff. It consumed 12,353 tokens; the gateway catalogue reports zero pricing, so no monetary-cost claim is made. The response reached its 2,400-output-token cap after emitting four concrete claims. Each was checked against Pi source and tests:

- **Rejected claimed Critical active-tool corruption:** `loop_control` is uniquely registered and owned by this extension. Removing it during replacement-session reset is required, and `setControlEnabled(false)` performs no `setActiveTools` call when it is already absent.
- **Rejected claimed missed pre-compaction value:** Pi's `_runAgentPrompt()` receives `agent_end` before `_handlePostAgentRun()` invokes `_checkCompaction()`. Multiple low-level retries retain the maximum percentage, so the guard sees the pre-compaction high-water value.
- **Accepted parallel-test gap:** the latch was synchronous but the duplicate test invoked calls sequentially. It now uses `Promise.all` for simultaneous continue/stop calls and proves exactly one additional state entry with both results terminating.
- **Rejected duplicate-settlement defect:** Pi emits one `agent_settled` from `_runAgentPrompt()`'s `finally`. The existing adversarial second-settlement unit invocation intentionally stops conservatively, queues no duplicate, and cannot create the original runaway behavior.

## Verification

- **161 aggregate tests**, zero failures/skips under the mandatory isolated NATS broker gate.
- **14 loop tests**: 13 unit/lifecycle cases plus one real Pi SDK scripted-provider case.
- The loop suite passes on Node **22.19.0**, **24.20.0**, and primary Node 26.8.2.
- The real SDK test passes with repository Pi **0.82.0** and installed Pi **0.84.1**. It makes exactly two scripted provider requests (continue, then stop), records one settled continuation at iteration one, disables the tool at completion, and rejects any third request. No paid inference occurs.
- TypeScript, ShellCheck, repository/Chezmoi rendering checks, and whitespace checks pass.
- The pre-existing three dependency audit findings remain unchanged; no dependency was upgraded.

The affected SAP pane/session, global Pi settings, installed package, and all live messaging state remain untouched. Activation requires separate explicit approval and a Pi reload.
