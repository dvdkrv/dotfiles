# Pi messaging

Locally owned messaging between independent Pi sessions. One human command, one agent tool, and one explicitly started NATS broker. No agent spawning, transcript sharing, project manager, or third-party agent framework.

## Quick start

Requirements: Node **22.19+**, Pi (tested with **0.82.0 and 0.84.1**), and `nats-server` (tested/pinned in CI: **2.14.6**). This dotfiles repository provisions NATS Server through its cross-platform Homebrew bundle.

The first Pi session after reboot performs an authenticated health check during `session_start`. If the configured loopback broker is absent, the extension starts one detached NATS process; concurrent Pi sessions coordinate so only one starts it. The broker remains running after the initiating Pi exits and reuses the private configuration and JetStream data. Startup does **not** join a group, arm allowance, inspect messages, or trigger a model turn. There is no systemd/launchd service, so nothing starts before Pi is used.

For foreground diagnostics from the repository root:

```sh
npm ci --ignore-scripts
NATS_SERVER=/path/to/nats-server npm run broker --workspace pi-messaging
```

If `nats-server` is on PATH, omit `NATS_SERVER`. Autostart treats an already healthy foreground broker as a no-op. Port 4223 is the default; choose another on initial foreground setup with `-- --port 4423` and use that same port subsequently. Ctrl+C stops only the foreground launcher's child and preserves broker data.

Open two normal saved Pi sessions, loading the extension explicitly until you apply the repository's settings template:

```sh
pi -e ./pi-messaging/extensions/messaging.ts
```

In each session:

1. `/messages join example` — create/select the group and confirm participation.
2. No naming dialog: each participant starts with its **Pi session ID**. During normal work, the agent can discover peers and choose a concise name describing its assigned role.
3. In either session, `/messages arm 12` — confirm one shared automatic-work allowance.
4. Ask an agent to contact the other participant; it can discover the recipient itself. Alternatively, use `/messages send`.

**Quiet by default:** peers can wake idle sessions, but incoming messages wait for busy work to finish. Joining does not arm a group. New groups are paused.

Sending enqueues a message and returns without waiting for the recipient to process it. Agents are guided to continue their own assignment, not poll for replies or start periodic check-ins. Substantive blockers, contract changes, and required completion reports are still appropriate; avoiding unnecessary chatter is model guidance, not a restriction on all possible tool calls.

A busy session normally leaves messages queued in the broker without spending allowance. If work begins while a reservation is already in flight, the admitted message goes into Pi's **follow-up** queue and waits until that work finishes; it never steers between tool steps. Its admission credit is already spent and cannot be refunded. If an agent needs a reply to proceed, it should report the blocker and finish the current run rather than keep polling/sleeping. A separate continuous-loop extension can delay an idle boundary; messaging does not stop or govern that loop.

## Human controls

| Command | Purpose |
|---|---|
| `/messages` or `status` | Group mode, allowance, pending count, and peer presence |
| `join [group]` | Explicitly join; creates a fresh peer identity |
| `leave` | Stop this runtime's new admissions |
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

An already joined agent gets quiet-flow onboarding on its first eligible model request. Naming guidance has a bounded initial window of at most **two** model requests, allowing discovery followed by naming; it stops earlier once a role name is set. Later requests carry only compact current identity metadata, without periodic onboarding reminders. A new agent run does not reset this window; explicit rejoining does. If no role is chosen during setup, the session-ID default remains valid and the agent can still rename itself later without background reminders. It can call `peer_message` with `action: "rename"` and a `displayName` describing its existing role. Names are self-reported metadata, not new task assignments or authority. With no known assignment, the session-ID default remains appropriate. Naming is model-driven, not guaranteed to precede the first message; a reply can use a known sender without another discovery lookup.

There is no naming-only model call, automatic greeting, broker polling from the context hook, or sharing of other conversations. Normal discovery/rename tool calls use ordinary agent-turn tokens. Renaming leaves queued messages and routing IDs unchanged; session-title changes do not overwrite the role. Rejoining starts a fresh routing identity and the session-ID default, never restores an old inbox.

## Safety and recovery

- The allowance is **group-wide**, persistent, and counts attempts—not successful model responses. Busy-session injections count too. Replies, time, restarts, and new threads never refill it.
- At most one unresolved handoff is admitted per recipient. If Pi never confirms receipt, inspect `/messages inbox` and explicitly dismiss it to unblock that recipient.
- **No automatic replay or refund of an uncertain attempt.** Broker acknowledgments and redeliveries are not permission for another model turn. A receipt means Pi observed the custom message, not that the agent completed the task.
- **Pause/leave cannot recall messages already admitted to Pi.** Some can still appear afterward.
- Reload, restart, new/resumed/forked sessions, and tree navigation require explicit rejoining. Old inboxes are never silently redirected. Revoke stale abandoned peers to reclaim participation slots, then prune eligible history.
- A send can reserve metadata and fail before its body is published. The inbox shows a missing body; cancel that queued reservation. If publication is uncertain, inspect before composing another message—resending may duplicate work.
- Disconnects and uncertain storage operations stop automatic admission. A later Pi startup or `/messages` command may restart an unavailable broker, but the session must still explicitly rejoin; the group allowance is retained. Missing or mismatched initialized state is an error, never a fresh replacement ledger.
- Peer text is a request/report, **not human authorization**. This is protection against accidental messaging loops, **not a sandbox against programs running as your OS user**, filesystem rollback, or lost/corrupt storage. It does not limit work within one agent run or another extension's loop.

