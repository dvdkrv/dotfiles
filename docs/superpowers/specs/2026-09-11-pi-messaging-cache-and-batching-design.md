# Pi Messaging Cache Stability and Bounded Batch Delivery Design

Date: 2026-09-11
Status: Approved for planning
Branch: `fix/pi-messaging-cache-batching`

## Problem

Pi messaging currently adds a transient `pi-messaging.identity.v1` custom message through the `context` hook. On every model request, the hook removes the previous copy and appends a refreshed copy to the conversation tail.

That ordering is incompatible with the default OpenAI Codex cached WebSocket continuation. Pi AI can send only the new input delta when the previous request input plus its response is an exact prefix of the next request input. Messaging instead changes the order from:

```text
history, transient identity, assistant response
```

to:

```text
history, assistant response, tool results, refreshed transient identity
```

The continuation check fails and Pi sends the full context. Metadata-only analysis of three affected sessions found cache collapses adjacent to `pi-messaging.peer.v1` delivery, including 96.8% to 1.9% in the local crawler session and 35.8% to 1.8% in the SAP observability session. The fixed low cache-read floors are consistent with repeatedly losing continuation after messaging participation begins. No conversation bodies were inspected.

Messaging also admits and delivers one peer message per model turn. Multiple senders can queue several turns for one recipient, and a sender can fill the queue even when the current human-granted allowance has no capacity left.

## Goals

- Remove all dynamic messaging identity and onboarding state from model context.
- Make ordinary incoming peer delivery append-only and compatible with provider continuation.
- Require agents to obtain current messaging identity and peer state through the `peer_message` API.
- Coalesce all currently deliverable messages for one recipient into one bounded model turn.
- Prevent queued messages from exceeding the current round's unspent allowance.
- Limit each recipient to eight queued messages.
- Limit each sender to one unresolved outbound message.
- Preserve finite shared allowance, explicit human control, private bodies, conservative uncertainty handling, and no automatic replay or refund.
- Validate request shape and batching with scripted providers only; never require paid inference.

## Non-goals

- Guaranteeing a provider-reported cache hit rate.
- Removing incoming peer content from model context; the recipient must receive that content to act on it.
- Automatic joining, arming, agent launching, assignment, or role inference.
- Token or monetary budgets.
- Urgent delivery, steering, polling, or delivery during active work.
- Changing private trust boundaries or exposing broker credentials, leases, or message bodies through metadata APIs.
- Merging or activating the separate messaging lifecycle branch.

## Model and context boundary

The messaging extension will not register a `context` hook. It will remove `pi-messaging.identity.v1`, `onboardedPeer`, `namingHintsLeft`, and all transient identity-message construction.

The `peer_message` tool remains registered with a stationary name, parameter schema, description, `promptSnippet`, and `promptGuidelines`. Its static guidance explains that agents should use the API for identity and peer discovery, avoid polling and unsolicited updates, and preserve their human-assigned scope. Static tool metadata contains no group, participant, allowance, timestamp, role name, or other runtime value.

`peer_message peers` will explicitly return the current participant's routing ID, Pi session ID, and display name, in addition to bounded active-peer metadata. `rename`, `status`, and `send` continue returning operation-specific state. Joining starts no inference, and join, leave, heartbeat, rename, reload, and resume do not inject or rewrite model messages.

Incoming peer content remains a displayed `pi-messaging.peer.v1` custom message sent through Pi with `triggerTurn: true` and `deliverAs: "followUp"`. It is persisted once at its natural append-only position. A batch is one custom message containing multiple clearly delimited peer messages.

## Queue capacity and sender backpressure

### Reserved capacity

A queued message reserves one current-round allowance slot but does not spend it. Define current queue capacity as:

```text
available queue capacity = group.limit - group.used - queued message count in the group
```

A new send is rejected when this value is zero or negative. This means never-armed and exhausted groups cannot accept new messages. A paused group may accept messages only when it still has unspent, unreserved capacity; pausing controls delivery rather than erasing an already granted allowance.

Admission changes a message from `queued` to `attempted`, increments `group.used`, and therefore replaces its queue reservation with a spent credit. Canceling a still-queued message releases capacity. Attempted, observed, and dismissed messages never refund allowance.

