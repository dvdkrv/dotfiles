# Pi messaging cache stability and bounded batching — verification review

Date: 2026-09-11
Branch: `fix/pi-messaging-cache-batching`
Merge base: `614546d8fcd0259d830c3e340c6d5a91814a25cc`
Verified head before this evidence commit: `b91c8b8`

## Scope verified

The implementation removes messaging's dynamic `context` hook and transient identity/onboarding item, exposes current self identity through `peer_message peers`, reserves current-round capacity at enqueue time, limits each sender to one unresolved outbound and each recipient to eight queued messages, atomically admits/observes ordered batches, and delivers one combined append-only custom message at an idle boundary. Each batch member consumes an individual credit and retains individual conservative recovery state.

No live group, user message, allowance, saved Pi session, broker store, or lifecycle lease was used by the tests. Broker tests used temporary directories and a disposable NATS server. Scripted provider acceptance made no external inference requests. The opt-in paid live smoke was not run.

## Deterministic and integration evidence

The disposable broker was the official `nats-server` **2.14.6** Linux amd64 archive, verified against SHA-256 `61c3d55f69f61ec616b75782250936445f2819e9e5f2ae6159b10a31abd2200c` and extracted under `/tmp/pi-messaging-nats-2.14.6/`.

Final post-review verification:

- `PI_MESSAGING_REQUIRE_BROKER=1 NATS_SERVER=... npm test`: **185 tests passed**, zero failures and zero broker skips. This comprises 31 root tests, 19 worktree-core tests, 19 worktree-manager tests, 10 task tests, 20 loop tests, 10 Claude-bridge tests, and **76 messaging tests**.
- Repository Pi SDK **0.82.0** is exercised by the aggregate messaging suite, including real SDK/scripted-provider batching and cache-shape tests.
- Installed Pi SDK **0.84.1**: quiet delivery plus cache-stability acceptance, **4 tests passed**.
- Exact Node **22.19.0**: all **76 messaging tests passed**, including mandatory isolated broker tests.
- Exact Node **24.20.0**: all **76 messaging tests passed**, including mandatory isolated broker tests.
- `npm run typecheck`: passed.
- `npm run lint:shell`: passed.
- `npm run check`: passed.
- `git diff --check`: passed.

The scripted cache regression compares canonical OpenAI Codex Responses input items, not only Pi's generic message objects. It verifies that the prior converted request input plus the converted assistant response is an exact prefix of the continuation input, followed by the converted tool result. System prompts and canonical tool definitions remain equal, the peer entry appears once, and `pi-messaging.identity.v1` is absent.

## Independent review

A separate ephemeral, read-only Pi reviewer inspected `614546d..b3e1fce` against the approved design and plan. It did not load project extensions or skills, save a session, mutate the checkout, start a broker, inspect conversation bodies, or read broker secrets.

The initial review found no Critical issues and identified these Important items:

1. explicitly capture a JetStream publication high-water for batch membership;
2. distinguish pre-boundary stale bodies without ledger metadata from post-boundary publications;
3. prevent peer text from imitating batch delimiters and attribution;
4. assert the exact OpenAI Codex converted-input continuation condition; and
5. make the real KV concurrency test attempt fourteen sends against twelve available slots.

It also noted misleading cancellation/dismissal wording as Minor. Signed fix `b91c8b8` addressed all six items with focused tests. The broker now captures the stream sequence before its ledger snapshot, NAKs post-boundary publications, ACKs non-admissible pre-boundary residue, and bounds pulls by message count and a monotonic start deadline. Peer bodies are represented as JSON strings inside clearly labeled blocks. Operator recovery text distinguishes releasing a queued reservation from refunding a spent attempt.

A second ephemeral read-only review of the complete range through `b91c8b8` found no remaining Critical or Important issue, no new conservative-delivery/security/compatibility regression, and assessed the branch **ready to merge**. Its only residual Minor observation is that the NATS client enforces a 1000 ms minimum fetch expiry, so a pull begun immediately before the monotonic deadline can make the effective bound less than two seconds rather than exactly one second.

## Safety and compatibility conclusions

- Idempotent retries are evaluated before new capacity and unresolved-sender gates.
- Queue reservation, sender/recipient bounds, arm replacement, batch admission, and per-message spending remain ledger-CAS decisions.
- A lost admission acknowledgment, crash after admission, failed observation, or invalid receipt causes no automatic replay or refund.
- Partial, duplicated, reordered, or forged batch receipts mutate no message.
- Peer content cannot forge another batch member's framing; terminal controls remain escaped.
- Batch details contain only public correlation fields. Broker tokens and private lifecycle leases are not exposed.
- Joining, leaving, heartbeat, and rename do not mutate request-visible conversation history or tool definitions.
- `feat/pi-messaging-lifecycle` remains unmerged and inactive. Before any later rollout it must incorporate this range, retain private lease fencing, remove its context hook, and validate/recreate durable consumers with `max_ack_pending: 8`.

## Residual cache limitations

The verified contract is zero avoidable messaging-owned request-prefix mutation. It is not a guaranteed provider cache-hit percentage. Cold starts, cache expiry or eviction, compaction, provider routing and implementation behavior, model changes, session/cache-key changes, and newly generated output remain external factors. Incoming peer batches intentionally add new append-only content because recipients need that content to act.

## History and rollout state

All commits in `614546d..b91c8b8` reported good SSH signatures. The branch remained unmerged and unpushed during implementation and verification. Activation, merging, pushing, lifecycle-branch integration, and existing-session reload/rejoin remain separate human-controlled actions.
