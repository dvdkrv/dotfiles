# Pi messaging

Locally owned messaging between independent Pi sessions. One human command, one agent tool, and one private NATS broker. No agent spawning, transcript sharing, project manager, or third-party agent framework.

## Quick start

Requirements: Node **22.19+**, Pi (tested with **0.82.0 and 0.84.1**), and `nats-server` (tested/pinned in CI: **2.14.6**). Homebrew/Chezmoi provisions the NATS binary on managed machines; the extension neither downloads nor installs packages. No OS-login service is added.

The first Pi session that loads the extension performs authenticated, loopback-only **infrastructure startup**: it starts NATS detached, initializes the private broker, and then disconnects. Concurrent sessions coordinate startup, and an already healthy broker—including one running in the foreground—is reused. This startup does **not** join a group, arm an allowance, admit or deliver messages, or otherwise enable participation. A startup error is reported as a messaging configuration error while Pi itself remains usable.

Open two normal saved Pi sessions, loading the extension explicitly until you apply the repository's settings template:

```sh
pi -e ./pi-messaging/extensions/messaging.ts
```

In each session:

1. `/messages join example` — create/select the group and confirm participation.
2. No naming dialog: each participant starts with its **Pi session ID**. During normal work, the agent uses `peer_message peers` to obtain its own routing ID, session ID, and display name alongside the other active peers, and may choose a concise name describing its assigned role.
3. In either session, `/messages arm 12` — confirm one shared automatic-work allowance.
4. Ask an agent to contact the other participant; it can discover the recipient itself. Alternatively, use `/messages send`.

**Quiet by default:** peers can wake idle sessions, but incoming messages wait for busy work to finish. Joining or resuming does not arm a group. New groups are paused. After reload, shutdown, session replacement, or tree navigation, run `/messages join <group>` again: the human dialog resumes an eligible saved identity rather than silently participating.

Sending enqueues a message and returns without waiting for the recipient to process it. Each queued message reserves one current-round allowance slot without spending it; a never-armed group, exhausted/reserved capacity, a sender's existing unresolved outbound, or eight already queued messages for the recipient causes the send to fail. Canceling queued work releases its reserved slot. Agents are guided to continue their own assignment, not poll for replies or start periodic check-ins. Substantive blockers, contract changes, and required completion reports are still appropriate; avoiding unnecessary chatter is model guidance, not a restriction on all possible tool calls.

A busy session normally leaves messages queued in the broker without spending allowance. At an idle boundary, all currently eligible messages for that recipient—up to eight—are atomically admitted and delivered as one combined Pi turn; each member spends one credit. If work begins while a batch reservation is already in flight, the admitted batch goes into Pi's **follow-up** queue and waits until that work finishes; it never steers between tool steps. Those credits are already spent and cannot be refunded. If an agent needs a reply to proceed, it should report the blocker and finish the current run rather than keep polling/sleeping. A separate continuous-loop extension can delay an idle boundary; messaging does not stop or govern that loop.

## Human controls

| Command | Purpose |
|---|---|
| `/messages` or `status` | Group mode, allowance, pending count, and peer presence |
| `join [group]` | Explicitly join or resume an eligible identity after human confirmation |
| `leave` | Final leave: stop participation and make this identity non-resumable |
| `arm [N]` | Confirm a **new** shared round, default 12, range 1–100 |
| `pause` | Persistently stop new group admissions |
| `send` | Compose an addressed message through the same queue/budget |
| `inbox` | Inspect bodies without giving them to the model; cancel queued messages, dismiss uncertain attempts, or explicitly compose a new message |
| `revoke` | Disable an old participation; does not kill its process |
| `prune` | Preview/remove eligible terminal history and unused inactive peers/groups |

Type `/messages ` and press **Tab** to see subcommands with descriptions and argument hints. `/messages jo` completes to `join`; `/messages arm ` offers common allowances (1, 2, and default 12), while any integer 1–100 can still be typed. `join` completes group names learned from normal `/messages` command reads, including newly created groups. That cache is cleared on reload/backend replacement; an empty cache does not prevent entering a group name or pressing Enter to open the picker. Completion itself never connects to the broker or changes state.

All controls require TUI mode. The agent tool has **peers**, **status**, **send**, and **rename** (self only); it cannot join, arm, grant credits, or inspect pending bodies. Status output is metadata-only and paginated at 20 records.

The shared tool schema tolerates harmless provider padding: empty/null optional reply references mean no reply, empty unused fields are omitted, and `beforeSequence` is used only for `status`. A meaningful `toPeerId` on `rename` is still rejected. Required names, recipients, and bodies are never replaced with defaults or coerced from null; malformed nonempty IDs still fail. Send bodies and valid reply references are preserved exactly.

### Session identity and role names

Peer lists show names such as `test-reviewer · session a31b7c92`. The initial display name is the full Pi session ID; compact views shorten it. Discovery returns the full `sessionId`, `displayName`, and opaque routing `id` for each active participant. Names and session IDs are **not** routing aliases: agents send using `toPeerId` from discovery or the incoming message's sender ID. Numbered human choices remain distinct even when labels or session-ID prefixes match.

