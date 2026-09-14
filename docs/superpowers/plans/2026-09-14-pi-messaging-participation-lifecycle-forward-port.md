# Pi Messaging Participation Lifecycle Forward-Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a saved Pi session explicitly resume a stale or suspended peer identity while private leases fence every participant mutation and current atomic batching/no-replay guarantees remain unchanged.

**Architecture:** Upgrade the control ledger to v2 through lossless CAS migration, store a private lease with each backend participation, validate that lease inside all participant-authorized CAS operations, and rebind the preserved durable consumer before an explicit human resume. Lifecycle detaches suspend; explicit leave/revoke remains final; identity stays API-only with no context hook.

**Tech Stack:** TypeScript; Node >=22.19; Pi SDK 0.82.0/installed SDK; NATS JetStream/KV 3.4.0; NATS Server 2.14.6; Node test runner and jiti 2.7.0.

## Global Constraints

- Joining and resuming remain confirmed human TUI actions; the agent cannot join, resume, revoke, or arm.
- Online same-session peers block resume; no takeover path exists.
- Several resumable matches require an attributed numbered picker; records are never merged or silently selected.
- Reload, quit, replacement, and tree navigation suspend; explicit human leave/revoke is final.
- Resume preserves peer ID, role, routing, durable consumer, queued inbox, history, counters, and allowance and triggers no model turn.
- Every participant mutation validates an exact private lease inside CAS, including atomic batch admission and exact batch receipt.
- Leases never enter public DTOs, UI, logs, tool output, envelopes, custom messages, or model context.
- Queued messages remain deliverable after resume; attempted messages are never replayed/refunded.
- Queue reservation, one unresolved outbound per sender, eight queued per recipient, publication high-water, per-message credit use, quiet delivery, and combined receipts remain unchanged.
- V1 migration preserves all non-lifecycle fields and grants no capacity.
- Tests use isolated brokers and sessions only; never access live messaging state.
- All commits are SSH-signed.

---

## File structure

- `pi-messaging/src/contracts.ts` — public lifecycle/presence fields, private backend lease handle, and resume/suspend methods.
- `pi-messaging/src/policy.ts` — legacy validation, v2 migration, lifecycle derivation, lease authorization, resume/suspend/final leave, and lease-aware batch policy.
- `pi-messaging/src/nats-backend.ts` — CAS migration, private participation, consumer binding, resume, and lease-aware operations.
- `pi-messaging/src/runtime.ts` — lifecycle suspension versus explicit final leave.
- `pi-messaging/src/ui.ts` — candidate discovery, online block, attributed picker, confirmation, and state labels.
- `pi-messaging/extensions/messaging.ts` — lifecycle disposition, generation fencing, and API-only presence output.
- `pi-messaging/tests/policy.test.mjs` — schema/migration/lease/batch unit tests.
- `pi-messaging/tests/backend.test.mjs` — real broker migration, preserved consumer/inbox, and batch resume tests.
- `pi-messaging/tests/failures.test.mjs` — stale-owner and held-pull fencing.
- `pi-messaging/tests/helpers/lease-contender.mjs` — independent old runtime process fixture.
- `pi-messaging/tests/extension.test.mjs` — explicit human resume and lifecycle races.
- `pi-messaging/tests/quiet.test.mjs`, `runtime.test.mjs`, `cache-stability.test.mjs` — quiet combined delivery and stable-context regressions.
- `pi-messaging/README.md` — operator semantics and rollout.

### Task 1: Define ledger v2 and lossless migration

**Files:**
- Modify: `pi-messaging/src/contracts.ts`
- Modify: `pi-messaging/src/policy.ts`
- Modify: `pi-messaging/tests/policy.test.mjs`

**Interfaces:**
- Consumes: current v1 `Group`, `Peer`, `MessageStatus`, and ledger shapes.
- Produces:

