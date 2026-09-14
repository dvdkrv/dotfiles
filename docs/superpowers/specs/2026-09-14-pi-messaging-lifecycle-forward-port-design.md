# Pi Messaging Lifecycle Forward-Port Design

## Status and scope

This design replaces the obsolete implementation shape on `feat/pi-messaging-lifecycle` with a clean forward-port from current `main`. The legacy branch remains untouched until this replacement is verified and integrated.

The work has two features:

1. automatically ensure the private local NATS broker is available when a Pi session starts; and
2. let a saved Pi session explicitly resume a stale or gracefully suspended messaging identity without losing its routing ID, role name, inbox, or finite-delivery state.

This is a prerequisite to extracting all Pi-specific code into the separate private `pi-tools` repository. Extraction, package consolidation, and dotfiles cleanup are separate later designs.

## Current baseline

Current `main` provides API-only identity, finite shared allowance, one unresolved outbound per sender, eight queued messages per recipient, queue-capacity reservation, atomic admission of up to eight recipient messages, publication high-water fencing, one combined Pi delivery turn, exact complete ordered batch receipts, quiet idle-boundary delivery, and conservative no-replay/no-refund behavior.

The forward-port must extend that baseline. It must not restore the removed dynamic context hook, single-message admission assumptions, mutable request prefixes, automatic participation, or old-client authority bypasses.

## Goals

- A Pi `session_start` can ensure one authenticated loopback broker without joining or delivering anything.
- The broker survives the Pi process that started it and retains the existing private JetStream data.
- Several Pi processes racing startup create one authority and one broker.
- Reload, quit, session replacement, and tree navigation preserve an explicitly resumable participation.
- Explicit human leave and revoke remain final.
- Resume preserves peer ID, role name, routing, durable consumer, queued inbox, message history, group counters, and allowance.
- A rotated private lease fences every participant-authorized mutation from an older process.
- Resume remains a confirmed human TUI action and never triggers a model turn.
- Existing batching, quiet delivery, and cache-stability guarantees remain intact.

## Non-goals

- Starting the broker at OS login or managing it through systemd, launchd, or tmux.
- Starting a remote listener or extending trust beyond the same-user loopback boundary.
- Automatically joining, resuming, arming, sending, reading a body, admitting work, or invoking a model.
- Taking over a peer that is still online.
- Combining historical inboxes or silently selecting among multiple candidates.
- Replaying, refunding, or partially retrying attempted messages or batches.
- Deleting stale peers automatically.
- Extracting packages or deleting design history in this branch.

## Architecture

### Broker lifecycle component

A focused broker-lifecycle module owns authenticated health probing, owner-only startup serialization, detached launch, bounded readiness, and private diagnostics. The extension factory remains process-, socket-, timer-, and context-mutation-free.

On `session_start`, the extension first detaches any runtime owned by the prior session generation, then calls the broker readiness helper. A healthy authenticated broker is a no-op. If no safe configuration exists, the helper creates one through the existing private configuration code; if an initialized configuration exists, its authority and data remain authoritative.

When the configured endpoint is unavailable, contenders coordinate through an owner-only non-symlink startup lock under the messaging directory. The winner probes again, resolves an explicitly supplied `NATS_SERVER` or `nats-server` from `PATH`, writes a private server configuration, starts NATS detached with output directed to a private diagnostic log that is truncated on each launch, and waits for authenticated stream validation. Other contenders wait for the same authenticated readiness instead of spawning.

Connection refusal and bounded timeout are the only conditions treated as broker unavailability. Authentication failure, authority mismatch, unsafe permissions, incompatible streams, an occupied port, or initialized-state loss fail closed. A newly spawned child is stopped if authoritative initialization fails; existing configuration and data are retained for inspection. The broker is never stopped on Pi shutdown.

A startup failure leaves Pi usable and produces at most one concise TUI warning outside model context. A later human `/messages` command may make one fresh readiness attempt before connecting. There is no background polling or automatic participation retry.

### Participation lifecycle component

