# Pi Messaging Broker Autostart and Participation Resume Design

## Approval and scope

The user approved two related lifecycle improvements after the quiet-messaging release:

1. Start the private broker automatically from the first Pi session after reboot and leave it running after that session exits.
2. Let an explicitly rejoining saved Pi session resume its prior messaging routing identity, role name, and inbox without leaving stale duplicate participation records.

The broker executable is provisioned through the repository's existing cross-platform Homebrew `Brewfile`; Homebrew stable is currently the already-tested NATS Server 2.14.6. Resume rejects a matching peer that is still online. If several resumable peers share the session ID, the human selects one. Explicit `/messages leave` and human revocation remain final and non-resumable.

This is infrastructure and participation lifecycle work. It does not add automatic group participation, arming, allowance, message replay/refund, agent launching, task orchestration, remote listeners, systemd, launchd, or tmux management.

## Problem and existing behavior

The original protocol deliberately treated every join as fresh membership. Reload, restart, resume, fork, and tree navigation detached the client; the next explicit join created a new peer ID. Graceful shutdown marked the old peer inactive. A crash, broker interruption, or lost leave operation could instead leave an active but stale peer, requiring manual revocation. Session IDs were human-visible metadata rather than routing aliases.

The observed `sap` group demonstrated the UX cost. Two saved session IDs each had an old active peer whose heartbeat was about 2.3 hours stale and a newer active peer using the same session ID. The old peers contained only observed messages in this instance, but the general design cannot assume an abandoned peer has no queued or uncertain work. Silently deleting it or redirecting messages would violate the existing delivery guarantees.

The current detached tmux broker also depends on a temporary binary and manual launch. It survives the terminal but not a reboot and is not a supported lifecycle mechanism.

## Goals

- A normal Pi startup ensures the local broker is available without requiring a separate terminal.
- The initiating Pi process does not own the broker's lifetime; closing it does not stop the broker.
- Multiple Pi sessions starting concurrently result in one broker, not competing initializations.
- Existing private configuration and JetStream data remain authoritative and persistent.
- A saved session can explicitly resume one stale or gracefully suspended same-group participation.
- Resume preserves peer ID, display name, inbox routing, retained history, and allowance.
- A rotated lease fences every operation from an older process.
- Human intent remains explicit: startup is automatic infrastructure, but join/resume and arm remain confirmed human actions.
- Failure remains conservative and inspectable.

## Non-goals

- Starting a service at OS login before Pi is used.
- Managing the broker with systemd, launchd, tmux, or a third-party supervisor.
- Automatically restoring group participation when a session opens.
- Automatically taking over a peer that still appears online.
- Combining multiple historical inboxes or choosing among multiple candidates silently.
- Replaying or refunding attempted messages.
- Deleting stale peers automatically.
- Supporting remote NATS endpoints or changing the same-user trust boundary.

## Architecture

### Components

1. **Broker provisioner** — add `brew "nats-server"` to `dot_Brewfile`. The existing Chezmoi package hook runs `brew bundle` on Linux and macOS. No custom binary downloader is introduced.
2. **Broker readiness helper** — a focused module owns authenticated health probing, startup serialization, detached NATS launch, private diagnostics, and bounded readiness waiting.
3. **Extension lifecycle hook** — `session_start` invokes the readiness helper. The extension factory remains free of processes, sockets, timers, and blocking work, as required by Pi's extension lifecycle guidance.
4. **Lease-aware participation backend** — a private participant lease accompanies a peer inside the backend but is omitted from public peer DTOs, UI, logs, model context, and message envelopes.
5. **Resume UI** — `/messages join <group>` recognizes peers with the same saved Pi session ID, rejects online duplicates, and offers an attributed picker when more than one peer is resumable.

Broker startup and participation resume are independently testable. A healthy manually launched broker satisfies the readiness helper, so the existing foreground command remains a supported diagnostic path.

## Broker startup lifecycle

### Trigger and normal path

On each `session_start`, including startup and reload, the extension performs a short authenticated probe using the existing private config. If it succeeds, no process or file is changed. This makes repeated session starts and concurrent Pi processes cheap and idempotent.

If the endpoint is unavailable, the caller attempts to acquire an owner-only startup lock under `~/.pi/agent/messaging/`. The winner rechecks readiness, prepares or validates the existing config, resolves `NATS_SERVER` when explicitly set or `nats-server` from `PATH`, then starts NATS as a detached process. Standard output and error go to a private broker log. The launcher waits for authenticated readiness and validates or initializes the authoritative streams before releasing the lock and returning. The NATS process is unreferenced and is not stopped by `session_shutdown`.

Concurrent losers never spawn immediately. They wait for bounded authenticated readiness, then return success. A startup lock older than the bounded startup interval can be reclaimed after another readiness check. The health probe, not a PID file, is authoritative; PID/start metadata is diagnostic only.

The same readiness helper runs before a human `/messages` command opens a backend. This permits a bounded retry after an earlier startup failure without adding heartbeat retries or background polling.

### Files and permissions