```ts
export type PeerPresence = 'online' | 'stale' | 'suspended' | 'left';
export interface Peer {
  id: string;
  groupId: string;
  sessionId: string;
  displayName: string;
  active: boolean;
  suspended: boolean;
  lastSeen: number;
}
export interface ParticipantLease { peerId: string; leaseId: string }
export interface StoredPeer extends Peer { leaseId: string }
export interface Ledger {
  version: 2;
  authorityId: string;
  sequence: number;
  groups: Record<string, Group>;
  peers: Record<string, StoredPeer>;
  messages: Record<string, MessageStatus>;
}
export const ONLINE_WINDOW_MS = 30_000;
export function peerPresence(peer: Peer, now?: number): PeerPresence;
export function migrateLedger(value: unknown, authorityId: string): {
  ledger: Ledger;
  migrated: boolean;
};
export function publicPeer(peer: StoredPeer): Peer;
```

Fresh join has the exact signature:

```ts
export function joinPeer(
  state: Ledger,
  ref: GroupRef,
  info: { sessionId: string; displayName: string },
  now?: number,
): StoredPeer;
```

Message `Envelope.version` and `BrokerConfig.version` remain exactly `1`.

- [ ] **Step 1: Write a literal-v1 migration test RED**

Build a v1 object without calling `newLedger()`: include armed allowance with nonzero use, active and inactive peers, queued/attempted/observed messages, attempt IDs/rounds/timestamps, sender request keys, hashes, and sequence ordering. Preserve a deep clone and assert:

```js
const { ledger, migrated } = p.migrateLedger(v1, authorityId);
assert.equal(migrated, true);
assert.equal(ledger.version, 2);
assert.deepEqual(ledger.groups, before.groups);
assert.deepEqual(ledger.messages, before.messages);
assert.equal(ledger.sequence, before.sequence);
for (const [id, oldPeer] of Object.entries(before.peers)) {
  assert.deepEqual(p.publicPeer(ledger.peers[id]), { ...oldPeer, suspended: false });
  assert.match(ledger.peers[id].leaseId, UUID_PATTERN);
}
assert.equal(p.migrateLedger(ledger, authorityId).migrated, false);
```

Also assert the input was not mutated; active and inactive peers both receive stored leases; inactive peers remain inactive; wrong authority, malformed v1/v2, missing lease/suspended fields, extra bounds, invalid attempts, and unsupported versions fail closed.

- [ ] **Step 2: Run RED**

```bash
node --test --test-name-pattern='v1 ledger migration|ledger versions|peer presence' \
  pi-messaging/tests/policy.test.mjs
```

Expected: FAIL because migration and lifecycle fields do not exist.

- [ ] **Step 3: Implement explicit legacy and current validators**

Keep internal `LegacyPeer` and `LegacyLedger` types only for migration. Validate every current v1 invariant before copying. Validate v2 peers with exact boolean `suspended`, UUID `leaseId`, and:

```ts
if (!peer.active && peer.suspended) fail('corrupt', 'Inactive peers cannot be suspended');
```

`newLedger()` returns an empty v2 ledger. `migrateLedger()` validates v2 unchanged or copies a valid v1 ledger with a fresh UUID lease for every peer. It must not mutate the input.

Implement:

```ts
export function peerPresence(peer: Peer, now = Date.now()): PeerPresence {
  if (!peer.active) return 'left';
  if (peer.suspended) return 'suspended';
  return now - peer.lastSeen <= ONLINE_WINDOW_MS ? 'online' : 'stale';
}
```

Update fresh `joinPeer` only enough to create `suspended: false` and `leaseId`; Task 2 changes participant-operation signatures atomically.

- [ ] **Step 4: Run GREEN**

```bash
node --test pi-messaging/tests/policy.test.mjs
npm run typecheck
git diff --check
```

Expected: complete policy suite PASS; no unsafe cast bypasses validation.

- [ ] **Step 5: Commit schema/migration**

```bash
git add pi-messaging/src/contracts.ts pi-messaging/src/policy.ts \
  pi-messaging/tests/policy.test.mjs
git commit -S -m "feat: add lease-aware messaging ledger migration"
```

### Task 2: Fence participant policy including atomic batches

**Files:**
- Modify: `pi-messaging/src/contracts.ts`
- Modify: `pi-messaging/src/policy.ts`
- Modify: `pi-messaging/tests/policy.test.mjs`

