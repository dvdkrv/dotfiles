# Pi Messaging Cache Stability and Bounded Batch Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove transient messaging identity context, reserve queue capacity at send time, and deliver up to eight pending peer messages in one conservative atomic batch and one model turn.

**Architecture:** Keep live identity behind the stationary `peer_message` API and make incoming peer content the only messaging-owned conversation entry. Extend the existing ledger CAS policy from one-message admission/observation to ordered arrays of individual reservations; NATS still stores individual bodies and the runtime combines one admitted batch into one append-only Pi custom message.

**Tech Stack:** TypeScript 7, Node.js 22.19+, Pi SDK 0.82.0 and 0.84.1, NATS JetStream/KV 3.4.0, nats-server 2.14.6, Node test runner, jiti.

## Global Constraints

- Humans exclusively control join, leave, arm, pause, revoke, recovery, and agent launching.
- Every message consumes one shared allowance credit when admitted; queued messages reserve but do not spend capacity.
- Never replay or refund an uncertain or attempted message automatically.
- Admit only while the recipient is idle and deliver only with `deliverAs: "followUp"`, never steering.
- A sender may have at most one unresolved outbound message; a recipient may have at most eight queued messages.
- Message bodies remain at most 8 KiB UTF-8 and must not enter metadata-only APIs.
- Broker tokens and lifecycle leases never enter custom-message details, tool output, logs, tests, or public state.
- Tests use isolated broker stores and scripted providers only; they must not touch live groups, messages, allowances, sessions, or broker persistence.
- Do not promise a provider cache-hit percentage; prove only zero avoidable messaging-owned request-prefix mutation.
- Keep `feat/pi-messaging-lifecycle` unmerged and inactive.
- All commits must be SSH-signed; never disable signing.

---

## File map

- `pi-messaging/extensions/messaging.ts` — remove dynamic context injection and expose complete self identity through the tool API.
- `pi-messaging/src/identity.ts` — retain only stationary API-first guidance and human-facing peer labels.
- `pi-messaging/src/contracts.ts` — change backend reservation and observation contracts from one reservation to an ordered batch.
- `pi-messaging/src/policy.ts` — enforce queue reservations and sender/recipient bounds; perform atomic batch admission and observation.
- `pi-messaging/src/nats-backend.ts` — pull, validate, CAS-admit, and acknowledge up to eight individual JetStream messages as one batch.
- `pi-messaging/src/runtime.ts` — render one combined custom message and correlate one receipt to every batch member.
- `pi-messaging/tests/policy.test.mjs` — deterministic RED/GREEN tests for capacity, backpressure, and batch transactions.
- `pi-messaging/tests/backend.test.mjs` — real-NATS batch ordering, allowance, and API tests.
- `pi-messaging/tests/failures.test.mjs` — real-NATS uncertainty, replay, pause, and restart behavior.
- `pi-messaging/tests/extension.test.mjs` — no-context-hook and API-only identity tests.
- `pi-messaging/tests/runtime.test.mjs` — combined delivery and receipt-correlation tests.
- `pi-messaging/tests/quiet.test.mjs` — real Pi SDK idle/busy and one-turn batch acceptance.
- `pi-messaging/tests/helpers/contender.mjs` — adapt concurrent admission helper to array reservations if used by broker tests.
- `pi-messaging/README.md` and the prior messaging specs — document API-only identity, capacity reservation, sender fencing, and batching.

---

### Task 1: Remove dynamic identity context and make identity API-only

**Files:**
- Modify: `pi-messaging/extensions/messaging.ts`
- Modify: `pi-messaging/src/identity.ts`
- Modify: `pi-messaging/tests/extension.test.mjs`
- Modify: `pi-messaging/tests/coexistence.test.mjs`

**Interfaces:**
- Consumes: existing `peer_message` actions and `MessagingBackend.peer`.
- Produces: `peer_message peers` result with `selfId`, `selfSessionId`, and `selfDisplayName`; no messaging `context` handler.

- [ ] **Step 1: Replace transient-context tests with failing API-only tests**

In `pi-messaging/tests/extension.test.mjs`, replace the identity-context and bounded-onboarding tests with assertions equivalent to:

```js
test('messaging exposes identity only through the API and registers no context hook', async t => {
  const f = fixture(t);
  assert.equal(f.events.has('context'), false);
  await f.commands.get('messages').handler('join review', f.ctx);
  const result = await execute(f, 'peers', {});
  const value = JSON.parse(result.content[0].text);
  assert.deepEqual(
    { id: value.selfId, sessionId: value.selfSessionId, displayName: value.selfDisplayName },
    { id: f.backend.peer.id, sessionId: 'local', displayName: 'local' },
  );
  assert.equal(f.delivered.some(([m]) => m.customType === 'pi-messaging.identity.v1'), false);
});
```

