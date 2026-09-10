# Pi Messaging Participation Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an explicitly rejoining saved Pi session safely resume one stale or suspended messaging identity while preserving its routing ID, role name, inbox, and finite-delivery state.

**Architecture:** Upgrade the control ledger to version 2 with internal peer leases and a suspended lifecycle state. Every participant mutation validates a private lease; `/messages join` rejects online duplicates, lets the human choose among multiple resumable same-session peers, validates/rebinds the selected durable consumer, and then rotates the winner's lease atomically.

**Tech Stack:** TypeScript; Node >=22.19; Pi extension/session APIs tested on 0.82.0 and 0.84.1; NATS JetStream/KV with official 3.4.0 clients; NATS Server 2.14.6; Node test runner and jiti 2.7.0.

## Global Constraints

- Joining/resuming remains a confirmed human TUI action; the agent tool cannot join, resume, revoke, or arm.
- A matching online peer (heartbeat age <=30 seconds) blocks resume; there is no automatic or confirmed takeover path.
- Multiple resumable same-session peers require a numbered human picker; never merge or silently choose inboxes.
- Explicit `/messages leave` and human revoke are final/non-resumable; Pi lifecycle shutdown/navigation suspends.
- Resume preserves peer ID, role name, recipient routing, history, group counters, and allowance and triggers no model turn.
- Queued messages may be delivered after resume; attempted messages are never replayed/refunded and remain human-recoverable.
- Lease IDs are internal: never expose them through public peer DTOs, UI, logs, discovery, tool output, envelopes, or model context.
- Every participant mutation is lease-fenced, including late heartbeat/send/reserve/receipt/suspend/leave operations.
- Active stale/suspended peers remain routable and retain an active-peer slot until explicit leave/revoke.
- V1 migration is one CAS update preserving authority, groups, peers, messages, attempts, counters, and timestamps.
- Old v1 active peers become resumable but fenced; old inactive peers remain non-resumable.
- Tests use isolated brokers/sessions and do not alter the user's `sap` state, messages, allowance, or live broker.

---

## File structure

- `pi-messaging/src/contracts.ts` — public lifecycle DTOs, private lease handle type, and backend resume/suspend methods.
- `pi-messaging/src/policy.ts` — ledger v1 validation/migration, ledger v2 validation, lifecycle derivation, lease checks, fresh join, resume, suspend, leave, and lease-aware message policy.
- `pi-messaging/src/nats-backend.ts` — CAS migration, private participant lease, durable-consumer rebinding, and lease-aware backend operations.
- `pi-messaging/src/runtime.ts` — distinguish graceful lifecycle suspension from explicit final leave.
- `pi-messaging/src/ui.ts` — online rejection, single-candidate confirmation, multi-candidate picker, lifecycle labels, and unresolved counts.
- `pi-messaging/extensions/messaging.ts` — route Pi lifecycle events to suspend and human leave to final leave; maintain generation fencing.
- `pi-messaging/tests/policy.test.mjs` — migration/lifecycle/lease unit tests.
- `pi-messaging/tests/backend.test.mjs` — real-broker resume, retained inbox/consumer, and migration tests.
- `pi-messaging/tests/failures.test.mjs` — old-process and in-flight pull fencing.
- `pi-messaging/tests/extension.test.mjs` — human resume UX and lifecycle event behavior.
- `pi-messaging/tests/quiet.test.mjs` — quiet idle-boundary behavior after a resumed identity.
- `pi-messaging/tests/helpers/lease-contender.mjs` — independent old-owner process fixture that retains its lease privately.
- `pi-messaging/README.md` and messaging design/review docs — replace fresh-membership claims with approved resume semantics and rollout rules.

---

### Task 1: Define ledger v2 and lossless v1 migration

**Files:**
- Modify: `pi-messaging/src/contracts.ts:1-46`
- Modify: `pi-messaging/src/policy.ts:1-46`
- Modify: `pi-messaging/tests/policy.test.mjs:1-110`

**Interfaces:**
- Consumes: current v1 `Group`, `Peer`, `MessageStatus`, and `Ledger` shapes.
- Produces:

```ts
export type PeerLifecycle = 'online' | 'stale' | 'suspended' | 'left';
export interface Peer {
  id: string; groupId: string; sessionId: string; displayName: string;
  active: boolean; suspended: boolean; lastSeen: number;
}
export interface ParticipantLease { peerId: string; leaseId: string }

export interface Ledger {
  version: 2;
  authorityId: string;
  sequence: number;
  groups: Record<string, Group>;
  peers: Record<string, Peer & { leaseId: string }>;
  messages: Record<string, MessageStatus>;
}
export function migrateLedger(value: unknown, authorityId: string): { ledger: Ledger; migrated: boolean };
export function peerLifecycle(peer: Peer, now?: number): PeerLifecycle;
```

Message `Envelope.version` and `BrokerConfig.version` remain exactly `1`.

- [ ] **Step 1: Write failing migration tests from a literal v1 fixture**

Construct a v1 object without using `newLedger()`, including an armed group, one active peer, one inactive peer, one queued message, and one attempted message with all attempt fields. Define `const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27}$/;` in the test, then assert:

```js
const before = structuredClone(v1);
const { ledger, migrated } = p.migrateLedger(v1, authorityId);
assert.equal(migrated, true);
assert.equal(ledger.version, 2);
assert.deepEqual(ledger.groups, before.groups);
assert.deepEqual(ledger.messages, before.messages);
assert.equal(ledger.sequence, before.sequence);
assert.deepEqual(
  Object.fromEntries(Object.entries(ledger.peers).map(([id, peer]) => [id, {
    id: peer.id, groupId: peer.groupId, sessionId: peer.sessionId,
    displayName: peer.displayName, active: peer.active, lastSeen: peer.lastSeen,
  }])),
  before.peers,
);
assert.equal(ledger.peers[activeId].suspended, false);
assert.match(ledger.peers[activeId].leaseId, UUID_PATTERN);
assert.equal(ledger.peers[inactiveId].active, false);
assert.equal(p.migrateLedger(ledger, authorityId).migrated, false);
```

Also assert wrong authority, malformed v1, malformed v2, missing lease, extra bounds, and unsupported versions fail closed.

- [ ] **Step 2: Run migration tests red**

Run:

```bash
node --test --test-name-pattern='v1 ledger migration|ledger versions' pi-messaging/tests/policy.test.mjs
```

Expected: FAIL because `migrateLedger`, ledger v2, and lifecycle fields do not exist.

- [ ] **Step 3: Add explicit legacy and current validators**

Keep an internal `LegacyLedger`/`LegacyPeer` type solely for migration. Validate all existing v1 invariants before copying. Add v2 validation requiring UUID leases and boolean `suspended`, with these consistency rules:

```ts
if (!peer.active && peer.suspended) fail('corrupt', 'Inactive peers cannot be suspended');
if (!uuid.test(peer.leaseId)) fail('corrupt', 'Invalid peer lease');
```

Generate fresh random leases for every migrated peer, including inactive records, so the stored v2 shape stays uniform; inactive records remain non-resumable because `active` is false. Do not mutate the input object.

- [ ] **Step 4: Implement lifecycle derivation and v2 creation**

Use one exported threshold:

```ts
export const ONLINE_WINDOW_MS = 30_000;
export function peerLifecycle(peer: Peer, now = Date.now()): PeerLifecycle {
  if (!peer.active) return 'left';
  if (peer.suspended) return 'suspended';
  return now - peer.lastSeen <= ONLINE_WINDOW_MS ? 'online' : 'stale';
}
```

`newLedger()` returns version 2. `migrateLedger()` validates a v2 ledger and returns it unchanged, or validates/copies v1 to v2 while preserving all non-lease values exactly. Update `joinPeer()` in this task only to create `suspended: false` and a fresh `leaseId`; keep the existing bare-ID participant-operation signatures until Task 2 changes those signatures together with every backend caller.

- [ ] **Step 5: Run policy and type checks green**

Run:

```bash
node --test pi-messaging/tests/policy.test.mjs
npm run typecheck
```

Expected: policy tests PASS and TypeScript reports no errors. Task 1 keeps participant-operation signatures unchanged; lease enforcement is introduced atomically with backend call-site changes in Task 2.

- [ ] **Step 6: Commit the schema/migration unit**

Commit only when the policy test file passes and all changed source files contain no unsafe casts around ledger validation:

```bash
git add pi-messaging/src/contracts.ts pi-messaging/src/policy.ts pi-messaging/tests/policy.test.mjs
git commit -m "feat: add lease-aware messaging ledger migration"
```

---

### Task 2: Fence all participant policy operations with leases

**Files:**
- Modify: `pi-messaging/src/contracts.ts:22-42`
- Modify: `pi-messaging/src/policy.ts:47-135`
- Modify: `pi-messaging/src/nats-backend.ts:48-215`
- Modify: `pi-messaging/tests/policy.test.mjs`
- Modify: `pi-messaging/tests/backend.test.mjs`

**Interfaces:**
- Consumes: `ParticipantLease`, v2 `Ledger`, and `peerLifecycle()` from Task 1.
- Produces:

```ts
export function joinPeer(s: Ledger, ref: GroupRef, info: { sessionId: string; displayName: string }): Peer & { leaseId: string };
export function resumePeer(s: Ledger, ref: GroupRef, sessionId: string, peerId: string, now?: number): Peer & { leaseId: string };
export function requireLease(s: Ledger, lease: ParticipantLease): Peer & { leaseId: string };
export function suspendPeer(s: Ledger, lease: ParticipantLease): void;
export function leavePeer(s: Ledger, lease: ParticipantLease): void;
export function revokePeer(s: Ledger, ref: GroupRef, peerId: string): void;
```

`heartbeat`, `prepareMessage`, `canReceive`, `admit`, and `observe` accept `ParticipantLease` rather than a bare participant ID. Recipient validation continues to accept any `active` peer, including stale/suspended recipients.

- [ ] **Step 1: Write failing join/resume/lifecycle tests**

Add deterministic tests using explicit timestamps:

```js
const joined = p.joinPeer(state, group, { sessionId: 'same', displayName: 'worker' });
const oldLease = { peerId: joined.id, leaseId: joined.leaseId };
p.suspendPeer(state, oldLease);
assert.equal(p.peerLifecycle(state.peers[joined.id], now), 'suspended');
const resumed = p.resumePeer(state, group, 'same', joined.id, now);
assert.equal(resumed.id, joined.id);
assert.equal(resumed.displayName, 'worker');
assert.notEqual(resumed.leaseId, oldLease.leaseId);
assert.equal(p.peerLifecycle(resumed, now), 'online');
assert.throws(() => p.heartbeat(state, oldLease), /lease|participation/i);
assert.throws(() => p.suspendPeer(state, oldLease), /lease|participation/i);
assert.throws(() => p.leavePeer(state, oldLease), /lease|participation/i);
```

Cover stale resume, suspended resume, online rejection at exactly 30 seconds, wrong session/group/peer, final leave exclusion, two concurrent logical resumers, active-peer slot preservation, and no group-counter changes.

- [ ] **Step 2: Write failing queued/attempted safety tests**

Assert an active suspended recipient remains routable, but cannot admit without its lease/runtime:

```js
const queued = p.prepareMessage(state, senderLease, { toPeerId: suspended.id, text: 'wait' }, 'queued');
assert.equal(queued.recipientPeerId, suspended.id);
const resumed = p.resumePeer(state, group, suspended.sessionId, suspended.id, now);
const reservation = p.admit(state, { peerId: resumed.id, leaseId: resumed.leaseId }, queued.id);
assert.equal(reservation.peerId, suspended.id);
```

Then create an attempted message before suspension, resume, and assert another `admit` returns `null`, state remains attempted and allowance unchanged.

- [ ] **Step 3: Run lease tests red**

Run:

```bash
node --test --test-name-pattern='lease|resume|suspended recipient|attempted.*resume' pi-messaging/tests/policy.test.mjs
```