**Interfaces:**
- Consumes: `Ledger`, `StoredPeer`, `ParticipantLease`, and `peerPresence` from Task 1.
- Produces:

```ts
export function leaseOf(peer: StoredPeer): ParticipantLease;
export function requireLease(state: Ledger, lease: ParticipantLease): StoredPeer;
export function resumePeer(
  state: Ledger,
  ref: GroupRef,
  sessionId: string,
  peerId: string,
  now?: number,
): StoredPeer;
export function suspendPeer(state: Ledger, lease: ParticipantLease): void;
export function leavePeer(state: Ledger, lease: ParticipantLease): void;
export function revokePeer(state: Ledger, ref: GroupRef, peerId: string): void;
```

Change participant calls to exact leases:

```ts
heartbeat(state, lease, displayName?)
prepareMessage(state, senderLease, input, requestKey)
canReceive(state, recipientLease)
admitBatch(state, recipientLease, messageIds)
observeBatch(state, recipientLease, reservations)
```

- [ ] **Step 1: Write failing lifecycle and stale-lease tests**

Use deterministic timestamps. Join, capture the old lease, suspend, resume, and assert the same ID/name with a different lease. Assert the old lease fails heartbeat, rename, send, `canReceive`, `admitBatch`, `observeBatch`, suspend, and leave with a participation/lease error.

Cover stale and suspended resume, online rejection at exactly 30 seconds, wrong session/group/peer, inactive exclusion, concurrent logical resumers, active-slot preservation, and unchanged group counters.

- [ ] **Step 2: Write failing batch preservation tests**

Queue three messages from distinct senders to a recipient, suspend/resume it, admit all three with the new lease, and assert publication order and three credits consumed. Assert old-lease admission changes no message/allowance. Observe the complete ordered batch with the new lease; assert partial, duplicate, reordered, forged, or old-lease receipts mutate nothing.

Create an attempted message before suspension, resume, and assert another admission returns an empty batch with no credit or state change. Assert active stale/suspended recipients remain routable and queued-capacity reservation remains exact.

- [ ] **Step 3: Run RED**

```bash
node --test --test-name-pattern='lease|resume|suspended recipient|batch.*resume|old.*receipt' \
  pi-messaging/tests/policy.test.mjs
```

Expected: FAIL while operations still accept bare peer IDs.

- [ ] **Step 4: Implement lease authorization**

`requireLease` checks peer existence, active state, `!suspended`, exact UUID lease equality, and never accepts an optional/bare-ID bypass. `resumePeer` rechecks group, session ID, peer ID, active state, and `peerPresence !== 'online'`, then sets `suspended=false`, rotates `leaseId`, and updates `lastSeen`.

`suspendPeer` retains `active=true`, sets `suspended=true`, and rotates the stored lease. `leavePeer` sets `active=false`, `suspended=false`, and rotates the lease. `revokePeer` validates group attribution and performs the same finalization without the participant lease.

Use `requireLease` at the start of every participant mutation. Recipient validation for `prepareMessage` continues to use an active peer so stale/suspended recipients remain routable. `admitBatch` performs one lease check and preserves the current candidate order, bounds, credit-per-member, and all-or-nothing CAS mutation. `observeBatch` performs the lease check before validating the complete ordered correlations and before mutating any member.

- [ ] **Step 5: Run GREEN and regression suites**

```bash
node --test pi-messaging/tests/policy.test.mjs
node --test pi-messaging/tests/runtime.test.mjs
npm run typecheck
git diff --check
```

Expected: policy and runtime suites PASS; batch bounds/backpressure remain unchanged.

- [ ] **Step 6: Commit lease-aware policy**

```bash
git add pi-messaging/src/contracts.ts pi-messaging/src/policy.ts \
  pi-messaging/tests/policy.test.mjs
git commit -S -m "feat: fence batched messaging participation with leases"
```

### Task 3: Migrate backend and rebind preserved consumers

**Files:**
- Modify: `pi-messaging/src/contracts.ts`
- Modify: `pi-messaging/src/nats-backend.ts`
- Modify: `pi-messaging/tests/backend.test.mjs`