Idempotent retries are checked before capacity and sender gates. A retry with the same sender request key and payload returns the original record even when no new capacity exists; a conflicting payload still fails.

### Rearming

Human arming continues to replace rather than accumulate the round allowance. Rearming is rejected if the requested limit is smaller than the number of already queued messages in the group. The human must choose a sufficient limit or cancel queued messages first. This preserves the invariant that every queued message is backed by a current-round slot.

Unresolved attempts from an older round remain attempted and are never replayed or refunded. They do not become queued reservations in the new round.

### Sender and recipient bounds

A sender may have at most one outbound message in `queued` or `attempted` state. It may send again only after that message becomes `observed`, `canceled`, or `dismissed`. The original idempotent retry remains allowed while unresolved.

A recipient may have at most eight `queued` messages. This retains the existing 8 KiB per-message limit and bounds a normal combined delivery to approximately 64 KiB of peer text. Sends beyond the recipient bound fail immediately. The existing group and global retention bounds remain in force.

These checks are ledger-CAS checks, so concurrent senders cannot oversubscribe allowance or queue limits.

## Atomic batch admission

`MessagingBackend.reserve()` becomes a bounded batch reservation operation returning an ordered array of zero to eight individual reservations. Batch membership is defined by messages available to the recipient when reservation begins; messages published after that boundary wait for the next idle delivery.

The NATS backend pulls recipient-filtered messages in publication order, acknowledges terminal replays, and collects up to eight valid queued envelopes. All envelopes are validated against authoritative ledger metadata before admission. Missing bodies remain inspectable queued records and are not invented.

One ledger CAS transaction:

1. revalidates active participation, group identity, armed mode, remaining allowance, recipient, queue state, and absence of an older unresolved recipient attempt;
2. selects the still-queued candidates in publication order;
3. marks every selected message `attempted`;
4. assigns a distinct attempt ID and current round to each message;
5. increments `group.used` once per selected message; and
6. exhausts the group exactly when `used == limit`.

The operation returns either one admitted batch or no admitted messages. A pause, leave, allowance change, or conflicting ledger update ordered before the CAS prevents admission. Messages that became terminal during collection are acknowledged but not admitted. A malformed envelope fails the operation rather than delivering a partial untrusted batch.

NATS acknowledgments remain transport bookkeeping rather than model receipts. Admitted and terminal bodies are acknowledged after the authoritative CAS. Deferred queued bodies are negatively acknowledged for later delivery. Broker replay cannot grant a second reservation because the ledger no longer says `queued`.

No durable batch record or ledger version migration is needed. Each message retains its existing individual attempt metadata.

## Runtime delivery and receipts

The runtime stores every individual reservation before calling Pi. It then makes one synchronous host-delivery call containing:

- a batch header identifying the content as peer requests/reports rather than human authorization;
- the number of messages;
- one metadata block per message with sender, sender routing ID, recipient routing ID, message ID, creation time, and optional reply reference; and
- one escaped peer-content block per message.

The custom-message `details` field carries the ordered list of public receipt correlations. It never contains broker tokens or private lifecycle leases.

The runtime still starts reservation only while `ctx.isIdle()` is true. If work starts while reservation is in flight, the already-admitted combined message enters Pi's follow-up queue and waits for the current work to settle. It never steers between tool calls.

On matching `message_end`, the runtime validates the complete ordered correlation list and performs one batch observation CAS. Every matching `attempted` member becomes `observed`; already dismissed members retain their terminal state but may record observation, matching existing semantics. A missing, duplicated, reordered, partial, or forged correlation rejects the whole receipt.

After successful observation, senders whose messages were included are no longer blocked. A subsequent idle wake may admit messages that arrived after the previous batch boundary.

## Conservative failures and recovery

- If envelope validation fails, deliver nothing and stop automatic messaging.
- If the admission CAS outcome is uncertain, deliver nothing, stop automatic messaging, and consume no assumed replay or refund. The ledger may contain attempted records.
- A crash after successful batch admission but before the Pi call consumes every admitted credit and leaves every member attempted.
- A crash after the Pi call but before observation also leaves attempted records.
- Uncertain or failed batch observation stops automatic messaging; it does not redeliver the custom message.
- Human inbox recovery remains per message. Each attempted member can be inspected and dismissed individually.
- A recipient with an unresolved attempted batch remains admission-blocked until the batch is observed or all blocking attempts are resolved by the human.
- Sender backpressure remains conservative: an attempted outbound blocks that sender until observation or explicit human resolution.
- Existing queued records that predate these limits are preserved. They drain in bounded batches when allowance permits or remain available for human cancellation; the implementation never deletes or rewrites them merely to satisfy the new steady-state bounds.