The authoritative control ledger advances from version 1 to version 2. Public message envelopes and broker configuration stay version 1 because their wire shapes do not change.

A stored peer gains:

- `suspended: boolean`, meaning the participation remains authorized and routable but has no graceful runtime owner; and
- `leaseId: UUID`, the current private runtime generation.

Public peer data exposes identity and derived presence only. It never exposes `leaseId`. Presence is:

- `online`: active, not suspended, heartbeat age at most 30 seconds;
- `stale`: active, not suspended, heartbeat age over 30 seconds;
- `suspended`: active and gracefully detached;
- `left`: inactive after explicit leave or revoke.

Active stale and suspended peers remain valid recipients and retain an active-peer slot. This preserves routing and queued capacity until a human resumes or revokes them.

## Ledger migration

The first upgraded backend that reads a v1 ledger performs a compare-and-set migration before exposing a usable backend. Migration validates the complete legacy shape and preserves authority ID, sequence, groups, rounds, limits, used credits, peers, role names, timestamps, messages, request keys, hashes, queue states, per-message attempts, batch-relevant ordering, and terminal fields.

Every stored peer receives a fresh valid lease. Legacy active peers become active and non-suspended; legacy inactive peers remain inactive and non-resumable. Migration publishes no message, creates no peer, grants no allowance, and changes no message state.

A CAS conflict causes a reread and validation of the winner's v2 state. An uncertain write fails closed. V1 clients reject v2 rather than bypass leases, which is intentional fencing during rollout.

## Lease authority and batching

A backend retains a private `{ peer, lease }` pair. `backend.peer`, peer listings, summaries, UI models, tool responses, envelopes, logs, and persisted Pi messages contain no lease.

Every participant-authorized state mutation checks the exact active, non-suspended peer and lease inside the authoritative CAS operation:

- heartbeat and role rename;
- send and request-key deduplication;
- reservation and atomic `admitBatch`;
- exact complete ordered `observeBatch` receipts;
- graceful suspend;
- explicit leave.

Human administrative operations such as arm, pause, revoke, inbox inspection, cancellation, dismissal, and prune keep their existing explicit TUI authorization and do not receive participant leases.

Batch semantics do not change. Queued messages reserve allowance without incrementing `used`; each admitted batch member consumes one credit and has its own attempt ID; no recipient with an existing attempt receives a new batch; and partial or reordered receipts observe nothing.

If an old process pulled bodies before another process resumed the peer, its admission CAS fails the rotated lease. It must not ACK those bodies; normal broker redelivery makes them eligible for the current owner. If admission committed before resume, the messages remain attempted and are never replayed or refunded.

## Durable consumer binding

Fresh join and resume share one consumer-binding operation. It validates an existing `peer_<id>` durable or creates it with the exact current stream, subject filter, deliver-all, explicit-ack, five-second acknowledgment wait, and eight-message pending limit.

Resume validates or recreates the durable before changing the peer to online. The subsequent CAS rechecks group ID, peer ID, exact saved session ID, active status, suspended/stale status, and current liveness, then rotates the lease and updates `lastSeen`. Two concurrent resumers cannot both win.

If local session generation changes after the resume CAS, cleanup suspends only the newly obtained lease. It never finalizes the participation, creates a replacement peer, recalls attempted work, or refunds allowance.

## Explicit resume and human UX

`/messages join <group>` remains the only join/resume entry point and requires a saved Pi session plus TUI confirmation.

For the exact current session ID and selected group:

1. Any online match blocks resume. There is no takeover prompt.
2. Active stale or suspended matches become candidates; inactive peers are excluded.
3. One candidate is identified in the confirmation.
4. Several candidates require a numbered picker showing role, session attribution, lifecycle state, last-seen age, and metadata-only unresolved count.
5. The chosen durable is validated and the resume CAS rechecks all conditions.
6. Only when no resumable candidate exists may confirmation create a fresh peer.

Repeated join while already locally joined to the same group/session is an informational no-op. Joining another group still requires explicit leave.