Also assert that the registered tool's description and guidance contain no current group ID, peer ID, session ID, display name, timestamp, or allowance value. In `coexistence.test.mjs`, retain the assertion that neither messaging nor loops call `setActiveTools()`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --test pi-messaging/tests/extension.test.mjs pi-messaging/tests/coexistence.test.mjs
```

Expected: FAIL because a `context` handler is registered and `selfDisplayName` is absent.

- [ ] **Step 3: Remove transient state and rewrite stationary guidance**

In `extensions/messaging.ts`:

- remove `IDENTITY_CONTEXT_TYPE` and `NAMING_GUIDANCE` imports;
- remove `onboardedPeer` and `namingHintsLeft` state and reset logic;
- delete the entire `pi.on('context', ...)` handler;
- add `selfDisplayName: self.displayName` to the `peers` result.

In `src/identity.ts`, delete `IDENTITY_CONTEXT_TYPE` and the transient-note wording. Keep `QUIET_GUIDANCE` stationary and add one stationary API-first guideline with this meaning:

```ts
export const API_GUIDANCE = 'Use peer_message action peers to obtain your current messaging identity and routing IDs when an assigned exchange requires messaging. Use API results rather than assuming identity from conversation context. If your human-assigned role is known and your current display name is still the session ID, action rename may set a concise role name. Do not invent work, poll, send introductions, or repeatedly rename.';
```

Import `API_GUIDANCE` into the tool's static `promptGuidelines`. Do not put runtime values in tool metadata.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
node --test pi-messaging/tests/extension.test.mjs pi-messaging/tests/coexistence.test.mjs
npm run typecheck
```

Expected: PASS, with no messaging context handler and no active-tool mutation.

- [ ] **Step 5: Commit the cache-boundary change**

```bash
git add pi-messaging/extensions/messaging.ts pi-messaging/src/identity.ts \
  pi-messaging/tests/extension.test.mjs pi-messaging/tests/coexistence.test.mjs
git commit -S -m "fix: remove transient messaging identity context"
```

---

### Task 2: Enforce queue-capacity reservations and sender/recipient backpressure

**Files:**
- Modify: `pi-messaging/src/policy.ts`
- Modify: `pi-messaging/tests/policy.test.mjs`

**Interfaces:**
- Consumes: existing `Ledger`, `Group`, `MessageStatus`, `prepareMessage()`, `arm()`, and terminal message states.
- Produces: exported `MAX_QUEUED_PER_RECIPIENT = 8`; send-time capacity, one-unresolved-sender, and recipient queue gates.

- [ ] **Step 1: Add failing policy tests for every queue invariant**

Add focused tests using separate active senders where distinct unresolved messages are required:

```js
test('queued messages reserve allowance without spending it', () => {
  const f = fixture();
  const c = p.joinPeer(f.state, f.group, { sessionId: 'c', displayName: 'C' });
  p.arm(f.state, f.group, 2);
  send(f, 'a-one');
  p.prepareMessage(f.state, c.id, { toPeerId: f.b.id, text: 'two' }, 'c-one');
  assert.equal(f.state.groups[f.group.id].used, 0);
  assert.throws(
    () => p.prepareMessage(f.state, p.joinPeer(f.state, f.group, { sessionId: 'd', displayName: 'D' }).id,
      { toPeerId: f.b.id, text: 'three' }, 'd-one'),
    /allowance|capacity/i,
  );
});
```

Cover these cases separately:

- send before first arm fails;
- paused with free capacity may queue, exhausted may not;
- canceling queued work releases capacity;
- same-key retry succeeds after capacity closes;
- conflicting same-key retry still fails;
- one sender's second queued or attempted outbound fails;
- observed, canceled, and dismissed terminal outbound states release the sender gate;
- ninth queued message to one recipient fails using nine distinct senders;
- `arm(ref, limit)` fails without mutation when `limit` is below current queued count.

Adjust the old test that queued 64 messages from one sender: the new sender and 16-peer bounds intentionally make that setup invalid. Retain global retention coverage by creating terminal records or by directly constructing valid retained records rather than bypassing the new unresolved-send policy.

- [ ] **Step 2: Run policy tests and verify RED**