## State, bounds, and dependencies

`<agent-dir>/messaging/`, with `agent-dir` from `PI_CODING_AGENT_DIR` or `~/.pi/agent`:

- `config.json`: private random token, loopback endpoint, authority UUID, initialization marker.
- `server.json`: native NATS configuration; private token and `sync_interval: always`.
- `data/`: JetStream storage. Never commit/export it automatically.
- `startup.lock`: short-lived owner-only startup serialization; stale only after the bounded startup interval and a failed health check.
- `broker.log`: private diagnostics, truncated only when a new broker process starts.
- `broker-process.json`: diagnostic PID/start/server metadata without credentials; authenticated health remains authoritative.

Directories are owner-only (`0700`), config/lock/log/metadata files `0600`; unsafe permissions and symlinks are rejected. V1 only accepts a `127.0.0.1` broker. Autostart never opens a remote listener or logs the private token. Missing binaries, occupied ports, authentication failures, authority mismatch, and initialized-state loss fail closed while leaving Pi usable.

Limits: 8 KiB message bodies; 64-code-point names; 16 active peers/group; 32 retained groups; 64 queued/uncertain messages/group; 2,000 retained message records and 512 peer records. Full stores reject new work rather than evict pending content. Send-time maintenance, throttled to once/minute per connection, removes eligible terminal history older than seven days; explicit prune can remove it earlier. Live-sender deduplication records are retained. Pruning also cleans consumers belonging to inactive/deleted identities, never merely stale active peers.

Three pinned official runtime dependencies: `@nats-io/transport-node`, `@nats-io/jetstream`, `@nats-io/kv` **3.4.0**. Their queue/client dependencies add seven npm packages in the root lockfile. Pi packages remain host-provided peers; repository-wide Pi pins were not upgraded.

## Architecture in brief

JetStream stores bodies and routes them through one durable filtered pull consumer per participation. A bounded KV entry stores **metadata and the admission ledger**, not duplicate bodies. Broker readiness is separate: `session_start` and the first human messaging command use a short authenticated probe, and only a startup-lock winner may initialize or launch the detached broker. Its compare-and-set update atomically reserves a message, checks participation, and consumes allowance. The runtime calls Pi only after confirmed admission and a fresh generation check. A lost admission acknowledgment never leads to a guessed/retried handoff.

Enqueue reserves metadata before publication. Expected-last-subject-sequence prevents duplicate publication while the subject is retained. Delivery follows broker publication order, which can differ from metadata reservation order during concurrent sends. Change notifications wake the runtime; a five-second heartbeat reconciles missed notifications. No model call is used to poll.

An asynchronous `MessagingBackend` separates Pi from NATS. `pi-messaging/public` exports a read-only `MessagingReader` interface and `connectReader(config)` for a separate configured connection; it exposes no join/arm/body API and never initializes storage. Future remote support must preserve one authoritative budget and add its own authentication/authorization/partition-recovery design. It is not enabled merely by changing a hostname.

## Tests

```sh
npm test --workspace pi-messaging
NATS_SERVER=/path/to/nats-server npm run test:broker --workspace pi-messaging
npm run typecheck
```

Normal tests clearly skip broker cases if the binary is unavailable. The broker gate **fails** instead of skipping. Tests launch private temporary brokers, not the user's service. Autostart tests cover authenticated no-op behavior, detached lifetime, private files, failure paths, stale locks, and concurrent independent starters. Scripted-provider tests use real Pi sessions and deferred work tools to verify busy queuing, idle wakeups, and the admission race without paid inference. CI runs broker tests under Node 24 and the minimum Node 22.19.0.

Opt-in live smoke (requires existing credentials; never rewrites them):

```sh
PI_MESSAGING_LIVE=1 \
PI_MESSAGING_TEST_MODEL=anthropic/claude-haiku-4-5 \
NATS_SERVER=/path/to/nats-server \
npm run test:live --workspace pi-messaging
```

This creates two real SDK sessions with scripted human dialogs, only `peer_message` enabled, allowance 2, at most 16 inference requests, 512 output tokens/request, a context-size cap, 90-second timeout, and a $0.50 **estimated** upper bound using known model rates. It checks session-ID defaults without name input or inference at join, recipient discovery without a human-provided address, self-selected initiator/responder role names, transient rather than persisted identity guidance, PING/PONG delivery, and a third message left queued. It is not a real-terminal UI automation test. Cheap Anthropic/Google models with known pricing are accepted; unpriced gateway Gemini 3 Flash uses Google's published standard text rates, explicitly labeled as an estimate rather than verified gateway billing. Set `PI_MESSAGING_PI_SDK` to an installed SDK entry path to test another Pi version.