**Interfaces:**
- Consumes: lease-aware policy from Tasks 1–2.
- Produces backend methods:

```ts
resume(ref: GroupRef, peerId: string, sessionId: string): Promise<Peer>;
suspend(): Promise<void>;
leave(): Promise<void>; // explicit final leave
```

The backend stores a private `{ peer: Peer; lease: ParticipantLease }`; `peer` and `peers()` return defensive lease-free public copies.

- [ ] **Step 1: Write failing real-ledger migration tests**

Create a broker fixture, replace KV `state` with a literal valid v1 ledger containing allowance, queued work, and a complete attempted record, then connect an upgraded backend. Assert one revision produces v2 and the projection excluding `suspended`/`leaseId` equals the exact prior JSON. Reconnect and assert no second migration revision occurs. Retain initialized-state-loss rejection.

- [ ] **Step 2: Write failing consumer/inbox/batch resume tests**

With a real isolated broker, queue three messages from distinct senders to one recipient. Record peer ID/name, suspend and close it, connect a replacement, and resume the same ID/session. Assert ID/name/routing/message sequence/durable count are preserved; reserve returns one ordered three-member batch; observation terminates all three; exactly three existing credits are spent.

Separately preserve an attempted message through suspend/resume and assert reserve returns `[]`, attempt fields and allowance remain unchanged, and only explicit dismissal unblocks later work.

- [ ] **Step 3: Run RED**

```bash
PI_MESSAGING_REQUIRE_BROKER=1 \
NATS_SERVER=/tmp/pi-messaging-nats-2.14.6/nats-server-v2.14.6-linux-amd64/nats-server \
node --test --test-name-pattern='migrates v1|resumes.*batch|attempted.*resume' \
  pi-messaging/tests/backend.test.mjs
```

Expected: FAIL because backend migration/resume/suspend do not exist.

- [ ] **Step 4: Add CAS migration before backend exposure**

After opening the KV bucket and before returning a backend, read `state`, call `migrateLedger`, and update only when `migrated` is true. On explicit wrong revision, reread and validate the winner's v2 state. On any uncertain update, close and fail without guessing. New initialization writes v2 directly.

Do not change stream names, subjects, retention, limits, envelope version, high-water behavior, or broker-config version.

- [ ] **Step 5: Store private participation and centralize consumer binding**

Replace the cached public peer with:

```ts
private participant?: { peer: Peer; lease: ParticipantLease };
```

Fresh join receives a `StoredPeer`, retains `leaseOf(stored)` privately, and exposes `publicPeer(stored)`. Extract `bindConsumer(peerId, groupId)` that validates an existing durable or creates it with current exact settings: stream `PM_MESSAGES`, subject `pm.message.<group>.<peer>.*`, explicit ACK, deliver-all, `max_ack_pending: 8`, and `ack_wait: 5_000_000_000` ns.

Resume preflights `bindConsumer`, then performs the resume CAS and stores only the winner's new lease. Generation cancellation after CAS suspends that new lease. Suspend retains the durable. Explicit leave/revoke deletes it.

- [ ] **Step 6: Pass leases through every backend path**

Heartbeat/rename, send/deduplication, maintenance participation checks, reserve precheck, `admitBatch`, and `observeBatch` use the cached lease. Preserve current stream publication high-water and candidate selection.

If admission throws after bodies are pulled because the lease rotated, do not ACK those held bodies; let acknowledgment timeout/redelivery preserve them for the winner. Continue ACKing known stale pre-boundary transport residue and already-terminal messages exactly as current code does.

- [ ] **Step 7: Run real backend suite GREEN**

```bash
PI_MESSAGING_REQUIRE_BROKER=1 \
NATS_SERVER=/tmp/pi-messaging-nats-2.14.6/nats-server-v2.14.6-linux-amd64/nats-server \
node --test pi-messaging/tests/backend.test.mjs pi-messaging/tests/broker.test.mjs \
  pi-messaging/tests/failures.test.mjs
npm run typecheck
git diff --check
```

