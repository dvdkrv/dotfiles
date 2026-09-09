# Pi messaging

Locally owned messaging between independent Pi sessions. One human command, one agent tool, and one explicitly started NATS broker. No agent spawning, transcript sharing, project manager, or third-party agent framework.

## Quick start

Requirements: Node **22.19+**, Pi (tested with **0.82.0 and 0.84.1**), and `nats-server` (tested/pinned in CI: **2.14.6**). Obtain the server from [official releases](https://github.com/nats-io/nats-server/releases/tag/v2.14.6), or your package manager. The extension does not download or start it.

From the repository root:

```sh
npm ci --ignore-scripts
# Keep this foreground process running in a separate terminal:
NATS_SERVER=/path/to/nats-server npm run broker --workspace pi-messaging
```

If `nats-server` is on PATH, omit `NATS_SERVER`. Port 4223 is the default; choose another on first setup with `-- --port 4423` and use that same port on subsequent starts. Ctrl+C stops only this launcher's child and preserves broker data. Use your normal service manager if you later want persistence across logins; no service is installed automatically.

Open two normal saved Pi sessions, loading the extension explicitly until you apply the repository's settings template:

```sh
pi -e ./pi-messaging/extensions/messaging.ts
```

In each session:

1. `/messages join example` — create/select the group and confirm participation.
2. Choose different display names. A blank name follows the Pi session name.
3. In either session, `/messages arm 12` — confirm one shared automatic-work allowance.
4. Ask an agent to use `peer_message` to list peers and send to the other session, or use `/messages send` yourself.

Peers can wake idle sessions and steer busy sessions. Joining does not arm a group. New groups are paused.

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

All controls require TUI mode. The agent tool has only **peers**, **status**, and **send**; it cannot join, arm, grant credits, or inspect pending bodies. Status output is metadata-only and paginated at 20 records.

## Safety and recovery

- The allowance is **group-wide**, persistent, and counts attempts—not successful model responses. Busy-session injections count too. Replies, time, restarts, and new threads never refill it.
- At most one unresolved handoff is admitted per recipient. If Pi never confirms receipt, inspect `/messages inbox` and explicitly dismiss it to unblock that recipient.
- **No automatic replay or refund of an uncertain attempt.** Broker acknowledgments and redeliveries are not permission for another model turn. A receipt means Pi observed the custom message, not that the agent completed the task.
- **Pause/leave cannot recall messages already admitted to Pi.** Some can still appear afterward.
- Reload, restart, new/resumed/forked sessions, and tree navigation require explicit rejoining. Old inboxes are never silently redirected. Revoke stale abandoned peers to reclaim participation slots, then prune eligible history.
- A send can reserve metadata and fail before its body is published. The inbox shows a missing body; cancel that queued reservation. If publication is uncertain, inspect before composing another message—resending may duplicate work.
- Disconnects and uncertain storage operations stop automatic admission. Inspect/reconnect through the human command and explicitly rejoin; the group allowance is retained. Missing or mismatched initialized state is an error, never a fresh replacement ledger.
- Peer text is a request/report, **not human authorization**. This is protection against accidental messaging loops, **not a sandbox against programs running as your OS user**, filesystem rollback, or lost/corrupt storage. It does not limit work within one agent run or another extension's loop.

## State, bounds, and dependencies

`<agent-dir>/messaging/`, with `agent-dir` from `PI_CODING_AGENT_DIR` or `~/.pi/agent`:

- `config.json`: private random token, loopback endpoint, authority UUID, initialization marker.
- `server.json`: native NATS configuration; private token and `sync_interval: always`.
- `data/`: JetStream storage. Never commit/export it automatically.

Directories are owner-only (`0700`), config files `0600`; unsafe permissions and symlinks are rejected. V1 only accepts a `127.0.0.1` broker. No remote listener, broker auto-start, or secret logging is added by the extension.

Limits: 8 KiB message bodies; 64-code-point names; 16 active peers/group; 32 retained groups; 64 queued/uncertain messages/group; 2,000 retained message records and 512 peer records. Full stores reject new work rather than evict pending content. Send-time maintenance, throttled to once/minute per connection, removes eligible terminal history older than seven days; explicit prune can remove it earlier. Live-sender deduplication records are retained. Pruning also cleans consumers belonging to inactive/deleted identities, never merely stale active peers.

Three pinned official runtime dependencies: `@nats-io/transport-node`, `@nats-io/jetstream`, `@nats-io/kv` **3.4.0**. Their queue/client dependencies add seven npm packages in the root lockfile. Pi packages remain host-provided peers; repository-wide Pi pins were not upgraded.

## Architecture in brief

JetStream stores bodies and routes them through one durable filtered pull consumer per participation. A bounded KV entry stores **metadata and the admission ledger**, not duplicate bodies. Its compare-and-set update atomically reserves a message, checks participation, and consumes allowance. The runtime calls Pi only after confirmed admission and a fresh generation check. A lost admission acknowledgment never leads to a guessed/retried handoff.

Enqueue reserves metadata before publication. Expected-last-subject-sequence prevents duplicate publication while the subject is retained. Delivery follows broker publication order, which can differ from metadata reservation order during concurrent sends. Change notifications wake the runtime; a five-second heartbeat reconciles missed notifications. No model call is used to poll.

An asynchronous `MessagingBackend` separates Pi from NATS. `pi-messaging/public` exports a read-only `MessagingReader` interface and `connectReader(config)` for a separate configured connection; it exposes no join/arm/body API and never initializes storage. Future remote support must preserve one authoritative budget and add its own authentication/authorization/partition-recovery design. It is not enabled merely by changing a hostname.

## Tests

```sh
npm test --workspace pi-messaging
NATS_SERVER=/path/to/nats-server npm run test:broker --workspace pi-messaging
npm run typecheck
```

Normal tests clearly skip broker cases if the binary is unavailable. The broker gate **fails** instead of skipping. Tests launch private temporary brokers, not the user's service. CI runs broker tests under Node 24 and the minimum Node 22.19.0.

Opt-in live smoke (requires existing credentials; never rewrites them):

```sh
PI_MESSAGING_LIVE=1 \
PI_MESSAGING_TEST_MODEL=anthropic/claude-haiku-4-5 \
NATS_SERVER=/path/to/nats-server \
npm run test:live --workspace pi-messaging
```

This creates two real SDK sessions with scripted human dialogs, only `peer_message` enabled, allowance 2, at most 8 inference requests, 512 output tokens/request, a context-size cap, 90-second timeout, and a $0.50 **estimated** upper bound using known model rates. It checks PING/PONG delivery and a third message left queued. It is not a real-terminal UI automation test. Cheap Anthropic/Google models with known pricing are accepted; unpriced gateway Gemini 3 Flash uses Google's published standard text rates, explicitly labeled as an estimate rather than verified gateway billing. Set `PI_MESSAGING_PI_SDK` to an installed SDK entry path to test another Pi version.