```bash
node --test pi-messaging/tests/policy.test.mjs
```

Expected: FAIL on pre-arm capacity, sender backpressure, recipient bound, and rearm validation.

- [ ] **Step 3: Implement derived capacity checks without a ledger migration**

Add:

```ts
export const MAX_QUEUED_PER_RECIPIENT = 8;
const unresolved = (m: MessageStatus) => m.state === 'queued' || m.state === 'attempted';
const queuedInGroup = (s: Ledger, groupId: string) =>
  Object.values(s.messages).filter(m => m.groupId === groupId && m.state === 'queued');
```

In `prepareMessage()`, preserve validation and existing-request lookup first. For a genuinely new request, enforce in this order:

```ts
const group = s.groups[sender.groupId];
if (Object.values(s.messages).some(m => m.senderPeerId === sender.id && unresolved(m)))
  fail('busy', 'Sender already has an unresolved outbound message');
const queued = queuedInGroup(s, group.id);
if (queued.filter(m => m.recipientPeerId === recipient.id).length >= MAX_QUEUED_PER_RECIPIENT)
  fail('full', 'Recipient already has eight queued messages');
if (group.limit - group.used - queued.length <= 0)
  fail('allowance', 'No unspent messaging allowance remains for another queued message');
```

Keep the existing global/group storage bounds after these semantic gates. In `arm()`, count queued messages before mutation and reject `limit < queued.length`. Do not count attempted records as new-round queue reservations.

- [ ] **Step 4: Run policy and backend unit-facing tests**

```bash
node --test pi-messaging/tests/policy.test.mjs pi-messaging/tests/extension.test.mjs pi-messaging/tests/runtime.test.mjs
npm run typecheck
```

Expected: PASS. Broker tests may still use single-reservation semantics until Task 4.

- [ ] **Step 5: Commit send-time flow control**

```bash
git add pi-messaging/src/policy.ts pi-messaging/tests/policy.test.mjs
git commit -S -m "feat: reserve messaging allowance at enqueue time"
```

---

### Task 3: Add atomic policy-level batch admission and observation

**Files:**
- Modify: `pi-messaging/src/policy.ts`
- Modify: `pi-messaging/tests/policy.test.mjs`

**Interfaces:**
- Consumes: `MAX_QUEUED_PER_RECIPIENT`, `canReceive()`, `Reservation`, and existing per-message attempt metadata.
- Produces:
  - `admitBatch(s: Ledger, peerId: string, messageIds: readonly string[]): Reservation[]`
  - `observeBatch(s: Ledger, reservations: readonly Reservation[]): void`
  - compatibility wrappers `admit()` and `observe()` for focused single-message callers until all callers migrate.

- [ ] **Step 1: Write failing atomic-batch tests**

Add tests that prepare messages from distinct senders to one recipient and assert:

```js
const batch = p.admitBatch(f.state, f.b.id, [first.id, second.id, third.id]);
assert.deepEqual(batch.map(r => r.message.id), [first.id, second.id, third.id]);
assert.equal(new Set(batch.map(r => r.attemptId)).size, 3);
assert.equal(f.state.groups[f.group.id].used, 3);
assert.ok(batch.every(r => r.round === f.state.groups[f.group.id].round));
```

Also cover:

- zero, duplicate, and more-than-eight IDs are rejected or return no admission without mutation as appropriate;
- another recipient's ID fails as corruption/validation rather than being delivered;
- terminal candidates are skipped while queued candidates are admitted in input order;
- legacy overflow admits only remaining allowance and leaves excess queued;
- any older attempted record for the recipient blocks the whole new batch;
- `observeBatch()` observes all matching members in one mutation;
- one forged or duplicated reservation rejects the supplied observation without observing any member;
- a valid supplied subset can be observed at policy level because batches are not persisted as new ledger entities; the runtime is responsible for requiring the exact complete delivered batch;
- dismissed members remain dismissed while receiving `observedAt`.

- [ ] **Step 2: Run the batch policy tests and verify RED**

```bash
node --test pi-messaging/tests/policy.test.mjs --test-name-pattern='batch|allowance'
```

Expected: FAIL because `admitBatch` and `observeBatch` do not exist.

- [ ] **Step 3: Implement batch admission as one in-memory mutation**

Implement `admitBatch()` so it validates the input bound and uniqueness, checks `canReceive()` once, filters same-recipient queued candidates in caller order, limits selection to `group.limit - group.used`, and only then mutates every selected message:

```ts
export function admitBatch(s: Ledger, peerId: string, messageIds: readonly string[]): Reservation[] {
  if (messageIds.length === 0) return [];
  if (messageIds.length > MAX_QUEUED_PER_RECIPIENT || new Set(messageIds).size !== messageIds.length)
    fail('validation', 'Invalid messaging batch');
  if (!canReceive(s, peerId)) return [];
  const peer = activePeer(s, peerId);
  const group = s.groups[peer.groupId];
  const selected: MessageStatus[] = [];
  for (const id of messageIds) {
    const message = Object.hasOwn(s.messages, id) ? s.messages[id] : undefined;
    if (!message || message.state !== 'queued') continue;
    if (message.recipientPeerId !== peerId || message.groupId !== group.id)
      fail('corrupt', 'Batch candidate belongs to another inbox');
    if (selected.length < group.limit - group.used) selected.push(message);
  }
  const now = Date.now();
  return selected.map(message => {
    message.state = 'attempted';
    message.attemptId = randomUUID();
    message.attemptRound = group.round;
    message.attemptedAt = now;
    group.used++;
    if (group.used === group.limit) group.mode = 'exhausted';
    return { group: refOf(group), peerId, message: { ...message }, attemptId: message.attemptId, round: group.round };
  });
}
```

Do not allow `used > limit`. Keep `admit()` as `admitBatch(...)[0] ?? null`.

- [ ] **Step 4: Implement all-or-none batch receipt validation**

`observeBatch()` must first validate a nonempty, unique, same-group, same-peer list and every message correlation without mutation. Only after all supplied reservations validate should it set observation fields. Keep `observe()` as a one-element wrapper.

```ts
export function observeBatch(s: Ledger, reservations: readonly Reservation[]): void {
  if (reservations.length === 0 || reservations.length > MAX_QUEUED_PER_RECIPIENT)
    fail('receipt', 'Invalid receipt batch');
  const ids = reservations.map(r => r.message.id);
  if (new Set(ids).size !== ids.length) fail('receipt', 'Duplicate receipt correlation');
  const first = reservations[0];
  groupOf(s, first.group);
  const messages = reservations.map(r => {
    if (r.peerId !== first.peerId || r.group.id !== first.group.id || r.group.authorityId !== first.group.authorityId)
      fail('receipt', 'Mixed receipt batch');
    const message = Object.hasOwn(s.messages, r.message.id) ? s.messages[r.message.id] : undefined;
    if (!message || message.groupId !== r.group.id || message.recipientPeerId !== r.peerId ||
        message.attemptId !== r.attemptId || message.attemptRound !== r.round ||
        !['attempted', 'observed', 'dismissed'].includes(message.state))
      fail('receipt', 'Invalid receipt correlation');
    return message;
  });
  const now = Date.now();
  for (const message of messages) {
    message.observedAt ??= now;
    if (message.state === 'attempted') { message.state = 'observed'; message.terminalAt = now; }
  }
}
```

Do not infer delivery order from ledger sequence: concurrent publication order may differ from metadata reservation order. The runtime retains the exact admitted array and enforces complete receipt length and order. Policy enforces atomic validation of the reservations it is given, then mutates every validated message in one pass.

- [ ] **Step 5: Run tests and commit**

```bash
node --test pi-messaging/tests/policy.test.mjs
npm run typecheck
git add pi-messaging/src/policy.ts pi-messaging/tests/policy.test.mjs
git commit -S -m "feat: admit peer messages in atomic batches"
```

Expected: PASS.

---

### Task 4: Make the NATS backend reserve and observe batches

**Files:**
- Modify: `pi-messaging/src/contracts.ts`
- Modify: `pi-messaging/src/nats-backend.ts`
- Modify: `pi-messaging/tests/backend.test.mjs`
- Modify: `pi-messaging/tests/failures.test.mjs`
- Modify: `pi-messaging/tests/broker.test.mjs`
- Modify: `pi-messaging/tests/helpers/contender.mjs`

**Interfaces:**
- Consumes: `policy.admitBatch()` and `policy.observeBatch()`.
- Produces:
  - `MessagingBackend.reserve(): Promise<Reservation[]>`
  - `MessagingBackend.observe(reservations: readonly Reservation[]): Promise<void>`
  - durable consumer configuration with `max_ack_pending: 8`.

- [ ] **Step 1: Change contract expectations in real-broker tests**

Update calls from:

```js
const reservation = await receiver.reserve();
await receiver.observe(reservation);
```

to:

```js
const reservations = await receiver.reserve();
assert.equal(reservations.length, expectedCount);
await receiver.observe(reservations);
```

Use at least three distinct sender backends to queue a mixed-sender batch. Assert ordered message IDs, exact bodies, `used === batch.length`, and one attempted record per member. Change every expected empty result from `null` to `[]`.

Adapt tests that previously queued a second message from the same unresolved sender: observe or cancel the first first, or use another sender when the test is specifically about recipient admission fencing.

- [ ] **Step 2: Add failing broker tests for batch transaction boundaries**

With the pinned isolated broker, cover:

- three messages from three senders return in publication order in one `reserve()`;
- eight messages form one maximum batch;
- a ninth recipient message is rejected before publication;
- paused-before-CAS returns `[]`, spends zero, and leaves queued bodies available;
- a terminal replay is acknowledged without appearing in the returned batch;
- a broker restart leaves every admitted member attempted and does not replay it;
- a lost KV acknowledgment may leave every candidate attempted but returns no usable batch;
- a missing body does not invent content or prevent a later valid body from eventually being admitted.

Run with:

```bash
PI_MESSAGING_REQUIRE_BROKER=1 NATS_SERVER="$NATS_SERVER" \
  node --test pi-messaging/tests/backend.test.mjs pi-messaging/tests/broker.test.mjs pi-messaging/tests/failures.test.mjs
```

Expected: FAIL on scalar return values and consumer `max_ack_pending: 1`.

- [ ] **Step 3: Change backend contracts and consumer configuration**

In `contracts.ts`:

```ts
reserve(): Promise<Reservation[]>;
observe(reservations: readonly Reservation[]): Promise<void>;
```

Change every created or validated durable consumer to `max_ack_pending: 8`. Do not change `DeliverPolicy.All`, explicit acknowledgments, body subjects, stream limits, or durable identity.

- [ ] **Step 4: Implement bounded pull, validation, CAS, and acknowledgments**

At reservation start, snapshot the IDs currently queued for this recipient; this set defines the batch boundary. Replace the scalar `consumer.next()` path with bounded `consumer.fetch({ max_messages: 8, expires: remainingMs })` collections. Repeat within one overall one-second deadline when a fetch contains only terminal replays, stopping after eight held candidates or 64 drained stale records. For each `JsMsg`:

1. parse the envelope;
2. validate it against the current authoritative message when present;
3. acknowledge older missing/terminal ledger records;
4. hold valid queued bodies whose IDs were in the starting snapshot without acknowledging them;
5. negatively acknowledge and stop at a newly published queued ID outside the starting snapshot; and
6. preserve consumer publication order.

This prevents messages published after reservation began from joining the current batch while allowing bounded cleanup of durable-consumer replay backlog.

Perform one `change()` call with all held IDs and `policy.admitBatch()`. Match returned reservations back to envelopes by message ID. After a confirmed CAS:

- acknowledge terminal and admitted bodies;
- negatively acknowledge queued candidates not admitted because pause, membership, or allowance changed;
- return only reservations with validated envelopes attached.

If the CAS outcome is uncertain, let `change()` fail the backend and return no reservations to the runtime. Do not automatically retry the batch. Keep `fetching` as the single-flight guard.

Implement observation as:

```ts
async observe(reservations: readonly Reservation[]): Promise<void> {
  const peer = this.joined();
  if (reservations.some(r => r.peerId !== peer.id))
    policy.fail('receipt', 'Receipt is not from this participation');
  await this.change(s => policy.observeBatch(s, reservations));
}
```

- [ ] **Step 5: Run real broker tests and typecheck**

```bash
PI_MESSAGING_REQUIRE_BROKER=1 NATS_SERVER="$NATS_SERVER" npm test --workspace pi-messaging
npm run typecheck
```

Expected: PASS with no broker-test skips.

- [ ] **Step 6: Commit backend batching**

```bash
git add pi-messaging/src/contracts.ts pi-messaging/src/nats-backend.ts \
  pi-messaging/tests/backend.test.mjs pi-messaging/tests/broker.test.mjs \
  pi-messaging/tests/failures.test.mjs pi-messaging/tests/helpers/contender.mjs
git commit -S -m "feat: reserve peer messages as one broker batch"
```

---

### Task 5: Deliver and observe one combined runtime message

**Files:**
- Modify: `pi-messaging/src/runtime.ts`
- Modify: `pi-messaging/tests/runtime.test.mjs`
- Modify: `pi-messaging/extensions/messaging.ts`
- Modify: `pi-messaging/tests/extension.test.mjs`