Expected: FAIL because policy functions still authorize by peer ID/active flag only.

- [ ] **Step 4: Implement lease and resume policy**

`requireLease()` must check `active`, `!suspended`, peer ID, and exact lease UUID. `resumePeer()` must re-evaluate liveness inside the mutation, reject `online`, reject inactive peers, match group/session/peer, set `suspended=false`, rotate the lease, and update `lastSeen` to the supplied `now`.

`leavePeer()` sets `active=false`, `suspended=false`, and rotates its lease. `suspendPeer()` retains `active=true`, sets `suspended=true`, and rotates its lease. `revokePeer()` validates group attribution, then finalizes without needing the old lease.

Pass leases through every sender/receiver mutation:

```ts
const sender = requireLease(s, senderLease);
const recipient = activePeer(s, input.toPeerId); // routable even if suspended/stale
```

Receipt correlation still validates attempt ID/round in addition to the participant lease.

Adapt the backend in the same step so there is never an optional lease bypass: store `{ peer, lease }` privately, keep `get peer()` as a lease-free defensive copy, retain fresh `join()` and explicit-final `leave()` behavior, and pass the private lease through heartbeat, send, reserve/admit, and observe. `resume()`/`suspend()` and consumer rebinding remain Task 3, but all currently available participant mutations must compile and be fenced in this task.

- [ ] **Step 5: Run the complete policy suite**

Run:

```bash
NATS_SERVER=/tmp/pi-message-queue-review/bin/nats-server \
PI_MESSAGING_REQUIRE_BROKER=1 \
node --test pi-messaging/tests/policy.test.mjs pi-messaging/tests/backend.test.mjs
npm run typecheck
```

Expected: policy and existing real-backend tests PASS and TypeScript reports no errors. Update all current backend call sites directly rather than adding optional lease bypasses.

- [ ] **Step 6: Commit lease-fenced policy**

```bash
git add pi-messaging/src/contracts.ts pi-messaging/src/policy.ts pi-messaging/src/nats-backend.ts \
  pi-messaging/tests/policy.test.mjs pi-messaging/tests/backend.test.mjs
git commit -m "feat: fence messaging participation with leases"
```

---

### Task 3: Migrate the real backend and rebind preserved consumers

**Files:**
- Modify: `pi-messaging/src/contracts.ts:22-42`
- Modify: `pi-messaging/src/nats-backend.ts:1-215`
- Modify: `pi-messaging/tests/backend.test.mjs:1-175`
- Modify: `pi-messaging/tests/helpers/contender.mjs`

**Interfaces:**
- Consumes: v2 migration and lease policy from Tasks 1-2.
- Produces backend methods:

```ts
readonly peer: Peer | undefined;
resume(ref: GroupRef, peerId: string, sessionId: string): Promise<Peer>;
suspend(): Promise<void>;
leave(): Promise<void>; // explicit final leave
```

The backend stores `{ peer: Peer; lease: ParticipantLease }` privately. `peers()` returns copied public peers without lease IDs.

- [ ] **Step 1: Write a failing real-broker migration test**

Initialize the KV bucket, replace `state` with a literal valid v1 ledger containing queued and attempted records, then connect an upgraded backend. Assert the stored state becomes v2 in one revision and all existing non-lease JSON fields remain equal.

Reconnect a second backend and assert no second migration/revision occurs. Delete the control stream in a separate test and retain the existing initialized-state failure.

- [ ] **Step 2: Write failing resume/inbox/consumer tests**

Use one real peer to send queued work to another. Suspend the recipient, close it, connect a replacement, and resume the same ID:

```js
const oldId = b.peer.id;
const oldName = b.peer.displayName;
await b.suspend(); await b.close();
const resumed = await connectBackend(config);
await resumed.resume(group, oldId, 'session-b');
assert.equal(resumed.peer.id, oldId);
assert.equal(resumed.peer.displayName, oldName);
assert.equal((await resumed.listMessages(group)).find(m => m.id === queued.id).recipientPeerId, oldId);
assert.equal((await jsm.streams.info('PM_MESSAGES')).state.consumer_count, 2);
```


