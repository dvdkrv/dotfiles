# Pi Loop Prompt-Cache Stability Design

Date: 2026-09-11
Status: Implemented, pending rollout
Branch: `fix/pi-loop-cache-stability`

## Problem

The fail-safe loop extension prevents runaway control cycles, but it removes `loop_control` after each decision and re-adds it before the next iteration. The tool also defines `promptSnippet` and `promptGuidelines`. Pi documents that tool removal uses the full active-tool fallback and that activating a tool with active-only prompt metadata rebuilds the system prompt. Both changes can invalidate a provider's cached prompt prefix.

This matches the observed SAP synthetic-staging crawler session: after a continue decision and the following disable/re-enable boundary, its cache hit rate fell from 35.2% to 3.4%, then remained near 1.8%. Only a 3,328-token prefix was retained while roughly 180,000 tokens were repeatedly uncached. Dynamic loop-tool mutation is the strongest concrete explanation.

## Goal

The loop extension must cause zero avoidable prompt-cache invalidation. Across warm automatic continuations, the request-visible tool definitions, their ordering, and the loop-specific system-prompt text must remain byte-stable.

This design does not promise a 99% provider-reported hit rate. The first request is cold, caches can expire or be evicted, and every iteration adds an uncached conversation tail. Large tool results and provider behavior can lower the ratio even when the prefix is preserved correctly. Provider cache rate is observational rather than a test gate.

## Scope

Included:

- eliminate every loop-owned active-tool mutation;
- remove active-only loop prompt metadata;
- retain structured, terminating `loop_control` decisions;
- inject one constant loop instruction only while a loop is active;
- fail closed when the tool is unavailable;
- preserve all existing iteration, context, session, and enqueue safety bounds;
- prove stable request structure with scripted real Pi SDK tests.

Excluded:

- token or monetary budgets;
- provider configuration or `PI_CACHE_RETENTION` changes;
- live paid-model cache-rate gates;
- changes to Pi messaging;
- package activation, Pi reload, or modification of the SAP session/pane.

The messaging extension does not call `setActiveTools()`. Its static tool metadata is cacheable while the active set remains unchanged. Its transient identity and onboarding context is appended at the conversation tail and is therefore a separate concern, not the loop's repeated prefix invalidation.

## Design

### 1. Stationary tool schema

`loop_control` remains registered and the loop extension never calls `pi.setActiveTools()`. Registration makes the tool available under normal package configuration; explicit human or external configuration can still disable it.

Remove `promptSnippet` and `promptGuidelines` from the tool definition. Keep one static description that explains the tool's data contract and says it is valid only when the system prompt declares an active loop. The name, description, parameter schema, and ordering remain unchanged across loop boundaries.

The fixed schema adds a small constant token cost to requests where the package tool is active. That constant cost is preferable to repeatedly invalidating a much larger cached prefix.

### 2. State-dependent instruction with constant content

`before_agent_start` appends a single constant instruction when and only when loop state is active and the tool is available. The text contains no prompt, iteration number, maximum, context percentage, timestamp, reason, or other changing value.

The first loop request may differ from the preceding non-loop request because the loop instruction appears. Every warm continuation receives the same instruction and tool definitions. After the loop stops, the next human request may differ once because the loop instruction disappears. These entry and exit transitions are intentional; there is no mutation at an iteration boundary.

“Byte-stable request structure” means equality of the request-visible system prompt and canonical tool definitions. Conversation messages necessarily grow as assistants and tools produce output and are not expected to be byte-identical.

### 3. Tool availability and ownership

The extension observes the active tool list but never changes it:

- `/loop start` checks that `loop_control` is active before persisting state or queuing the initial prompt. If unavailable, it warns and does nothing.
- `before_agent_start` checks again. If an external actor disabled the tool after start, the loop stops and sends no loop instruction for that request.
- `agent_settled` checks before admitting a requested continuation. If unavailable, it stops before queuing another automatic request.
- `session_start` restores waiting state only when the tool is available. Otherwise it persists a stopped transition and requires an explicit restart.
- Re-enabling the tool later never resumes or starts a loop automatically.