Existing owner-only rules continue for `messaging/`, `config.json`, `server.json`, and `data/`. New startup-lock, log, and optional process-metadata files are non-symlink owner-only files. The log is truncated on a new broker launch so restarts do not accumulate unbounded historical output; normal healthy probes do not touch it. Tokens never appear in logs, command arguments, notifications, or process metadata.

### Failure behavior

- Missing `nats-server`, spawn failure, readiness timeout, or invalid permissions leaves Pi usable and messaging unavailable. TUI sessions receive one concise, non-model warning with the remediation; non-UI runs log the extension error normally.
- Authentication failure, authority mismatch, or initialized configuration with missing broker state fails closed. The helper does not start a competing replacement authority or overwrite persistent state.
- A port occupied by another server is treated as an authentication/configuration error, not as permission to choose another port.
- If a newly spawned child fails authoritative initialization, that child is terminated; data/config are retained for inspection.
- A later Pi session or explicit `/messages` command can retry startup. Existing joined runtimes still stop conservatively after a broker disconnect and require explicit rejoin; no automatic message retry is added.

## Participation model

### Ledger v2 peer records

The control ledger advances from version 1 to version 2. Message envelopes and broker configuration remain version 1 because routing payloads and endpoint configuration do not change.

An internal peer record retains the existing identity fields and adds:

- `suspended: boolean` — the peer remains an authorized/routable participation but currently has no graceful runtime owner.
- `leaseId: UUID` — the current runtime generation for accidental split-brain fencing.

`active: true` continues to mean that the human has not explicitly left or revoked the participation. Active suspended and active stale peers remain valid message recipients, allowing messages to queue for their preserved inbox. Only an active, non-suspended runtime holding the matching lease may heartbeat, send, reserve, observe, rename, suspend, or leave. Human metadata reads and explicit administrative revoke remain separate controls.

Public peer results expose lifecycle state derived from `active`, `suspended`, and `lastSeen`, but never expose `leaseId`:

- `online`: active, not suspended, heartbeat age at most 30 seconds;
- `stale`: active, not suspended, heartbeat age over 30 seconds;
- `suspended`: active and gracefully detached;
- `left`: inactive after explicit leave/revoke.

### Migration

The first upgraded backend to read a v1 ledger performs one compare-and-set migration that preserves authority ID, sequence, groups, counters, peer IDs, names, timestamps, messages, attempts, and terminal states.

- Existing active peers become v2 active, non-suspended records with newly generated leases. Existing old clients do not know those leases and are fenced after the migration.
- Existing inactive peers remain inactive/non-resumable because v1 cannot distinguish an explicit leave from a prior graceful lifecycle detach.

CAS conflict handling rereads and validates v2 rather than replacing state. Unsupported/corrupt states still fail closed. The migration changes no allowance and publishes no message.

### Suspend, leave, and revoke

Pi lifecycle changes (`reload`, quit, new/resumed/forked session, and tree navigation) call **suspend**, not explicit leave. Suspend verifies the current lease, marks the peer suspended, invalidates that lease, retains `active: true`, and preserves its routing identity and inbox. If the broker is unavailable, the record remains active but eventually becomes stale and is eligible for the same resume flow.

Explicit `/messages leave` verifies the lease and marks the peer inactive/non-resumable. Human `/messages revoke` does the same administratively by selected peer ID and does not require the participant lease. Neither operation recalls admitted work or refunds allowance.

Repeated `/messages join` while the current backend is already joined to that same group and session is an idempotent informational no-op. Joining a different group still requires explicit leave first.

## Explicit resume flow

`/messages join <group>` remains a human command with confirmation. After selecting the group, it compares the current saved Pi session ID with peer metadata in that group.

1. If a matching peer is online, reject resume and identify it clearly. The user must return to it or explicitly revoke it; there is no takeover prompt.
2. Collect active matching peers that are suspended or stale. Explicitly left/revoked peers are excluded.
3. If one candidate exists, show it in the join confirmation. If several exist, show a picker containing role name, full/compact session attribution, lifecycle state, last-seen age, and unresolved recipient-message count. Do not read message bodies.
4. Validate or recreate the same durable consumer for the preserved peer ID. Its filter, delivery policy, explicit acknowledgment policy, acknowledgment deadline, and one-message pending bound must match exactly. A validation failure leaves the candidate suspended/stale rather than creating an apparently online zombie.
5. Only after that preflight, the confirmed resume performs one CAS operation checking group, session ID, peer ID, resumability, and current liveness again. It sets `suspended: false`, rotates `leaseId`, updates `lastSeen`, and returns the private lease to that backend instance before starting the normal runtime.
6. If no candidate exists, create a fresh peer and lease using the existing join confirmation behavior.

Two concurrent resumers cannot both win. The first CAS makes the peer online with a new lease; the second rereads and receives the online-peer rejection. Multiple historical candidates are never merged. Unselected records stay visible for explicit revoke/prune.

## Lease fencing and delivery safety

Every participant-authorized mutation carries the backend's private `{ peerId, leaseId }` and checks it inside the authoritative CAS operation:

- heartbeat and role rename;
- send and its request-key deduplication;
- reservation/admission;
- receipt observation;
- lifecycle suspend;
- explicit leave.

An old process using a rotated lease fails with a participation error. A stale CAS snapshot conflicts, rereads, and then fails the lease check. It cannot deactivate the resumed peer, send as it, consume allowance, or acknowledge its messages.

If an old durable consumer has already pulled a body, failed admission is not acknowledged, allowing normal broker redelivery. If an old runtime had already committed an admission before resume, the message remains `attempted`; resume never replays or refunds it. A late receipt carrying the old lease is rejected, leaving human dismissal as the existing conservative recovery mechanism.

Queued messages retain their recipient peer ID and become available to the resumed consumer. Sender-name snapshots and message envelopes remain immutable. Resume itself spends no allowance and triggers no model turn.

## Human and model UX

Human status and peer pickers use `online`, `stale`, `suspended`, and `left` consistently. Resume confirmations state that routing/name/inbox are preserved and that no allowance is granted. Multiple-candidate choices are numbered and fully attributed.

Agent `peers` discovery can expose the lifecycle state of active recipients but continues to use opaque peer IDs for routing. Lease metadata and resume controls are never agent tools. The model cannot start the broker, join, resume, revoke, or arm through `peer_message`.

The current quiet-delivery behavior is unchanged: busy recipients do not reserve new work, admitted race messages use Pi follow-up delivery, and senders enqueue and continue rather than poll.

## Bounds and cleanup

Active suspended/stale peers retain a participation slot because they remain authorized recipients. This avoids deleting an inbox merely to satisfy a bound. If the 16-active-peer group limit is reached, join/resume reports that the human must revoke unwanted peers. Resume of an already-active stale/suspended peer does not consume an additional slot.

Prune continues to preserve unresolved work and live-sender deduplication. It may remove eligible records only after explicit leave/revoke and existing terminal-history rules. This feature does not silently remove the observed `sap` records; after migration, active stale records are resumable and alternatives remain human-revocable.

## Testing

### Broker startup

- Extension factory and non-session resource discovery remain process-free.
- A healthy authenticated broker makes `session_start` a no-op.
- Missing config performs one private initialization and launches one detached broker.
- Multiple independent Pi/session processes racing startup result in exactly one NATS process and one authority.
- The broker remains reachable after the initiating Pi/session process exits.
- Foreground `npm run broker` coexists: autostart detects it and does not spawn.
- Missing binary, spawn failure, port collision, wrong authentication, readiness timeout, unsafe path, symlink, stale lock, and initialized-state loss all exercise fail-closed behavior.
- Startup lock, diagnostic metadata, config, and logs have owner-only permissions and contain no token.
- Tests use isolated agent directories, ports, and process groups and clean up only their own brokers.

### Resume and fencing

- v1-to-v2 CAS migration preserves every group counter and message/attempt field and never publishes or grants allowance.
- Old active peers migrate resumable; old inactive peers remain non-resumable.
- Graceful Pi lifecycle events suspend; explicit leave/revoke ends participation.
- Same-group repeated join is a no-op; cross-group join still requires leave.
- Online same-session resume is rejected, including a concurrent resume loser.
- One candidate appears in confirmation; multiple candidates require an attributed picker.
- Resume retains peer ID, role name, queued recipient IDs, history, and durable consumer.
- Queued work is admitted at most once after resume. Attempted work remains blocked and unreplayed.
- Old-process heartbeat, rename, send, reserve, observation, suspend, and leave all fail after lease rotation.
- A pull held by an old consumer is not acknowledged after a lease failure and remains deliverable to the winner.
- Resume/rejoin races remain fenced across reload, session replacement, tree navigation, dialog cancellation, and late backend acknowledgments.

### Compatibility and repository validation

Run the full broker-gated suite, TypeScript checks, ShellCheck, repository/Chezmoi rendering checks, and production-only package installation. Run all messaging tests on Node 22.19 and current Node, and actual SDK lifecycle tests against development Pi 0.82.0 and installed Pi 0.84.1. The feature does not require model inference; existing bounded live smoke is optional and must use only an approved cheap model if run.

## Rollout and recovery

Implementation and tests use only isolated brokers and do not alter user memberships, messages, allowance, or live service. Adding the Brewfile entry is applied through the existing Chezmoi package hook.

After merge, all open Pi sessions must reload before relying on leases. The first v2 connection migrates the ledger and fences old clients. Each saved session then explicitly runs `/messages join <group>` and selects the intended stale/suspended identity. Online duplicates must be explicitly resolved; no automatic takeover occurs.

The currently running manually managed broker can remain during code rollout because startup probing treats it as healthy. In a separately approved operational step, stop that manual broker and start any Pi session; the extension should launch the durable detached broker against the same config/data. Verify authenticated connectivity and retained group summaries before removing obsolete temporary launch artifacts.

Rollback after ledger migration requires code that understands ledger v2; old v1 clients intentionally reject the state rather than bypass leases. Broker data must not be downgraded or recreated automatically.