Arm once, reserve/observe from the resumed backend, and assert one admission and one observation. Separately preserve an attempted message across resume and assert `reserve()` returns `null` with no allowance change.

- [ ] **Step 3: Run backend tests red**

Run:

```bash
NATS_SERVER=/tmp/pi-message-queue-review/bin/nats-server \
PI_MESSAGING_REQUIRE_BROKER=1 \
node --test --test-name-pattern='migrates v1|resumes.*consumer|attempted.*resume' pi-messaging/tests/backend.test.mjs
```

Expected: FAIL because backend migration, `resume()`, and `suspend()` do not exist.

- [ ] **Step 4: Add one CAS migration before backend exposure**

After opening the KV bucket and before constructing a usable backend, read `state`, call `migrateLedger()`, and update only when `migrated` is true. On wrong revision, reread; on uncertain KV outcome, fail closed rather than guessing. Only a successful v2 read permits returning a backend.

New initialization creates v2 directly. Do not change stream subjects, limits, envelope version, or config version.

- [ ] **Step 5: Store a private participant and centralize consumer binding**

Replace `private participant?: Peer` with a private peer/lease pair. Keep `get peer()` a defensive public copy.

Extract:

```ts
private async bindConsumer(peerId: string): Promise<void>
```

It gets and validates the existing durable `peer_<uuid>` consumer when present, or creates it with the exact existing filter/ack/delivery/max-pending settings when absent. Suspend retains the durable consumer. Explicit leave/revoke delete it.

`join()` stores the new record's lease only after consumer binding and generation checks. `resume()` first validates or recreates the same durable, then performs CAS resume and uses the existing late-join generation fence. Preflighting avoids an apparently online zombie when existing consumer validation fails. If local cancellation occurs after CAS, suspend that exact new lease; never finalize or create a new peer.

- [ ] **Step 6: Pass leases through all backend mutations**

Update heartbeat/rename, send, reserve/admit, observe, suspend, and leave. In `reserve()`, if lease validation fails after a pull, do not ack; let the error stop the runtime and allow broker redelivery. Preserve current uncertain CAS behavior.

`revoke()` calls administrative `revokePeer()` and removes the consumer. Metadata APIs strip lease IDs.

- [ ] **Step 7: Run real backend and process contention suites**

Run:

```bash
NATS_SERVER=/tmp/pi-message-queue-review/bin/nats-server \
PI_MESSAGING_REQUIRE_BROKER=1 \
node --test pi-messaging/tests/backend.test.mjs pi-messaging/tests/failures.test.mjs
npm run typecheck
```

Expected: all tests PASS; 14-process allowance test still admits exactly 12; restart persistence and missing-publication behavior remain unchanged.

- [ ] **Step 8: Commit backend migration and resume**

```bash
git add pi-messaging/src/contracts.ts pi-messaging/src/nats-backend.ts \
  pi-messaging/tests/backend.test.mjs pi-messaging/tests/helpers/contender.mjs
git commit -m "feat: resume leased messaging peers"
```

---

### Task 4: Prove old processes cannot mutate a resumed peer

**Files:**
- Modify: `pi-messaging/tests/failures.test.mjs:1-112`
- Create: `pi-messaging/tests/helpers/lease-contender.mjs`
- Modify: `pi-messaging/src/nats-backend.ts` only for confirmed defects found by these tests.

**Interfaces:**
- Consumes: private backend lease, `suspend()`, and `resume()` from Task 3.
- Produces: process-level fencing evidence; no public production API beyond Task 3.

- [ ] **Step 1: Add an independent stale-owner process fixture**

The child joins a peer, reports only public peer metadata, and accepts bounded IPC commands for `heartbeat`, `send`, `reserve`, `observe`, `suspend`, and `leave`. It never sends its lease over IPC. Every command reports `{ ok: true }` or `{ error }` and has a parent-side timeout.

- [ ] **Step 2: Write the failing rotated-lease fencing test**