This preserves human and external tool configuration. The extension cannot silently override `--exclude-tools`, a preset, or another extension.

### 4. Decision safety without dynamic gating

The existing synchronous `decisionRecorded` latch remains the mutation fence. The first valid decision sets the latch before persistence. All `loop_control` results retain `terminate: true`.

Because the schema stays active, inactive, stale, and duplicate calls remain possible at the provider interface. They return terminating no-ops without persistence, scheduling, allowance, or state reactivation. The static tool description tells the model not to call the tool unless the current system prompt declares a loop active.

This may terminate one unrelated model run if a model invents an inactive call. It is the conservative alternative to returning a normal tool result that could trigger another paid provider cycle. It cannot start a loop or create repeated state transitions.

### 5. Existing bounds remain authoritative

The change does not alter:

- default maximum of 12 runs;
- explicit maximum range of 1 through 100;
- initial run counting toward the maximum;
- one decision and at most one continuation per iteration;
- 85% known-context high-water cutoff;
- terminating control results;
- fail-closed interrupted continuation restoration;
- initial and follow-up enqueue failure handling;
- session replacement state reset.

## Data flow

1. The human runs `/loop start <prompt> [--max N]`.
2. The command validates syntax, limits, and current tool availability.
3. It persists active state and queues the initial prompt without changing active tools.
4. `before_agent_start` appends the constant active-loop instruction.
5. The model performs work and calls `loop_control` once as its final tool.
6. The tool synchronously records a stop or continue decision and returns a terminating result without changing active tools.
7. `agent_settled` enforces decision, run, context, tool-availability, and enqueue gates.
8. If admitted, it persists the next iteration and queues one follow-up. The next request receives the same system prompt and tool definitions.

## Error handling

All cache-safety failures are fail-closed:

- unavailable tool at explicit start: warn, no persisted start, no model request;
- unavailable tool before a run: stop and omit loop instructions;
- unavailable tool at continuation admission: persist stop, warn, no follow-up;
- unavailable tool on restoration: persist stop, warn, no inference;
- enqueue failure: retain existing stopped-state behavior;
- stale or duplicate tool invocation: terminating no-op, no persistence.

No failure path calls `setActiveTools()`.

## Testing

### Unit tests

Use a Pi fixture whose `setActiveTools()` throws immediately. Exercise startup, explicit start, continue, settlement, stop, stale calls, duplicate parallel calls, context cutoff, maximum cutoff, queue errors, restoration, and session replacement. Every path must pass without invoking the forbidden API.

Assert that:

- the registered tool has no `promptSnippet` or `promptGuidelines` properties;
- ordinary start/continue/stop leaves the complete active-tool array unchanged;
- an unavailable-tool start persists nothing and queues nothing;
- unavailable-tool restoration and continuation fail closed;
- active `before_agent_start` output is exactly equal across iterations;
- inactive `before_agent_start` returns no patch;
- no dynamic value appears in the injected instruction;
- all prior safety tests retain their semantics.

### Real Pi SDK acceptance

The scripted provider captures the complete request-visible system prompt and canonicalized tool definitions for two iterations. It returns continue and then stop. Assertions prove:

- exactly two provider requests and no third inference;
- identical system prompts across both warm loop requests;
- identical tool names, ordering, descriptions, and parameter schemas;
- `loop_control` remains active after completion;
- one continuation and one stop are persisted;
- no extension error occurs.

Run this test against repository Pi 0.82.0 and installed Pi 0.84.1, plus Node 22.19.0 and 24.20.0. The provider is scripted and incurs no paid inference.

### Repository regression

Run the aggregate test suite with its isolated mandatory NATS broker gate, TypeScript, ShellCheck, repository rendering checks, and whitespace checks. Update the messaging coexistence fixture only where its old expectations encode dynamic loop-tool removal; messaging behavior itself must not change.

## Rollout

Implementation occurs on `fix/pi-loop-cache-stability`. Completion stops before package reload, global activation, affected-pane mutation, merge, or push unless each is explicitly authorized. A later observational live cache check may use a fresh disposable session, but it is not required for correctness and must never reuse or mutate the affected SAP session.