Expected: migration/resume tests and all existing high-water, oversubscription, restart, and no-replay tests PASS.

- [ ] **Step 8: Commit backend lifecycle**

```bash
git add pi-messaging/src/contracts.ts pi-messaging/src/nats-backend.ts \
  pi-messaging/tests/backend.test.mjs
git commit -S -m "feat: resume leased messaging peers"
```

### Task 4: Prove old-process and held-pull fencing

**Files:**
- Create: `pi-messaging/tests/helpers/lease-contender.mjs`
- Modify: `pi-messaging/tests/failures.test.mjs`
- Modify: `pi-messaging/src/nats-backend.ts` only for defects reproduced by these tests.

**Interfaces:**
- Consumes: backend `suspend`, `resume`, and private lease storage.
- Produces: process-level split-brain evidence; no new public runtime API.

- [ ] **Step 1: Create an independent stale-owner fixture**

The child joins a peer, reports only public peer metadata, and accepts bounded IPC commands for heartbeat, rename, send, reserve, observe, suspend, and leave. It never returns or accepts a lease. Each request returns `{ ok: true, value? }` or `{ ok: false, error }` with a parent timeout.

- [ ] **Step 2: Write stale-owner mutation tests RED**

Start the child, make its stored heartbeat stale using a controlled KV update, resume the same peer in the parent, then issue every child mutation. Assert each rejects with a lease/participation error. Assert parent heartbeat still succeeds, peer remains online, no child send exists, no allowance is consumed, and old leave/suspend cannot deactivate the winner.

- [ ] **Step 3: Write a held-pull race test RED**

Monkeypatch only the old test backend instance's public `snapshot` method, as existing failure tests already do. Count snapshot reads and block the admission snapshot after bodies have been pulled:

```js
const originalSnapshot = oldBackend.snapshot.bind(oldBackend);
let reads = 0;
let release;
let reached;
const blocked = new Promise(resolve => { release = resolve; });
const atAdmission = new Promise(resolve => { reached = resolve; });
oldBackend.snapshot = async () => {
  const snapshot = await originalSnapshot();
  if (++reads === 2) { reached(); await blocked; }
  return snapshot;
};
```

Let the old process pull three queued bodies, await `atAdmission`, rotate the lease through resume, then call `release()`. Assert old admission fails, none of its held bodies are ACKed, and the resumed owner later reserves the same ordered IDs as one batch with one credit per member. Do not add a production test hook.

- [ ] **Step 4: Run RED/focused race**

```bash
PI_MESSAGING_REQUIRE_BROKER=1 \
NATS_SERVER=/tmp/pi-messaging-nats-2.14.6/nats-server-v2.14.6-linux-amd64/nats-server \
node --test --test-name-pattern='rotated lease|held batch pull' pi-messaging/tests/failures.test.mjs
```

Expected before full backend fencing: FAIL. Never relax the exact message-ID or credit assertions.

- [ ] **Step 5: Fix only demonstrated backend defects**

Keep authorization inside policy CAS mutations. Do not add an optional lease path, auto-retry, replay, refund, ACK-on-error, or fresh-peer fallback. Preserve local membership-generation checks around asynchronous joins/resumes.

- [ ] **Step 6: Repeat the process races**

```bash
for i in 1 2 3; do
  PI_MESSAGING_REQUIRE_BROKER=1 \
  NATS_SERVER=/tmp/pi-messaging-nats-2.14.6/nats-server-v2.14.6-linux-amd64/nats-server \
  node --test --test-name-pattern='rotated lease|held batch pull' \
    pi-messaging/tests/failures.test.mjs || exit
done
```

Expected: all repeats PASS with no leaked children and exact per-message accounting.

- [ ] **Step 7: Commit fencing evidence**

```bash
git add pi-messaging/tests/helpers/lease-contender.mjs \
  pi-messaging/tests/failures.test.mjs pi-messaging/src/nats-backend.ts
git commit -S -m "test: prove resumed batch lease fencing"
```

### Task 5: Add explicit human resume and lifecycle suspension

