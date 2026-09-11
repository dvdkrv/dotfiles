# Pi Loop Prompt-Cache Stability Review

Date: 2026-09-11
Branch: `fix/pi-loop-cache-stability`
Base: `main` at `b24eba13232b1e5f54fdb646950ae3fded2e3cee`

## Scope reviewed

The change removes loop-owned active-tool mutations and active-only tool prompt metadata while preserving terminating decisions, one-decision scheduling, run/context bounds, fail-closed restoration, and queue-error handling. It does not add token/cost budgets, change messaging behavior, configure provider cache retention, run a paid model, or activate the package.

The acceptance contract is structural: warm automatic continuations must expose identical system prompts and canonical tool definitions. Conversation messages necessarily grow, and provider-reported cache hit percentage is not guaranteed.

## Direct review

- `pi-loop-package/extensions/loop.ts` contains no `setActiveTools`, `promptSnippet`, or `promptGuidelines` reference.
- `ACTIVE_LOOP_INSTRUCTION` is one module constant. It contains no prompt, iteration, maximum, context usage, timestamp, or reason.
- Explicit start, restoration, request preflight, and continuation admission observe `getActiveTools()` and fail closed without modifying it.
- The synchronous `decisionRecorded` latch remains set before persistence. Valid, duplicate, stale, and inactive tool results remain terminating.
- Iteration arithmetic, strict 1–100 parsing, default 12, 85% context high-water logic, and enqueue handling are unchanged.
- The real Pi SDK test captures `systemPrompt` and ordered `{ name, description, parameters }` tool definitions. Two scripted requests compare equal and a third request is fatal.
- The messaging coexistence fixture rejects any active-tool mutation while preserving its previous behavioral assertions. Messaging production code is unchanged.

## Authorized bounded GLM review

The user authorized cheap headless agents. A read-only `ai-gw-baseten/baseten/zai-org/GLM-5.2` review examined the specification and full package diff with reasoning disabled, no tools, no retries, a 2,600-token output cap, and a 90-second timeout. It completed normally using 9,546 tokens. The gateway catalogue reported zero usage cost; this report does not claim verified provider billing.

### Findings and dispositions

1. **Important label, test-strength gap — accepted:** The unavailable-tool request-preflight test proved the first hook returned no suffix and stopped state, but did not invoke the hook again. A second invocation assertion now proves stopped state cannot leak a stale instruction later in the same process.
2. **Minor — interrupted restoration checks uncertainty before availability:** No change. A persisted continue decision represents an uncertain scheduling boundary and intentionally receives the stronger fail-closed interruption reason. It is inactive afterward regardless of tool availability.
3. **Minor — explicit per-field schema assertions suggested:** No change. Node strict `deepEqual` on ordered plain objects already compares tool count, order, names, descriptions, and parameter schemas. The capture intentionally removes non-provider runtime methods.
4. **Minor — external changes to unrelated active tools:** No change. Such a change can alter Pi's base prompt, but the accepted goal is zero loop-owned mutation. The extension's suffix remains constant; external prompt/tool mutation is outside its control.

No Critical or unresolved Important production defect remains.

## Verification evidence

- RED: the 19-test unit suite failed in 17 cases against the old dynamic implementation, including forbidden `setActiveTools` calls, active-only prompt metadata, and unavailable-tool behavior.
- GREEN: all 19 unit tests passed after the stationary implementation.
- Acceptance RED: substituting the pre-fix extension under a restoration trap made both the real SDK request test and messaging coexistence test fail for the expected active-tool mutations.
- Acceptance GREEN: both tests passed against the new implementation.
- The real SDK acceptance passed against repository Pi 0.82.0 and installed Pi 0.84.1 using only a scripted provider.
- The final aggregate broker-gated suite passed 169 tests with zero failures/skips; TypeScript, ShellCheck, repository rendering, and whitespace checks passed.
- All 20 loop tests passed under Node 22.19.0 and 24.20.0 after the final review assertion.

## Observational limitations

A first loop request can be cold. The first request entering loop mode and the first request after leaving it can differ because the constant loop suffix appears or disappears. Cache expiry, eviction, provider behavior, and newly appended assistant/tool output can lower the hit ratio. `PI_CACHE_RETENTION=long` can help supported providers retain an unchanged prefix longer but cannot repair prompt mutation.

No live SAP pane/session was read, changed, reloaded, or used for acceptance testing during this implementation.