Start the child owner, make its heartbeat stale using a deterministic policy clock hook or a controlled KV timestamp update, then resume the same peer in the parent. Invoke each old-child mutation and assert all reject with participation/lease errors.

After the child tries `leave`, assert the parent can still heartbeat and the peer remains active/online. After the child tries `send`, assert no new message exists. After reserve, assert allowance remains unchanged.

- [ ] **Step 3: Write the failing held-pull redelivery test**

Have the old child start a pull and confirm the durable consumer has one waiter. Publish a queued message, rotate the lease before its admission CAS proceeds using a test barrier around snapshot/change, then assert:

- old admission fails;
- the old child does not ack the body;
- the resumed owner reserves that same message ID;
- exactly one allowance credit is spent.

Do not simulate this only with mocks; use a real isolated NATS process.

- [ ] **Step 4: Run fencing tests red**

Run:

```bash
NATS_SERVER=/tmp/pi-message-queue-review/bin/nats-server \
PI_MESSAGING_REQUIRE_BROKER=1 \
node --test --test-name-pattern='rotated lease|held pull' pi-messaging/tests/failures.test.mjs
```

Expected: FAIL until every old-owner path is fenced and the held pull is left unacknowledged.

- [ ] **Step 5: Fix only demonstrated backend fencing gaps**

Keep lease checks inside CAS policy operations, not as preflight-only checks. Ensure local cached participant data is never updated after a generation change. Do not ack a pulled message in an exception path. Do not add retry/refund behavior.

- [ ] **Step 6: Repeat the process tests**

Run:

```bash
for i in 1 2 3; do
  NATS_SERVER=/tmp/pi-message-queue-review/bin/nats-server \
  PI_MESSAGING_REQUIRE_BROKER=1 \
  node --test --test-name-pattern='rotated lease|held pull' pi-messaging/tests/failures.test.mjs || exit
 done
```

Expected: all three runs PASS with one admission and no leaked child processes.

- [ ] **Step 7: Commit split-brain tests and fixes**

```bash
git add pi-messaging/tests/failures.test.mjs pi-messaging/tests/helpers/lease-contender.mjs \
  pi-messaging/src/nats-backend.ts
git commit -m "test: prove resumed peer lease fencing"
```

---

### Task 5: Implement explicit human resume UX and lifecycle suspension

**Files:**
- Modify: `pi-messaging/src/runtime.ts:1-105`
- Modify: `pi-messaging/src/ui.ts:1-110`
- Modify: `pi-messaging/src/identity.ts` if a shared lifecycle label helper belongs there
- Modify: `pi-messaging/extensions/messaging.ts:20-150`
- Modify: `pi-messaging/tests/extension.test.mjs:1-455`
- Modify: `pi-messaging/tests/quiet.test.mjs`

**Interfaces:**
- Consumes: `peerLifecycle()`, backend `resume()`/`suspend()`/`leave()`, and public `Peer.suspended`.
- Produces:

```ts
MessagingRuntime.stop(disposition?: 'suspend' | 'leave'): Promise<void>
```

Human `/messages join` resumes through the existing `HumanControls.joined(ref)` runtime path after selection/confirmation. Agent `peers` returns lifecycle metadata but no resume action or lease.

- [ ] **Step 1: Rewrite old fresh-identity tests as failing resume tests**

Replace assertions that reload/tree/rejoin always creates a fresh ID. Cover:

- lifecycle shutdown and tree navigation call suspend and preserve `active=true`/same ID;
- explicit `/messages leave` makes `active=false` and a later join creates a fresh peer;
- repeated join while already locally joined to the same group/session is a no-op and creates no dialog/peer;
- join to another group still rejects until explicit leave;
- one stale/suspended match appears in confirmation and preserves role/ID;
- online match rejects without a takeover dialog;
- multiple candidates produce numbered choices containing role, session attribution, lifecycle, age, and unresolved count;
- canceled picker/confirmation makes no CAS change;
- resume grants no allowance and sends no model message.

- [ ] **Step 2: Run focused UI/lifecycle tests red**

Run:

```bash
node --test --test-name-pattern='resume|suspend|online match|multiple candidates|repeated join' \
  pi-messaging/tests/extension.test.mjs
```

Expected: FAIL because shutdown currently calls final `leave()` and join always creates a fresh identity.

- [ ] **Step 3: Separate runtime suspension from final leave**

Implement:

```ts
async stop(disposition: 'suspend' | 'leave' = 'suspend'): Promise<void> {
  this.deactivate();
  this.host.status(undefined);
  if (disposition === 'leave') await this.backend.leave();
  else await this.backend.suspend();
}
```

In the extension, session shutdown/start replacement/tree navigation use `suspend`. Human `/messages leave` uses `leave`. Preserve epoch increments and late-operation fences. If suspension cannot reach the broker, close locally and let the peer become stale; do not convert failure into final leave.

- [ ] **Step 4: Implement candidate discovery and attributed selection**

Before fresh join, obtain peers and metadata-only messages once. Match exact full `sessionId` and current group. Reject any matching `online` peer. Candidate set is matching active peers whose lifecycle is `stale` or `suspended`.

Compute unresolved counts with:

```ts
const unresolvedByRecipient = new Map<string, number>();
for (const message of messages) {
  if (message.state === 'queued' || message.state === 'attempted') {
    unresolvedByRecipient.set(message.recipientPeerId, (unresolvedByRecipient.get(message.recipientPeerId) ?? 0) + 1);
  }
}
```

One candidate is named in confirmation. Multiple candidates use a numbered picker; selection indexes the candidate array, never a non-unique label. Recheck all resume conditions in backend CAS after confirmation.

Fresh join occurs only when no resumable candidate exists. A local same-group/same-session participant returns an informational notification without mutation.

- [ ] **Step 5: Update status and agent discovery without exposing leases**

Human status renders all four lifecycle states. Human compose lists active stale/suspended recipients as routable and labels their state. Agent `peers` includes:

```json
{"id":"…","sessionId":"…","displayName":"…","presence":"online|stale|suspended"}
```

Continue filtering explicitly left peers from agent discovery. Do not add lease, resume, or unresolved-message details to the model tool.

- [ ] **Step 6: Run extension, quiet, and coexistence tests**

Run:

```bash
NATS_SERVER=/tmp/pi-message-queue-review/bin/nats-server \
PI_MESSAGING_REQUIRE_BROKER=1 \
PI_OFFLINE=1 \
node --test pi-messaging/tests/extension.test.mjs pi-messaging/tests/quiet.test.mjs \
  pi-messaging/tests/coexistence.test.mjs pi-messaging/tests/runtime.test.mjs
npm run typecheck
```

Expected: all tests PASS. Quiet delivery remains broker-queued while busy, and resumed identity context carries the preserved role without a naming-only turn.

- [ ] **Step 7: Commit resume UX and lifecycle behavior**

```bash
git add pi-messaging/src/runtime.ts pi-messaging/src/ui.ts pi-messaging/src/identity.ts \
  pi-messaging/extensions/messaging.ts pi-messaging/tests/extension.test.mjs \
  pi-messaging/tests/quiet.test.mjs
git commit -m "feat: resume messaging identity across Pi lifecycle"
```

---

### Task 6: Documentation, compatibility, and final resume verification

**Files:**
- Modify: `pi-messaging/README.md:40-90`
- Modify: `docs/superpowers/specs/2026-09-08-pi-messaging-design.md`
- Modify: `docs/superpowers/specs/2026-09-09-pi-messaging-role-names-design.md`
- Modify: `docs/superpowers/reviews/2026-09-08-pi-messaging.md`

**Interfaces:**
- Consumes: final tested resume semantics.
- Produces: operator rollout/recovery guidance and evidence; no new code API.

- [ ] **Step 1: Replace obsolete fresh-membership documentation**

Document exact behavior:

- explicit join/resume remains required after lifecycle changes;
- lifecycle detach preserves a resumable routing identity/inbox;
- explicit leave/revoke is final;
- online same-session peers block resume;
- multiple stale/suspended matches require a picker;
- queued messages remain queued to the same ID;
- attempted messages remain attempted and require existing human recovery;
- stale/suspended peers retain slots and can receive queued messages;
- no leases appear in UI/model output;
- v1 migration fences old clients, so all open Pi sessions must reload before rejoining.

Retain the original historical design as history but mark this dated approved follow-up as superseding fresh-peer-on-every-rejoin behavior.

- [ ] **Step 2: Run full broker-gated verification**

Run:

```bash
NATS_SERVER=/tmp/pi-message-queue-review/bin/nats-server \
PI_MESSAGING_REQUIRE_BROKER=1 npm test
npm run typecheck
npm run lint:shell
npm run check
git diff --check
```

Expected: zero test failures or skipped messaging broker tests; all checks PASS.

- [ ] **Step 3: Run Node 22.19 and Node 24 messaging suites**

Run:

```bash
NATS_SERVER=/tmp/pi-message-queue-review/bin/nats-server \
PI_MESSAGING_REQUIRE_BROKER=1 \
/home/bits/.npm/_npx/992a19d7d9bf36d4/node_modules/node/bin/node \
  --test pi-messaging/tests/*.test.mjs

NATS_SERVER=/tmp/pi-message-queue-review/bin/nats-server \
PI_MESSAGING_REQUIRE_BROKER=1 \
/home/bits/.npm/_npx/387698761821791d/node_modules/node/bin/node \
  --test pi-messaging/tests/*.test.mjs
```

Expected: all messaging tests PASS on both runtimes with no skips.

- [ ] **Step 4: Run actual Pi SDK lifecycle tests on both versions**

Run the real SDK scripted tests with network inference disabled:

```bash
PI_OFFLINE=1 NATS_SERVER=/tmp/pi-message-queue-review/bin/nats-server \
PI_MESSAGING_REQUIRE_BROKER=1 \
node --test pi-messaging/tests/quiet.test.mjs pi-messaging/tests/extension.test.mjs

PI_OFFLINE=1 NATS_SERVER=/tmp/pi-message-queue-review/bin/nats-server \
PI_MESSAGING_REQUIRE_BROKER=1 \
PI_MESSAGING_PI_SDK=/home/linuxbrew/.linuxbrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js \
node --test pi-messaging/tests/quiet.test.mjs pi-messaging/tests/extension.test.mjs
```

Expected: lifecycle/quiet tests PASS against development Pi 0.82.0 and installed Pi 0.84.1 without paid inference.

- [ ] **Step 5: Perform a fresh independent review**

Give the reviewer the approved lifecycle spec, both implementation plans, base commit, and full changed diff. Require concrete reproduction for findings. Review specifically:

- lease coverage on every participant mutation;
- v1 migration preservation and old-client fencing;
- consumer redelivery/ack ordering;
- online threshold and concurrent resume CAS;
- explicit leave versus suspension;
- no lease/model/body exposure;
- no replay/refund or automatic participation.

Fix Critical and Important findings, rerun the focused failing test plus aggregate verification, and record rejected findings with source/test evidence.

- [ ] **Step 6: Record evidence and commit docs**

```bash
git add pi-messaging/README.md \
  docs/superpowers/specs/2026-09-08-pi-messaging-design.md \
  docs/superpowers/specs/2026-09-09-pi-messaging-role-names-design.md \
  docs/superpowers/reviews/2026-09-08-pi-messaging.md
git commit -m "docs: document safe messaging session resume"
```

- [ ] **Step 7: Stop before live migration**

Do not reload user sessions or migrate the user's v1 ledger during implementation completion. Report the signed branch commit and exact rollout sequence:

1. merge/push only after user choice;
2. ensure Homebrew installed `nats-server`;
3. reload every open Pi messaging session so no v1 client remains;
4. let the first upgraded connection migrate the ledger;
5. explicitly `/messages join sap` and select the intended stale/suspended identity;
6. inspect/revoke unselected historical peers;
7. in a separately approved operational step, stop the manual broker and verify first-Pi autostart against retained data.
