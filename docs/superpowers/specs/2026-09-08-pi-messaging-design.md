# Pi messaging — approved behavior and implemented design

Date: 2026-09-08
Status: **The user approved messaging implementation and autonomous testing, using cheap models.**
Scope: messaging only. Project tracking, worktree lifecycle changes, knowledge storage, and intent promotion are not included.

## User-visible contract

1. **Explicit participation.** Independently launched, saved TUI sessions join a named group. When armed, messages can wake idle sessions and steer busy sessions. The extension never launches agents.
2. **Finite automatic work.** One persistent allowance is shared by the whole group: default 12 admissions, human-selectable 1–100. Every admission counts, including busy-session injection. Replies, receipts, elapsed time, restarts, and new threads never grant credits. Only a confirmed human command starts a new round, replacing rather than accumulating unused allowance.
3. **Conservative uncertain delivery.** At most one unresolved handoff per recipient. An admitted message is never automatically replayed or refunded, even when it might not have reached Pi. A human can inspect and dismiss an uncertain attempt to unblock the recipient. A receipt proves observation, not task completion.
4. **Fresh membership after context changes.** Reload, restart, new/resumed/forked sessions, and tree navigation detach participation. Explicit rejoining creates a fresh identity. Old inboxes remain inspectable, not redirected.
5. **Honest pause semantics.** Pause/leave prevent new admissions, but cannot recall messages already handed to Pi. These may still appear afterward.
6. **Human control remains separate.** `/messages` provides join, leave, arm, pause, send, status, inbox, revoke, and prune. The model tool `peer_message` has only peers, status, and send; it cannot inspect pending bodies or grant allowance. Peer text is not human authorization.

This bounds messaging-driven admissions, not all work within an agent run or another extension's loop. It is not a sandbox against programs running as the same OS user.

## Selected backend

**NATS JetStream**, using the official modular Node client and KV API. One small local broker and focused dependencies were accepted during review. SQLite was the earlier proposal and is **not** implemented alongside NATS.

The human explicitly starts a foreground broker. It binds only to `127.0.0.1`, uses a private random token, and keeps its configuration and data under `<agent-dir>/messaging/`. No broker is started from extension loading, session startup, or model tools. Existing initialized state is opened, never silently recreated.

- `PM_MESSAGES`: file-backed body storage, durable recipient-filtered pull consumers, explicit acknowledgments, discard-new limits, no automatic message-age expiry.
- `PM_CONTROL`: file-backed KV ledger with one bounded state entry containing authority identity, groups, peers, message metadata, and admission counters. It does not duplicate bodies.
- One compare-and-set domain makes admission and global quotas straightforward. This intentionally favors simplicity over high throughput at a maximum of 32 groups / 512 retained peers / 2,000 message records.

The client packages are pinned to 3.4.0; nats-server 2.14.6 is pinned in CI. Node minimum is 22.19.0. Existing repository-wide Pi 0.82.0 development pins are unchanged; installed Pi 0.84.1 is also tested.

## Admission and failure boundary

1. Enqueue reserves idempotency metadata and quota, then publishes a versioned body with expected last subject sequence 0. Duplicate publication is rejected for the retained subject's lifetime. A crash between metadata reservation and publication can leave a visibly missing body; a human can cancel the queued reservation.
2. A recipient obtains one body through its broker consumer. A ledger CAS checks active participation, group mode/allowance, and the recipient's unresolved-attempt gate, then records the attempt and increments the allowance together.
3. Only the caller with a confirmed successful CAS receives a new reservation. Uncertain acknowledgments stop admission; rereading an attempted record does not grant permission to call Pi.
4. The runtime rechecks its generation/peer after awaiting the reservation, then calls `pi.sendMessage` with a displayed custom peer message, `triggerTurn: true`, and `deliverAs: "steer"`, with no intervening await. It never uses `sendUserMessage`.
5. Broker acknowledgment is independent of model processing. Broker replay of an attempted/terminal record cannot produce another reservation. Matching live custom-message observation updates the ledger without triggering a model turn itself.

A pause/revocation ordered before the admission CAS blocks it; one ordered after cannot retract it. A crash after commit but before the Pi call consumes an uncertain attempt without replay. This follows Pi's fire-and-forget dispatch API rather than pretending to provide exactly-once processing.

Change notifications wake joined runtimes; a five-second heartbeat reconciles missed notifications. Runtime generations fence delayed callbacks during leave/reload. Disconnects and ambiguous storage operations stop automatic activity until human recovery. Messages follow broker publication order, which can differ from metadata reservation order during concurrent sends.

## Bounds and retention

- Body: 8 KiB UTF-8; display name: 64 code points.
- 16 active peers/group; 32 retained groups; 64 queued/attempted messages/group.
- 2,000 retained message records and 512 retained peers globally; tool status pages contain at most 20 records and no pending bodies.
- Full stores reject new work instead of evicting unresolved content.
- Send-time maintenance removes eligible terminal history older than seven days, throttled per connection. Human prune can remove eligible terminal history earlier. Live-sender idempotency is retained; unresolved work must be explicitly canceled/dismissed first.
- Pruning cleans inactive/orphaned consumers; stale-but-active memberships require explicit human revocation. No process is killed by revocation.

Owner-only filesystem permissions and symlink checks protect local configuration. Disk loss, filesystem rollback, malicious same-user programs, and remote authorization are outside this guarantee.

## Future remote and project integration

The Pi runtime/UI depend on an asynchronous `MessagingBackend`, not broker subjects or filesystem operations. Portable envelopes carry authority/group/peer/message IDs and a schema version, not PIDs or absolute session paths.

Remote support remains deferred. It must preserve one authoritative admission ledger; per-host allowances or a fresh local fallback would violate the safety contract. Authentication, TLS, authorization of human controls, uncertain network outcomes, and partition recovery require their own design. V1 rejects remote endpoints.

`pi-messaging/public` exposes `MessagingReader.getGroupSummary(ref)` on a separately configured connection. It cannot join, arm, read bodies, initialize state, or imply project completion. Project management remains a separate future extension.

## Implementation and verification

- [Implementation plan](../plans/2026-09-08-pi-messaging.md)
- [Setup, commands, recovery, and test instructions](../../../pi-messaging/README.md)
- [Verification and review notes](../reviews/2026-09-08-pi-messaging.md)

Deterministic tests cover real broker concurrency, lost CAS acknowledgments, broker restart/replay, pause ordering, retention, lifecycle fencing, and the human/model API boundary. Cheap-model live tests use two real SDK sessions with scripted human dialogs, not automated real terminal interaction. No project/vault implementation, normal Pi activation, push, or merge is implied.

The earlier exploratory SQLite draft is preserved in Git history at `186cf04`; it is not a second implementation baseline.
