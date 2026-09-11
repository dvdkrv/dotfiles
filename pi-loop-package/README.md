# pi-loop-package

Pi package that explicitly starts a bounded prompt loop and re-sends its prompt only after the agent chooses to continue.

## Install

```bash
pi install ./pi-loop-package
```

## Usage

```bash
/loop start Investigate flaky tests and keep iterating until root cause is found --max 12
```

Other commands:

```bash
/loop status
/loop stop
```

`--max` counts agent runs, including the initial run. It must be an integer from 1 through 100 and defaults to **12**. For example, `--max 1` permits the initial run but no continuation.

## How continuation works

While one active iteration awaits a decision, the agent can call `loop_control` exactly once as its sole final tool call:

- `action: "continue"` records one decision; after the run fully settles, the extension queues one follow-up iteration.
- `action: "stop"` ends the loop.

The result is terminating, so the control call does not cause another paid model response inside the same run. The extension disables `loop_control` immediately after a decision and whenever no loop is active; its prompt guidance is absent at those times. Duplicate, parallel, stale, and inactive calls terminate without persisting another state transition.

If the agent settles without choosing continue, the loop stops. `agent_settled` is the only continuation scheduler, so one decision can queue at most one next run.

## Safety stops

The loop stops before another continuation when:

- the configured run maximum is reached;
- known context usage reaches **85%** (including a high-water mark observed before automatic compaction);
- the next follow-up cannot be queued;
- a reload resumes state after a continue decision was persisted but before scheduling was known to complete.

The context guard is not a monetary budget. Pi does not expose stable cross-provider pricing/session-cost controls to this extension. Choose a lower explicit `--max` for expensive models or large contexts.

## Session lifecycle

Active state waiting for a decision is restored in the same saved session, but restoration never triggers inference automatically. Interrupted continuation decisions fail closed and require a new explicit `/loop start`. New/replacement sessions with no loop state start inactive and cannot inherit an in-memory loop from the previous session.