Reload, quit, session replacement, and tree navigation call `suspend`, invalidate the old lease, clear local runtime state, and require explicit rejoin. `/messages leave` and human revoke mark the peer inactive and non-resumable. A suspension that cannot reach the broker closes locally and naturally becomes stale; it is not converted into final leave.

Human status and pickers may report all four lifecycle states. Agent `peer_message peers` continues to omit inactive peers and may report `online`, `stale`, or `suspended` for active recipients, but cannot join, resume, revoke, arm, or read queued bodies. Startup and resume add no hidden context, tools, prompt text, or model calls. Existing tool definitions and prompt guidance remain byte-stable.

## Error handling and recovery

- Unsafe configuration, token mismatch, authority mismatch, incompatible stream state, or missing initialized data fails closed.
- Uncertain CAS or publication outcomes never retry automatically and never restore allowance.
- Online duplicates require returning to the existing session or explicit human revoke.
- Multiple stale/suspended records remain separate until the human chooses or revokes them.
- Active stale/suspended peers count toward the 16-peer bound; reaching the bound requires explicit cleanup.
- Attempted messages remain human-dismissible under the existing no-refund policy.
- Prune continues to preserve unresolved work and live-sender deduplication.
- Broker tokens, leases, message bodies, and conversation bodies never enter diagnostics or test output.

## Testing

All tests use isolated agent directories, broker processes, ports, ledgers, sessions, and process groups. They never connect to or alter the live broker, groups, memberships, messages, allowance, or sessions.

Required coverage includes:

- exact v1-to-v2 migration preservation and concurrent migration;
- malformed/wrong-authority/unsupported ledgers failing closed;
- lease checks for heartbeat, rename, send, admission, batch receipt, suspend, and leave;
- real-process stale-owner and held-pull fencing;
- queued batches surviving resume and attempted batches remaining blocked;
- one-candidate, multiple-candidate, online-block, cancellation, lifecycle, and late-dialog UI races;
- API-only identity and absence of a context hook after resume;
- unchanged queue reservation, sender/recipient backpressure, publication high-water, quiet delivery, and exact combined receipts;
- healthy broker no-op, missing broker startup, caller-independent lifetime, eight-process startup contention, stale-lock handling, private permissions, occupied ports, missing binary, and state-loss failures;
- extension discovery/factory inertness and infrastructure-only `session_start`;
- real Pi SDK lifecycle tests without inference;
- complete mandatory-broker repository tests on the minimum Node 22.19 runtime and current Node 24;
- TypeScript, ShellCheck, repository rendering checks, production-only dependency installation, and `git diff --check`.

A fresh independent review must find no unresolved Critical or Important issue before integration.

## Integration and rollout

Implementation occurs on the fresh forward-port branch. The legacy lifecycle branch remains unchanged until the replacement is signed, reviewed, merged, pushed, and verified.

No implementation or test step reloads a live Pi process, migrates the live ledger, changes a live group, starts or stops the live broker, or applies package changes. Those are separate human-controlled operations.

After merge, the human performs rollout at a safe idle boundary:

1. pause new admissions and let current Pi work settle;
2. close every v1 messaging-enabled Pi process so none can race the migration;
3. ensure the managed NATS binary is installed and apply the upgraded package;
4. open the first upgraded Pi session and allow its authenticated connection to migrate the ledger;
5. reopen other saved sessions, explicitly run `/messages join <group>`, and choose each intended identity;
6. inspect and explicitly revoke unwanted historical peers;
7. separately approve stopping the manually managed broker and validating first-Pi autostart against retained data.

If a v1 process was accidentally left open, migration deliberately fences it; the human must close/reload it before continuing. The implementation never closes, reloads, or steers a live process automatically.

Rollback after ledger migration requires v2-aware code. Old v1 clients and data recreation remain deliberately blocked.

Only after successful rollout does the separate `pi-tools` extraction begin. The extracted repository starts from the final current source as a clean, organization-neutral, single-package snapshot; the dotfiles repository then consumes a signed pinned release and removes Pi implementation code and tracked design documents from its current tree.