Messaging injects no hidden identity, onboarding, or naming context. A joined agent explicitly calls `peer_message` with `action: "peers"` when it needs current identity or addressing information. The result includes `selfId`, `selfSessionId`, and `selfDisplayName`, plus bounded active-peer metadata. It can call `peer_message` with `action: "rename"` and a `displayName` describing its existing role. Names are self-reported metadata, not new task assignments or authority. With no known assignment, the session-ID default remains appropriate. A reply can use a known sender ID from the incoming batch without another discovery lookup.

There is no naming-only model call, automatic greeting, context hook, or sharing of other conversations. Join, leave, heartbeat, rename, reload, and resume do not rewrite model context or tool definitions. Normal discovery/rename tool calls use ordinary agent-turn tokens. Incoming peer batches remain in conversation history once at their natural append-only position so the recipient can act on them. Renaming leaves queued messages and routing IDs unchanged; session-title changes do not overwrite the role.

Automatic lifecycle departure suspends the identity: its routing ID, role, durable inbox, queued work, and already-attempted work remain intact. The next explicit `/messages join <group>` finds active stale/suspended records for the exact saved Pi session. One candidate is named in the confirmation; several require a numbered role/session/presence/age/unresolved-count picker. Any online same-session match blocks before confirmation—there is no takeover path. Repeated join for the already-local same group/session is a no-op, while another group requires final leave first. Only explicit `/messages leave` or human revoke makes an identity non-resumable; a later join then creates a fresh routing ID and session-ID default.

## Safety and recovery

- The allowance is **group-wide**, persistent, and counts individual attempts—not successful model responses or batches. Each queued message reserves one current-round slot; admission spends that slot. Replies, time, restarts, and new threads never refill it. Rearming below the existing queued count is rejected.
- Each sender may have only one unresolved `queued` or `attempted` outbound. Each recipient may have at most eight queued messages and one unresolved admitted batch. If Pi never confirms the complete batch receipt, inspect `/messages inbox` and explicitly dismiss individual attempts to unblock the recipient and senders.
- **No automatic replay or refund of an uncertain attempt or batch.** Missing, duplicated, reordered, partial, or forged batch receipts observe nothing. Broker acknowledgments and redeliveries are not permission for another model turn. A receipt means Pi observed the custom message, not that the agent completed the task.
- **Pause/suspend/leave cannot recall messages already admitted to Pi.** Some can still appear afterward.
- Reload, shutdown, session replacement, and tree navigation suspend locally and require explicit `/messages join` to resume. They never auto-resume or invoke a model. If suspension cannot be confirmed, local state closes and the stored active peer naturally becomes stale; it is not converted into final leave.
- Active stale and suspended peers remain routable and consume an active-peer slot. Resume preserves queued batches. Existing attempted messages remain blocking and are never replayed or refunded; only explicit dismissal unblocks them. Revoke abandoned peers to reclaim slots, then prune eligible history.
- A send can reserve metadata and fail before its body is published. The inbox shows a missing body; cancel that queued reservation. If publication is uncertain, inspect before composing another message—resending may duplicate work.
- Disconnects and uncertain storage operations stop automatic admission. Inspect/reconnect through the human command and explicitly rejoin; the group allowance is retained. Missing or mismatched initialized state is an error, never a fresh replacement ledger.
- Peer text is a request/report, **not human authorization**. This is protection against accidental messaging loops, **not a sandbox against programs running as your OS user**, filesystem rollback, or lost/corrupt storage. It does not limit work within one agent run or another extension's loop.

## State, bounds, and dependencies

`<agent-dir>/messaging/`, with `agent-dir` from `PI_CODING_AGENT_DIR` or `~/.pi/agent`:

- `config.json`: private random token, loopback endpoint, authority UUID, initialization marker.
- `server.json`: native NATS configuration; private token and `sync_interval: always`.
- `data/`: JetStream storage. Never commit/export it automatically.
- `broker.log`, `broker-process.json`, and the transient `startup.lock`: detached-startup diagnostics and coordination.

All detached broker state stays in this existing private messaging directory. Directories are owner-only (`0700`), config files `0600`; unsafe permissions and symlinks are rejected. V1 only accepts a `127.0.0.1` broker. No remote listener or secret logging is added by the extension.

Limits: 8 KiB message bodies; eight queued messages/recipient; one unresolved outbound/sender; 64-code-point names; 16 active peers/group; 32 retained groups; 64 queued/uncertain messages/group; 2,000 retained message records and 512 peer records. Full stores reject new work rather than evict pending content. Send-time maintenance, throttled to once/minute per connection, removes eligible terminal history older than seven days; explicit prune can remove it earlier. Live-sender deduplication records are retained. Pruning also cleans consumers belonging to inactive/deleted identities, never merely stale active peers.