**Interfaces:**
- Consumes: batch-returning `MessagingBackend.reserve()` and batch-taking `observe()`.
- Produces: one `PeerBatchMessage` custom message with ordered receipt correlations and one Pi follow-up per batch.

- [ ] **Step 1: Write failing runtime batch tests**

Change the runtime fixture so `reserve()` returns arrays. Add a three-member reservation batch and assert:

```js
await runtime.wake();
assert.equal(calls.length, 1);
const [message, options] = calls[0];
assert.deepEqual(options, { triggerTurn: true, deliverAs: 'followUp' });
assert.equal(message.customType, 'pi-messaging.peer.v1');
assert.deepEqual(message.details.messages.map(x => x.messageId), reservations.map(r => r.message.id));
for (const envelope of reservations.map(r => r.envelope))
  assert.ok(message.content.includes(envelope.text.replace('\x1b', '\\u001b')));
```

Cover:

- one admitted message still uses the batch shape;
- every content block is escaped and clearly delimited;
- one matching custom-message receipt observes all members once;
- partial, duplicate, reordered, wrong-peer, wrong-round, and wrong-attempt details observe none;
- synchronous receipt remains safe because all correlations are installed before host delivery;
- leave during reservation delivers no batch;
- an idle-to-busy race queues exactly one combined follow-up.

- [ ] **Step 2: Run runtime/extension tests and verify RED**

```bash
node --test pi-messaging/tests/runtime.test.mjs pi-messaging/tests/extension.test.mjs
```

Expected: FAIL because runtime expects one reservation and scalar receipt details.

- [ ] **Step 3: Define batch message details and deterministic rendering**

Replace scalar details with:

```ts
interface ReceiptCorrelation {
  messageId: string;
  attemptId: string;
  round: number;
}
export interface PeerBatchMessage {
  customType: string;
  content: string;
  display: boolean;
  details: {
    authorityId: string;
    groupId: string;
    peerId: string;
    messages: ReceiptCorrelation[];
  };
}
```

Render one stable header and numbered blocks in reservation order. Each block must include sender attribution, routing IDs, message ID, creation time, optional `inReplyTo`, and escaped peer text. Do not include leases, request keys, hashes, broker subjects, or tokens.

- [ ] **Step 4: Implement one-flight batch delivery and all-member receipt**

In `pump()`:

- treat `[]` as no admission;
- validate every reservation and envelope before mutating runtime correlation state;
- store the exact ordered array in `pendingBatch` before the host call;
- make one host call with one combined custom message;
- keep the existing generation, participation, idle, and no-intervening-await fences.

Replace the scalar-attempt map with `private pendingBatch?: Reservation[]` and one receipt-in-flight guard. The recipient-attempt ledger gate guarantees that only one batch can be unresolved. Clear `pendingBatch` during runtime deactivation.

In `receipt()`:

- require exact array length and order against `pendingBatch`;
- reject duplicate IDs and any correlation mismatch before calling the backend;
- set the receipt-in-flight guard before awaiting;
- call `backend.observe(pendingBatch)` once;
- clear the batch only after success;
- stop automatically on uncertain backend failure without replay.

- [ ] **Step 5: Run focused tests and commit**

```bash
node --test pi-messaging/tests/runtime.test.mjs pi-messaging/tests/extension.test.mjs
npm run typecheck
git add pi-messaging/src/runtime.ts pi-messaging/extensions/messaging.ts \
  pi-messaging/tests/runtime.test.mjs pi-messaging/tests/extension.test.mjs
git commit -S -m "feat: deliver pending peer messages in one turn"
```

Expected: PASS.

---

### Task 6: Prove one-turn delivery and append-only request shape with the real Pi SDK

**Files:**
- Modify: `pi-messaging/tests/quiet.test.mjs`
- Create: `pi-messaging/tests/cache-stability.test.mjs`

**Interfaces:**
- Consumes: complete API-only extension, batch backend, and combined runtime message.
- Produces: scripted-provider acceptance coverage against development and installed Pi SDKs.

- [ ] **Step 1: Adapt quiet tests to array reservations**

Change the admission barrier from `if (r)` to `if (r.length > 0)`. Preserve the existing proof that busy notifications do not call `reserve()`, and that an idle-to-busy race spends credits before queuing one Pi follow-up.

- [ ] **Step 2: Add a failing real-SDK mixed-sender batch test**