## Cache-stability contract

After this change, messaging owns no runtime-dependent system-prompt text and no transient context transform. Tool definitions and their ordering remain unchanged while the package configuration is unchanged. Incoming peer batches are ordinary append-only conversation entries.

The acceptance target is zero avoidable messaging-owned request-prefix mutation. It is not a promise of a particular cache-hit percentage: cold requests, expiry, eviction, compaction, provider routing, model changes, and newly generated output remain external factors.

The scripted acceptance test will model the exact OpenAI Codex continuation precondition: the prior request input plus converted response items must be a prefix of the next request input after an incoming peer batch and subsequent tool cycle. It will also assert that no `pi-messaging.identity.v1` item is request-visible.

## Compatibility with messaging lifecycle work

Implementation starts from `main` in the isolated `fix/pi-messaging-cache-batching` worktree. The separate `feat/pi-messaging-lifecycle` branch remains unmerged and inactive.

The lifecycle branch currently contains the same transient context hook and will require the accepted cache/batching changes before any future rollout. That integration will preserve private leases and mutation fencing: leases remain backend-only and never enter batch details, tool output, custom messages, or UI metadata. Its preserved durable consumers must be validated against the new batch-capable consumer configuration.

Updating or rebasing the lifecycle branch is separate from merging or activating it and requires an explicit later step.

## Testing

### Policy tests

Test that:

- never-armed and exhausted groups reject new sends;
- paused groups accept only reserved capacity already backed by the current limit;
- queued counts reserve capacity without incrementing `used`;
- canceling queued work releases capacity;
- attempted, observed, and dismissed records do not refund credits;
- rearming below the queued count fails without mutation;
- same-key retries remain idempotent after gates close;
- one sender cannot create a second unresolved outbound;
- one recipient cannot exceed eight queued messages;
- concurrent sends cannot oversubscribe any bound;
- batch admission is ordered, atomic, and increments allowance by batch size; and
- batch observation rejects incomplete or forged correlation.

### Real broker tests

Using isolated NATS stores, test:

- mixed-sender batches in publication order;
- batch sizes of one and eight;
- allowance smaller than available recipient messages;
- concurrent send and admission races;
- pause and leave ordered around batch CAS;
- terminal-body replay acknowledgment;
- broker restart with attempted batch members;
- missing body handling;
- lost admission acknowledgment; and
- no automatic replay or refund after uncertainty.

### Extension and runtime tests

Assert that:

- no `context` handler is registered by messaging;
- no identity custom message is generated;
- `peers` returns explicit current self metadata;
- one runtime delivery contains every admitted envelope exactly once;
- one matching Pi message observes the complete batch;
- partial, duplicate, reordered, and forged batch details fail;
- busy work defers admission;
- an idle-to-busy race queues one combined follow-up; and
- no path calls `setActiveTools()`.

### Scripted Pi SDK acceptance

Use real Pi sessions and isolated brokers with scripted providers only. Prove that multiple senders can queue one message each, one idle recipient receives one combined custom message, and exactly one provider turn is triggered for that batch. Capture canonical request-visible messages and verify append-only continuation shape without making a paid provider request.

Run against repository Pi SDK 0.82.0 and installed Pi SDK 0.84.1, plus supported Node 22.19 and 24.20 environments where available.

### Repository verification

Run aggregate tests, mandatory isolated broker tests, TypeScript, ShellCheck, repository checks, whitespace checks, and signed-commit verification. Existing live groups, messages, allowances, broker persistence, and Pi sessions must not be read through bodies or modified by tests.

## Rollout

The implementation and verification branch does not reload Pi, rejoin agents, restart the live broker, merge, or push without explicit authorization. Existing sessions require a human-controlled reload to stop using the old context hook. A later observational cache check should use metadata and usage counters only.