Three pinned official runtime dependencies: `@nats-io/transport-node`, `@nats-io/jetstream`, `@nats-io/kv` **3.4.0**. Their queue/client dependencies add seven npm packages in the root lockfile. Pi packages remain host-provided peers; repository-wide Pi pins were not upgraded.

For manual diagnosis, `NATS_SERVER=/path/to/nats-server npm run broker --workspace pi-messaging` remains a foreground launcher. If `nats-server` is on `PATH`, omit `NATS_SERVER`. Port 4223 is the default; choose another only on first setup with `-- --port 4423`. Ctrl+C stops only that launcher's child and preserves broker data. A healthy foreground launch is reused by Pi startup.

## Architecture in brief

JetStream stores bodies and routes them through one durable filtered pull consumer per participation. A bounded KV entry stores **metadata and the admission ledger**, not duplicate bodies. Ledger v2 keeps a private per-participant lease used by every participant-authorized compare-and-set mutation; leases never appear in public peer/tool/UI DTOs. A validated v1 ledger is migrated losslessly with one expected-revision CAS before backend exposure. A concurrent winner is accepted only after strict v2 validation, and uncertain migration fails closed. Envelope and broker-config versions remain v1.

One compare-and-set update atomically revalidates and admits an ordered batch of up to eight messages, records a distinct attempt for each member, and consumes one allowance credit per member. Resume rotates the lease and rebinds the same exactly validated durable consumer, fencing old processes and held pulls without ACK, replay, or refund. The runtime calls Pi once per confirmed batch after a fresh generation check. A lost admission acknowledgment never leads to a guessed/retried handoff.

Enqueue reserves metadata and current-round capacity before publication. Expected-last-subject-sequence prevents duplicate publication while the subject is retained. Batch delivery follows broker publication order, which can differ from metadata reservation order during concurrent sends. Messages published after a reservation boundary wait for the next idle batch. Change notifications wake the runtime; a five-second heartbeat reconciles missed notifications. No model call is used to poll.

An asynchronous `MessagingBackend` separates Pi from NATS. `pi-messaging/public` exports a read-only `MessagingReader` interface and `connectReader(config)` for a separate configured connection; it exposes no join/arm/body API and never initializes storage. Future remote support must preserve one authoritative budget and add its own authentication/authorization/partition-recovery design. It is not enabled merely by changing a hostname.

## Human-controlled lifecycle rollout

Do not migrate an active installation by merely reloading one process. After the signed change is merged and packages are ready, the human performs rollout at a safe idle boundary:

1. Pause new admissions and let current Pi work settle.
2. Close every v1 messaging-enabled Pi process so none can race migration.
3. Ensure the managed NATS binary is installed, then apply the upgraded package.
4. Open the first upgraded Pi session and explicitly run `/messages join <group>`; that authenticated command connection may perform the one-time ledger migration before showing resume choices.
5. Reopen other saved sessions and explicitly run the same command, selecting each intended identity.
6. Inspect and explicitly revoke unwanted historical peers.
7. Separately approve stopping any manually managed broker and validate first-Pi autostart against retained data.

If a v1 process was left open, the migrated leases fence it; close/reload it before continuing. Rollback after migration requires v2-aware code. The extension never installs NATS, reloads Pi, stops a live broker, joins, resumes, arms, or revokes on the human's behalf.

## Tests

```sh
npm test --workspace pi-messaging
NATS_SERVER=/path/to/nats-server npm run test:broker --workspace pi-messaging
npm run typecheck
```

Normal tests clearly skip broker cases if the binary is unavailable. The broker gate **fails** instead of skipping. Tests launch private temporary brokers, not the user's service. The broker lifecycle implementation and tests do not install packages or connect to, stop, start, or modify the live broker. Scripted-provider tests use real Pi sessions and deferred work tools to verify busy queuing, idle wakeups, combined mixed-sender delivery, the admission race, and exact append-only request-prefix shape without paid inference. CI runs broker tests under Node 24 and the minimum Node 22.19.0.

Opt-in live smoke (requires existing credentials; never rewrites them):

```sh
PI_MESSAGING_LIVE=1 \
PI_MESSAGING_TEST_MODEL=anthropic/claude-haiku-4-5 \
NATS_SERVER=/path/to/nats-server \
npm run test:live --workspace pi-messaging
```

This creates two real SDK sessions with scripted human dialogs, only `peer_message` enabled, allowance 2, at most 16 inference requests, 512 output tokens/request, a context-size cap, 90-second timeout, and a $0.50 **estimated** upper bound using known model rates. It checks session-ID defaults without name input or inference at join, API-based recipient discovery without a human-provided address, self-selected initiator/responder role names, PING/PONG delivery, and rejection of a third send when the round has no unreserved capacity. It is not a real-terminal UI automation test. Cheap Anthropic/Google models with known pricing are accepted; unpriced gateway Gemini 3 Flash uses Google's published standard text rates, explicitly labeled as an estimate rather than verified gateway billing. Set `PI_MESSAGING_PI_SDK` to an installed SDK entry path to test another Pi version.