Create three sender backends, each with one permitted unresolved outbound, arm at least three credits, and queue three distinct markers to the joined recipient. Use a scripted provider that returns one final text response without tools for the peer batch. Assert:

```js
assert.equal(peerRequests.length, 1);
assert.ok(peerRequests[0].includes('BATCH_MARKER_1'));
assert.ok(peerRequests[0].includes('BATCH_MARKER_2'));
assert.ok(peerRequests[0].includes('BATCH_MARKER_3'));
assert.equal((await reader.getGroupSummary(group)).used, 3);
assert.ok((await reader.listMessages(group)).every(m => m.state === 'observed'));
```

The test must also assert that joining itself caused zero provider requests.

- [ ] **Step 3: Add the request-prefix regression test**

In `cache-stability.test.mjs`, use a real Pi session with the messaging extension and a scripted provider. Capture canonical request-visible system prompts, tool definitions, and message arrays for a peer-triggered request followed by a tool-result continuation. Assert:

- no request-visible message text contains the former transient identity or onboarding guidance;
- system prompt and canonical tool definitions are byte-identical;
- the complete first request-visible message array is an exact prefix of the second request-visible message array, followed by the scripted assistant/tool-result tail;
- the incoming peer batch text appears once at an append-only position;
- no third provider request occurs.

Do not call OpenAI or any other external model.

- [ ] **Step 4: Run SDK acceptance against both Pi installations**

```bash
PI_MESSAGING_REQUIRE_BROKER=1 NATS_SERVER="$NATS_SERVER" \
  node --test pi-messaging/tests/quiet.test.mjs pi-messaging/tests/cache-stability.test.mjs
PI_MESSAGING_REQUIRE_BROKER=1 NATS_SERVER="$NATS_SERVER" \
  PI_MESSAGING_PI_SDK=/home/linuxbrew/.linuxbrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js \
  node --test pi-messaging/tests/quiet.test.mjs pi-messaging/tests/cache-stability.test.mjs
```

Expected: PASS with scripted providers and zero paid inference.

- [ ] **Step 5: Run minimum/current Node checks and commit**

Use exact temporary Node distributions if those versions are not installed globally:

```bash
npx -y node@22.19.0 --test pi-messaging/tests/runtime.test.mjs pi-messaging/tests/policy.test.mjs
npx -y node@24.20.0 --test pi-messaging/tests/runtime.test.mjs pi-messaging/tests/policy.test.mjs
git add pi-messaging/tests/quiet.test.mjs pi-messaging/tests/cache-stability.test.mjs
git commit -S -m "test: prove cache-stable batched peer delivery"
```

Expected: PASS on both Node versions.

---

### Task 7: Update operator and design documentation

**Files:**
- Modify: `pi-messaging/README.md`
- Modify: `docs/superpowers/specs/2026-09-08-pi-messaging-design.md`
- Modify: `docs/superpowers/specs/2026-09-09-pi-messaging-quiet-design.md`
- Modify: `docs/superpowers/specs/2026-09-09-pi-messaging-role-names-design.md`
- Modify: `docs/superpowers/specs/2026-09-11-pi-messaging-cache-and-batching-design.md` only if implementation names differ from the approved design

**Interfaces:**
- Consumes: final implemented behavior and exact command/error semantics.
- Produces: one consistent operator contract with supersession links.

- [ ] **Step 1: Update README behavior and recovery guidance**

Document explicitly:

- identity is obtained through `peer_message peers`, not hidden context;
- `peers` returns current self ID, session ID, and display name;
- queued messages reserve allowance and sends fail when capacity is reserved/exhausted;
- one unresolved outbound per sender;
- eight queued messages per recipient;
- all currently admitted recipient messages arrive in one combined idle-boundary turn;
- each member spends one credit;
- batch uncertainty consumes attempts without replay/refund;
- human recovery remains per message.

Remove descriptions of transient onboarding or compact identity context.

- [ ] **Step 2: Mark older identity/delivery clauses as superseded**

Add a short note and link from each older spec to `2026-09-11-pi-messaging-cache-and-batching-design.md`. Do not rewrite historical decisions silently. State that API-only identity supersedes transient context and that atomic batch delivery supersedes one-message-per-turn delivery.

- [ ] **Step 3: Search for stale claims**

```bash
rg -n "transient identity|identity context|first two eligible|one body|one queued message|reserve\(\).*null" \
  pi-messaging docs/superpowers/specs docs/superpowers/plans
```

Classify historical implementation plans as historical; fix current README/spec contradictions. Ensure no current documentation says sends can queue without allowance.

