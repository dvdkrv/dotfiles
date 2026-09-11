# Pi loop fail-safe lifecycle design

Date: 2026-09-11
Status: approved by the user (scope A)

## Incident and root cause

The `sap-erp-observability` Pi session reached 99.7% context usage and displayed a lifetime total near $3,378. Metadata-only inspection of its active branch found 762 `loop-state` entries: one start, 13 active `continue` decisions, zero settled continuations, iteration permanently at zero, and 749 inactive stop writes. No conversation bodies were needed for this diagnosis.

`loop_control` currently returns an ordinary tool result. A model that calls `continue` receives that result and remains in the same low-level agent run, where the unchanged prompt still directs it to call `loop_control`. `agent_settled` cannot increment or enforce `maxIterations` until this tool cycle ends. The tool is also globally active while no loop exists, and inactive `stop` calls persist another state record. Together these defects permit repeated paid model/tool cycles with no iteration progress.

## Goals

- One agent decision produces at most one persisted continue/stop transition per loop iteration.
- A control decision terminates the current automatic model follow-up so `agent_settled` can advance the loop.
- `loop_control` is absent from the active tool set and its prompt guidelines while no decision is expected.
- Stale, duplicate, parallel, or inactive control calls cannot append state or trigger another model request.
- Default loops are bounded to 12 agent runs; explicit `--max` accepts only 1–100.
- A loop stops instead of queuing another run when context usage is at least 85%.
- Reloading an interrupted persisted continue decision fails closed rather than guessing whether its follow-up ran.
- The extension changes only its own tool activation and preserves all other active tools.

## State and tool lifecycle

The persisted `LoopState` shape remains compatible. `shouldContinue: true` means one continue decision was durably recorded for the current iteration. A volatile `decisionRecorded` latch prevents duplicate calls in the same process.

The extension registers `loop_control`, then synchronizes only that tool's active state:

- inactive loop: remove `loop_control` from the current active-tool list;
- newly started/restored active loop awaiting a decision: add it without changing other tools;
- first control decision: set the latch synchronously, persist once, remove the tool, and return `terminate: true`;
- next iteration: clear the latch, add the tool, then queue exactly one follow-up prompt;
- final stop: keep the tool removed.

A stale control invocation while inactive or after a recorded decision returns a terminating, non-error no-op with no persistence. This handles already-issued parallel calls without causing an error-driven model follow-up. Prompt guidance explicitly says to invoke `loop_control` once, as the sole final tool call.

## Settled transition and bounds

`agent_settled` is the only continuation scheduler. If no decision was recorded, it stops the loop. If stop was chosen, the tool execution already made the loop inactive. For a continue decision it checks, in order:

1. the next iteration does not reach `maxIterations`;
2. known `ctx.getContextUsage().percent` is below 85;
3. one follow-up can be queued.

The initial run counts toward the maximum. State starts at iteration zero; each accepted continue increments before the next run. `--max 1` therefore permits only the initial run. Unknown context usage does not invent a failure, but known usage at or above 85% stops with a visible warning and persisted reason.

If follow-up enqueue throws, the extension stops and persists the failure instead of remaining active. A restored active state with `shouldContinue: true` represents an interrupted decision/scheduling boundary and is finalized inactive with an explicit reason; the human may start a new loop. Restored active state still awaiting a decision remains active but does not automatically trigger inference.

## Human controls and compatibility

`/loop start <prompt> [--max N]`, `/loop stop`, and `/loop status` remain the only human commands. The default changes from 100 to 12. Values outside 1–100 are rejected with a warning and no state/message mutation. Starting a loop explicitly enables the control tool and sends one initial user message. Human stop is idempotent and does not append repeated inactive stop records.

Existing valid state entries remain readable. No session is rewritten or pruned. The affected SAP pane remains untouched; loading the fix requires a later explicit `/reload`, after which its latest inactive state keeps the tool disabled.

## Testing

Unit tests cover active-tool preservation, terminal results, one-decision persistence, duplicate/parallel and inactive no-ops, strict max parsing, default/max enforcement, 85% and unknown context behavior, settled single scheduling, enqueue failure, restoration, and idempotent human stop.

A scripted-provider test uses Pi's real SDK with inference credentials disabled. The first model response calls `continue`, the second calls `stop`, and both tool results terminate. The test asserts exactly two provider requests, one queued continuation, iteration advancement, no repeated decision calls, and an idle final session. Run against repository Pi 0.82.0 and installed Pi 0.84.1.

No live model, affected session mutation, package activation, merge, or push occurs during implementation.