**Files:**
- Modify: `pi-messaging/src/runtime.ts`
- Modify: `pi-messaging/src/ui.ts`
- Modify: `pi-messaging/extensions/messaging.ts`
- Modify: `pi-messaging/tests/extension.test.mjs`
- Modify: `pi-messaging/tests/quiet.test.mjs`
- Modify: `pi-messaging/tests/runtime.test.mjs`

**Interfaces:**
- Consumes: backend `resume`, `suspend`, `leave`, `peerPresence`.
- Produces:

```ts
MessagingRuntime.stop(disposition?: 'suspend' | 'leave'): Promise<void>;
```

Human resume starts the existing `MessagingRuntime` only through `controls.joined(ref)` after the confirmed backend operation.

- [ ] **Step 1: Write failing lifecycle disposition tests**

Replace fresh-ID-on-navigation expectations. Assert reload/shutdown/tree navigation suspend and preserve `active=true`/same ID; explicit `/messages leave` produces `left` and a later join creates a fresh ID; same-group repeated join is a no-op; cross-group join still requires final leave.

Assert a pending exact combined receipt arriving after suspension cannot observe its batch and spends/refunds nothing beyond the already committed attempts.

- [ ] **Step 2: Write failing resume UX tests**

Cover:

- one stale/suspended same-session candidate appears in confirmation and preserves ID/role;
- any online same-session match rejects without takeover UI;
- several candidates require a numbered picker containing role, full/compact session attribution, presence, age, and unresolved metadata count;
- canceled picker/confirmation makes no mutation;
- a late dialog after tree/session change cannot resume into the replacement context;
- resume grants no allowance, reads no body, delivers no custom message, and invokes no model.

- [ ] **Step 3: Run RED**

```bash
node --test --test-name-pattern='resume|suspend|online match|multiple candidates|repeated join' \
  pi-messaging/tests/extension.test.mjs pi-messaging/tests/runtime.test.mjs
```

Expected: FAIL because lifecycle currently calls final leave and join always creates a fresh identity.

- [ ] **Step 4: Separate suspend from final leave**

Implement runtime stop as:

```ts
async stop(disposition: 'suspend' | 'leave' = 'suspend'): Promise<void> {
  this.deactivate();
  this.host.status(undefined);
  if (disposition === 'leave') await this.backend.leave();
  else await this.backend.suspend();
}
```

Extension startup/shutdown/replacement/tree paths use suspension. Human `/messages leave` uses final leave. If suspension transport fails, clear/close local state and allow the stored peer to become stale; never reinterpret it as final leave.

- [ ] **Step 5: Implement metadata-only candidate selection**

For exact session ID and group, derive presence with the shared 30-second rule. If any match is online, fail before confirmation. Active stale/suspended matches are candidates. Count unresolved recipient records from `listMessages` using only status metadata (`queued` or `attempted`), never `readBody`.

One candidate is named in confirmation. Several use a numbered choice and select by array index rather than label identity. After confirmation call `backend.resume`; its CAS rechecks every condition. Fresh `join` is allowed only when no candidate exists.

- [ ] **Step 6: Update human and agent presence without context mutation**

Human status/compose/revoke/pickers label `online`, `stale`, `suspended`, and `left`. Agent `peer_message peers` continues to filter inactive peers and reports only `online`, `stale`, or `suspended`. Do not add a tool action, tool-description mutation, context hook, hidden message, lease, unresolved count, or resume control to the model API.

- [ ] **Step 7: Run GREEN across lifecycle/quiet/cache**

```bash
node --test pi-messaging/tests/extension.test.mjs pi-messaging/tests/quiet.test.mjs \
  pi-messaging/tests/runtime.test.mjs pi-messaging/tests/coexistence.test.mjs \
  pi-messaging/tests/cache-stability.test.mjs
npm run typecheck
git diff --check
```

Expected: explicit human resume, quiet combined delivery, API-only identity, and byte-stable request-prefix tests PASS.

- [ ] **Step 8: Commit UX/lifecycle behavior**

```bash
git add pi-messaging/src/runtime.ts pi-messaging/src/ui.ts \
  pi-messaging/extensions/messaging.ts pi-messaging/tests/extension.test.mjs \
  pi-messaging/tests/quiet.test.mjs pi-messaging/tests/runtime.test.mjs
git commit -S -m "feat: resume messaging identity across Pi lifecycle"
```