- [ ] **Step 4: Run docs-adjacent checks and commit**

```bash
npm run check
git diff --check
git add pi-messaging/README.md docs/superpowers/specs/2026-09-08-pi-messaging-design.md \
  docs/superpowers/specs/2026-09-09-pi-messaging-quiet-design.md \
  docs/superpowers/specs/2026-09-09-pi-messaging-role-names-design.md \
  docs/superpowers/specs/2026-09-11-pi-messaging-cache-and-batching-design.md
git commit -S -m "docs: document bounded batched peer messaging"
```

Expected: repository checks pass.

---

### Task 8: Full verification and independent review

**Files:**
- Create: `docs/superpowers/reviews/2026-09-11-pi-messaging-cache-and-batching.md`
- Modify implementation/tests only for concrete review findings, each with a failing regression test first.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: reproducible verification evidence and signed final branch history.

- [ ] **Step 1: Provision the exact isolated test broker if `$NATS_SERVER` is unset**

```bash
mkdir -p /tmp/pi-messaging-nats-2.14.6
curl -fsSL https://github.com/nats-io/nats-server/releases/download/v2.14.6/nats-server-v2.14.6-linux-amd64.tar.gz \
  -o /tmp/pi-messaging-nats-2.14.6/nats.tar.gz
echo "61c3d55f69f61ec616b75782250936445f2819e9e5f2ae6159b10a31abd2200c  /tmp/pi-messaging-nats-2.14.6/nats.tar.gz" | sha256sum --check
tar -xzf /tmp/pi-messaging-nats-2.14.6/nats.tar.gz -C /tmp/pi-messaging-nats-2.14.6
export NATS_SERVER=/tmp/pi-messaging-nats-2.14.6/nats-server-v2.14.6-linux-amd64/nats-server
```

This installs only a disposable test binary and does not start or modify the live broker.

- [ ] **Step 2: Run the complete mandatory verification matrix**

```bash
PI_MESSAGING_REQUIRE_BROKER=1 NATS_SERVER="$NATS_SERVER" npm test
npm run typecheck
npm run lint:shell
npm run check
git diff --check
```

Expected: zero failures and zero messaging broker skips.

- [ ] **Step 3: Verify supported Pi and Node variants**

```bash
PI_MESSAGING_REQUIRE_BROKER=1 NATS_SERVER="$NATS_SERVER" \
  PI_MESSAGING_PI_SDK=/home/linuxbrew/.linuxbrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js \
  node --test pi-messaging/tests/quiet.test.mjs pi-messaging/tests/cache-stability.test.mjs
npx -y node@22.19.0 --test pi-messaging/tests/*.test.mjs
npx -y node@24.20.0 --test pi-messaging/tests/*.test.mjs
```

Pass `NATS_SERVER` and `PI_MESSAGING_REQUIRE_BROKER=1` to the two `npx` commands as well when shell environment propagation is not automatic. Expected: zero failures and no broker skips.

- [ ] **Step 4: Request an independent code review**

Invoke `superpowers:requesting-code-review` against the merge base `614546d8fcd0259d830c3e340c6d5a91814a25cc`. Ask the reviewer specifically to inspect:

- CAS allowance invariants under concurrent send/admit/arm/pause;
- sender and recipient gate bypasses through retries;
- batch ordering and NATS ack/nak behavior;
- partial uncertainty and crash boundaries;
- forged or partial receipt rejection;
- private lease/token leakage;
- exact request-prefix stability; and
- compatibility with the unmerged lifecycle branch.

- [ ] **Step 5: Address only verified findings with RED/GREEN tests**

For every accepted finding:

1. add a focused failing test;
2. run it and record the expected failure;
3. make the smallest production correction;
4. rerun focused and aggregate verification; and
5. create a signed commit naming the corrected invariant.

Do not bundle unrelated refactors or weaken conservative no-replay behavior.

- [ ] **Step 6: Write review evidence and verify signed history**

Record exact test counts, runtime versions, review findings, accepted fixes, and residual external cache limitations in `docs/superpowers/reviews/2026-09-11-pi-messaging-cache-and-batching.md`.

```bash
git add docs/superpowers/reviews/2026-09-11-pi-messaging-cache-and-batching.md
git commit -S -m "docs: record batched messaging verification"
git log --show-signature --format='%h %G? %s' 614546d..HEAD
git status --short --branch
```

Expected: every new commit reports a good signature, the worktree is clean, and the branch remains unmerged and unpushed unless separately authorized.