### Task 6: Documentation, compatibility, review, and inactive handoff

**Files:**
- Modify: `pi-messaging/README.md`

**Interfaces:**
- Consumes: completed lifecycle behavior.
- Produces: exact operator semantics and verification evidence; no new code API.

- [ ] **Step 1: Replace obsolete fresh-membership documentation**

Document explicit rejoin/resume, suspension versus final leave/revoke, online blocking, candidate selection, preserved queue/attempt behavior, retained active slots, private leases, v1 migration fencing, infrastructure-only autostart, and the human-controlled rollout sequence. Retain no claim of automatic membership, replay, refund, or provider cache-hit percentage.

- [ ] **Step 2: Run mandatory full verification**

```bash
PI_MESSAGING_REQUIRE_BROKER=1 \
NATS_SERVER=/tmp/pi-messaging-nats-2.14.6/nats-server-v2.14.6-linux-amd64/nats-server \
npm test
npm run typecheck
npm run lint:shell
npm run check
git diff --check
```

Expected: all repository/workspace tests PASS and no broker-required test skips.

- [ ] **Step 3: Run minimum/current Node and real SDK matrices**

```bash
export PI_MESSAGING_REQUIRE_BROKER=1
export NATS_SERVER=/tmp/pi-messaging-nats-2.14.6/nats-server-v2.14.6-linux-amd64/nats-server

/home/bits/.npm/_npx/992a19d7d9bf36d4/node_modules/node/bin/node \
  --test pi-messaging/tests/*.test.mjs
/home/bits/.npm/_npx/387698761821791d/node_modules/node/bin/node \
  --test pi-messaging/tests/*.test.mjs

PI_OFFLINE=1 node --test pi-messaging/tests/extension.test.mjs \
  pi-messaging/tests/quiet.test.mjs pi-messaging/tests/cache-stability.test.mjs
PI_OFFLINE=1 \
PI_MESSAGING_PI_SDK=/home/linuxbrew/.linuxbrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js \
node --test pi-messaging/tests/extension.test.mjs \
  pi-messaging/tests/quiet.test.mjs pi-messaging/tests/cache-stability.test.mjs
```

Expected: every matrix PASS with no paid inference and no live broker access.

- [ ] **Step 4: Verify production-only package installation**

```bash
tmp="$(mktemp -d /tmp/pi-messaging-production.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
cp -R pi-messaging "$tmp/package"
npm install --omit=dev --ignore-scripts --package-lock=false --legacy-peer-deps --prefix "$tmp/package"
node --experimental-strip-types -e \
  "Promise.all([import('$tmp/package/src/broker-lifecycle.ts'), import('$tmp/package/src/nats-backend.ts'), import('$tmp/package/extensions/messaging.ts')])"
rm -rf "$tmp"
trap - EXIT
```

Expected: all three entrypoints import with runtime dependencies only.

- [ ] **Step 5: Request fresh independent review**

Give the reviewer the approved forward-port spec, both plans, base commit, legacy-reference branch name, and complete diff. Require review of migration preservation, lease coverage, batch admission/receipt atomicity, pulled-body ACK behavior, consumer rebinding, human-only resume, process startup authority, context/cache stability, and live-state isolation. Fix all confirmed Critical and Important findings with focused RED/GREEN evidence and repeat aggregate verification.

- [ ] **Step 6: Commit final documentation/review fixes**

```bash
git add pi-messaging/README.md
git commit -S -m "docs: document safe messaging lifecycle resume"
```

If review fixes changed code/tests, include them in a separate signed fix commit before the documentation commit.

- [ ] **Step 7: Stop before operational rollout**

Do not install NATS, apply chezmoi, reload live Pi sessions, connect new code to the live ledger, stop/start the live broker, or alter any live group/message/allowance. Report the signed branch and exact human sequence from the spec. Preserve `feat/pi-messaging-lifecycle` until the replacement is merged, pushed, and later live-verified.
