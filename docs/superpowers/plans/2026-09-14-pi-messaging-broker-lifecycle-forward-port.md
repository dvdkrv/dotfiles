# Pi Messaging Broker Lifecycle Forward-Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision NATS Server and let Pi session startup safely ensure one authenticated, detached, loopback-only messaging broker without creating participation or model work.

**Architecture:** A focused `broker-lifecycle.ts` module performs authenticated probes and serializes detached startup with private filesystem state. The extension factory stays inert; `session_start` and a human `/messages` command call an injected readiness dependency that never joins, arms, delivers, or mutates model context.

**Tech Stack:** TypeScript; Node >=22.19; Pi SDK 0.82.0/installed SDK; NATS Server 2.14.6; NATS TypeScript clients 3.4.0; Homebrew/Chezmoi; Node test runner and jiti 2.7.0.

## Global Constraints

- Broker startup is infrastructure only: never join, resume, arm, send, read a body, admit work, or trigger a model turn.
- The extension factory remains free of process, socket, timer, filesystem, and network work.
- Start only a token-authenticated `127.0.0.1` endpoint from the existing authority/configuration; never choose a replacement authority or port after failure.
- Existing initialized state loss, authentication failure, authority mismatch, unsafe paths, and incompatible streams fail closed.
- Startup locks, server configuration, log, and process metadata are owner-only non-symlink paths and never expose the token.
- A detached broker outlives its initiating Pi process and is not stopped by session shutdown.
- Tests use isolated directories, ports, brokers, and PIDs; never read or alter live messaging configuration/state.
- All commits are SSH-signed.

---

## File structure

- `dot_Brewfile` — declares `nats-server` once for macOS/Linux provisioning.
- `tests/provisioning.test.mjs` — protects the package declaration.
- `pi-messaging/src/broker-lifecycle.ts` — probe, private startup lock/files, detached spawn, bounded readiness, and safe child cleanup.
- `pi-messaging/src/broker.ts` — retains the foreground diagnostic launcher and shares server-configuration writing.
- `pi-messaging/src/nats-backend.ts` — accepts a bounded connection timeout for probes.
- `pi-messaging/extensions/messaging.ts` — invokes injected readiness on session start and before human connection.
- `pi-messaging/tests/autostart.test.mjs` — isolated real-process lifecycle tests.
- `pi-messaging/tests/helpers/autostart-contender.mjs` — one independent startup contender.
- `pi-messaging/tests/extension.test.mjs` — proves factory inertness and infrastructure-only session startup.
- `pi-messaging/README.md` — documents startup/recovery without changing participation semantics.

### Task 1: Provision the broker declaratively

**Files:**
- Modify: `tests/provisioning.test.mjs`
- Modify: `dot_Brewfile`

**Interfaces:**
- Consumes: existing `brew bundle --file="$CHEZMOI_SOURCE_DIR/dot_Brewfile"` hook.
- Produces: one `nats-server` executable discoverable through the normal Homebrew path.

- [ ] **Step 1: Write the failing provisioning assertion**

Add beside the existing Mosh formula test:

```js
test('cross-platform package bundle provisions the Pi messaging broker', () => {
  const packages = repositoryFile('dot_Brewfile');
  assert.equal(
    packages.split(/\r?\n/).filter(line => line === 'brew "nats-server"').length,
    1,
    'nats-server should be installed exactly once through Homebrew',
  );
});
```

- [ ] **Step 2: Run RED**

```bash
node --test --test-name-pattern='package bundle provisions.*messaging broker' tests/provisioning.test.mjs
```

Expected: FAIL because the exact formula is absent.

- [ ] **Step 3: Add the formula once**

Add to `dot_Brewfile` beside Mosh and other runtime tools:

```ruby
brew "nats-server"
```

Do not run Homebrew or apply chezmoi during implementation.

- [ ] **Step 4: Run GREEN and repository rendering**

```bash
node --test --test-name-pattern='package bundle provisions.*messaging broker' tests/provisioning.test.mjs
npm run check
git diff --check
```

Expected: focused test and repository check PASS.

- [ ] **Step 5: Commit the isolated unit**

```bash
git add dot_Brewfile tests/provisioning.test.mjs
git commit -S -m "chore: provision NATS messaging broker"
```

### Task 2: Implement authenticated probe and detached startup

**Files:**
- Create: `pi-messaging/src/broker-lifecycle.ts`
- Modify: `pi-messaging/src/broker.ts`
- Modify: `pi-messaging/src/nats-backend.ts`
- Create: `pi-messaging/tests/autostart.test.mjs`

**Interfaces:**
- Consumes: `defaultAgentDir`, `messagingDir`, `prepareConfig`, `readConfig`, `markInitialized`, `privatePath`, `validateConfig`, and `connectBackend`.
- Produces:

```ts
export interface EnsureBrokerOptions {
  agentDir?: string;
  binary?: string;
  port?: number;
  probeTimeoutMs?: number;
  startupTimeoutMs?: number;
}
export type BrokerReadiness = 'ready' | 'unavailable';
export function writeServerConfig(agentDir: string, config: BrokerConfig): string;
export function probeBroker(config: BrokerConfig, timeoutMs?: number): Promise<BrokerReadiness>;
export function ensureBroker(options?: EnsureBrokerOptions): Promise<{
  state: 'running' | 'started';
  config: BrokerConfig;
}>;
```

Extend backend connection options without changing defaults:

```ts
export async function connectBackend(
  config: BrokerConfig,
  options: { initialize?: boolean; timeoutMs?: number } = {},
): Promise<MessagingBackend>;
```

- [ ] **Step 1: Create failing real-process tests**

In `autostart.test.mjs`, use `freePort()` and a new temporary agent directory per test. Resolve the test broker as `process.env.NATS_SERVER || 'nats-server'`; skip only when the broker is absent and `PI_MESSAGING_REQUIRE_BROKER` is unset.

Add these assertions:

```js
test('healthy authenticated broker is an autostart no-op', { timeout: 15_000 }, async t => {
  const f = await isolatedRoot(t);
  const foreground = await runBroker(f.root, binary, f.port);
  t.after(() => foreground.stop());
  const before = await stat(join(f.root, 'messaging', 'server.json'));
  const result = await ensureBroker({ agentDir: f.root, binary, port: f.port });
  assert.equal(result.state, 'running');
  assert.equal((await stat(join(f.root, 'messaging', 'server.json'))).mtimeMs, before.mtimeMs);
  assert.equal(await probeBroker(result.config), 'ready');
});

test('ensureBroker starts a detached private broker', { timeout: 15_000 }, async t => {
  const f = await isolatedRoot(t);
  const result = await ensureBroker({ agentDir: f.root, binary, port: f.port });
  assert.equal(result.state, 'started');
  assert.equal(readConfig(f.root).initialized, true);
  for (const name of ['config.json', 'server.json', 'broker.log', 'broker-process.json']) {
    assert.equal((await stat(join(f.root, 'messaging', name))).mode & 0o777, 0o600);
  }
  const processInfo = JSON.parse(await readFile(join(f.root, 'messaging', 'broker-process.json'), 'utf8'));
  assert.deepEqual(Object.keys(processInfo).sort(), ['pid', 'server', 'startedAt']);
  assert.equal((await readFile(join(f.root, 'messaging', 'broker.log'), 'utf8')).includes(result.config.token), false);
  assert.equal(alive(processInfo.pid), true);
});
```

Every fixture registers cleanup for only the PID stored beneath its own temporary root. Add tests for a missing binary, a different-token NATS process occupying the selected port, initialized configuration with missing streams, a symlink lock/log/server file, and group-readable modes. Assert authority/config bytes are not replaced on every failure.

- [ ] **Step 2: Run RED**

```bash
PI_MESSAGING_REQUIRE_BROKER=1 \
NATS_SERVER=/tmp/pi-messaging-nats-2.14.6/nats-server-v2.14.6-linux-amd64/nats-server \
node --test pi-messaging/tests/autostart.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `broker-lifecycle.ts`.

- [ ] **Step 3: Add timeout plumbing and shared server configuration**

Use `const timeoutMs = options.timeoutMs ?? 1500` for NATS connection, JetStream, and manager timeouts in `connectBackend`.

Move server JSON creation from `runBroker()` into `writeServerConfig()`. It must validate the configuration, create/validate `messaging/data` as `0700`, and write with `O_NOFOLLOW` and `0600`:

```ts
{
  host: '127.0.0.1',
  port: Number(new URL(config.server).port),
  authorization: { token: config.token },
  max_payload: 4 * 1024 * 1024,
  jetstream: {
    store_dir: data,
    max_file_store: 128 * 1024 * 1024,
    sync_interval: 'always',
  },
}
```

The foreground launcher still owns/stops its child and still initializes through `connectBackend`; only configuration writing is shared.

- [ ] **Step 4: Implement strict probing**

`probeBroker` validates the configuration, connects with the supplied timeout, closes the backend, and returns `ready`. Return `unavailable` only when the error text matches:

```ts
/ECONNREFUSED|connection refused|TIMEOUT|timed out|no servers available/i
```

Rethrow authentication, permission, authority, missing-state, and incompatible-stream errors. For `initialized: false`, initialization is allowed only while holding the startup lock; mark the config initialized only after backend initialization succeeds.

- [ ] **Step 5: Implement private serialized startup**

`ensureBroker` must:

1. load an existing safe config or call `prepareConfig(agentDir, port ?? 4223)` only when neither config nor broker state exists;
2. return `running` after a successful authenticated probe;
3. acquire `startup.lock` using `O_CREAT | O_EXCL | O_NOFOLLOW`, mode `0600`, recording only `{ pid, createdAt }`;
4. have waiters repeatedly probe, and reclaim a lock only after its filesystem age exceeds `startupTimeoutMs` and a final probe is unavailable;
5. re-probe after lock acquisition;
6. truncate/open `broker.log` with `O_NOFOLLOW`, mode `0600`;
7. spawn `binary -c server.json` with `{ detached: true, stdio: ['ignore', logFd, logFd] }`;
8. atomically write `broker-process.json` containing only `{ pid, startedAt, server }`;
9. wait until authenticated initialization/validation succeeds, then `unref()` the child;
10. terminate only its newly spawned child on readiness failure and always release its owned lock.

Bound probe timeout to at least 50 ms and startup timeout to at least 250 ms. Use a three-second TERM-to-KILL bound for a child that failed before readiness.

- [ ] **Step 6: Run GREEN and repeat failure cases**

```bash
for i in 1 2 3; do
  PI_MESSAGING_REQUIRE_BROKER=1 \
  NATS_SERVER=/tmp/pi-messaging-nats-2.14.6/nats-server-v2.14.6-linux-amd64/nats-server \
  node --test pi-messaging/tests/autostart.test.mjs || exit
done
npm run typecheck
git diff --check
```

Expected: all three runs PASS; no child or temporary root remains.

- [ ] **Step 7: Commit the lifecycle module**

```bash
git add pi-messaging/src/broker-lifecycle.ts pi-messaging/src/broker.ts \
  pi-messaging/src/nats-backend.ts pi-messaging/tests/autostart.test.mjs
git commit -S -m "feat: start private messaging broker on demand"
```

### Task 3: Prove process contention and integrate Pi startup

**Files:**
- Create: `pi-messaging/tests/helpers/autostart-contender.mjs`
- Modify: `pi-messaging/tests/autostart.test.mjs`
- Modify: `pi-messaging/extensions/messaging.ts`
- Modify: `pi-messaging/tests/extension.test.mjs`

**Interfaces:**
- Consumes: `ensureBroker()` from Task 2.
- Produces: `registerMessaging(pi, factory?, ensure?)`, where `ensure` defaults to `() => ensureBroker()` and is injectable only for deterministic tests.

- [ ] **Step 1: Write the contender and failing contention test**

The child accepts `{ agentDir, binary, port }`, invokes `ensureBroker` once, returns only `{ state, authorityId }` over IPC, and exits. It must never return a token or file content.

Fork eight children simultaneously and assert:

```js
assert.equal(results.filter(result => result.state === 'started').length, 1);
assert.equal(new Set(results.map(result => result.authorityId)).size, 1);
assert.equal((await contend()).state, 'running');
assert.equal(await probeBroker(readConfig(root)), 'ready');
assert.equal(alive(JSON.parse(await readFile(processFile, 'utf8')).pid), true);
```

Wait for every contender to exit. Cleanup only the isolated broker PID.

- [ ] **Step 2: Run the contention test RED or against the unproven implementation**

```bash
PI_MESSAGING_REQUIRE_BROKER=1 \
NATS_SERVER=/tmp/pi-messaging-nats-2.14.6/nats-server-v2.14.6-linux-amd64/nats-server \
node --test --test-name-pattern='concurrent starter' pi-messaging/tests/autostart.test.mjs
```

Expected before the fixture/coordination is complete: FAIL. Do not weaken the exact-one-starter assertion.

- [ ] **Step 3: Fix only demonstrated lock/process defects and repeat**

```bash
for i in 1 2 3; do
  PI_MESSAGING_REQUIRE_BROKER=1 \
  NATS_SERVER=/tmp/pi-messaging-nats-2.14.6/nats-server-v2.14.6-linux-amd64/nats-server \
  node --test --test-name-pattern='concurrent starter|outlives' pi-messaging/tests/autostart.test.mjs || exit
done
```

Expected: one starter, one authority, all callers exit, broker remains reachable, cleanup succeeds.

- [ ] **Step 4: Replace the inert-session assertion with failing extension tests**

Extend the extension fixture with separate `ensureCalls` and `connectCalls`. Assert factory registration invokes neither. Then:

```js
await events.get('session_start')({ reason: 'startup' }, ctx);
assert.equal(ensureCalls.length, 1);
assert.equal(connectCalls.length, 0);
assert.equal(backend.peer, undefined);
assert.equal(delivered.length, 0);
```

Make injected readiness reject and assert one TUI warning, no thrown model error, no connection, no group/allowance mutation, and no custom message. Change the injected dependency to succeed, run a human `/messages status`, and assert exactly one retry occurs before backend connection.

- [ ] **Step 5: Run extension tests RED**

```bash
node --test --test-name-pattern='session start ensures|startup failure warns|command retries readiness' \
  pi-messaging/tests/extension.test.mjs
```

Expected: FAIL because current `session_start` only resets local state.

- [ ] **Step 6: Wire readiness without participation**

Change registration to:

```ts
export function registerMessaging(
  pi: ExtensionAPI,
  factory: () => Promise<MessagingBackend> = configuredBackend,
  ensure: () => Promise<unknown> = () => ensureBroker(),
): void
```

On `session_start`, finish generation detach/reset first, then call `ensure()` in a separate guarded block. If it fails and `ctx.hasUI`, call `ctx.ui.notify` once with a safe concise warning. Never call `pi.sendMessage` and never throw the startup error into a model turn.

Immediately before a human command creates a backend, call `ensure()` and then `factory()`. Non-TUI participation controls still fail before connection. Do not stop the detached broker during shutdown.

- [ ] **Step 7: Run extension/coexistence/cache tests GREEN**

```bash
node --test pi-messaging/tests/extension.test.mjs \
  pi-messaging/tests/coexistence.test.mjs pi-messaging/tests/cache-stability.test.mjs
npm run typecheck
git diff --check
```

Expected: factory inertness, API-only identity, no context hook, loop coexistence, and startup tests PASS.

- [ ] **Step 8: Commit process and extension integration**

```bash
git add pi-messaging/tests/helpers/autostart-contender.mjs \
  pi-messaging/tests/autostart.test.mjs pi-messaging/extensions/messaging.ts \
  pi-messaging/tests/extension.test.mjs
git commit -S -m "feat: ensure messaging broker on Pi startup"
```

### Task 4: Document and verify broker lifecycle

**Files:**
- Modify: `pi-messaging/README.md`

**Interfaces:**
- Consumes: final broker lifecycle behavior.
- Produces: operator guidance; no new runtime API.

- [ ] **Step 1: Update README behavior and recovery**

Document that Homebrew/Chezmoi provisions NATS; the first Pi session performs infrastructure-only authenticated startup; a healthy foreground broker is reused; detached state lives under the existing private messaging directory; startup does not join/arm/deliver; errors leave Pi usable; and `npm run broker --workspace pi-messaging` remains a foreground diagnostic.

State explicitly that implementation/tests do not install packages or touch the live broker and that OS-login services are not added.

- [ ] **Step 2: Run the complete broker-gated repository suite**

```bash
PI_MESSAGING_REQUIRE_BROKER=1 \
NATS_SERVER=/tmp/pi-messaging-nats-2.14.6/nats-server-v2.14.6-linux-amd64/nats-server \
npm test
npm run typecheck
npm run lint:shell
npm run check
git diff --check
```

Expected: no failures and no broker-required skips.

- [ ] **Step 3: Verify minimum runtime and production-only installation**

```bash
PI_MESSAGING_REQUIRE_BROKER=1 \
NATS_SERVER=/tmp/pi-messaging-nats-2.14.6/nats-server-v2.14.6-linux-amd64/nats-server \
/home/bits/.npm/_npx/992a19d7d9bf36d4/node_modules/node/bin/node \
  --test pi-messaging/tests/*.test.mjs

tmp="$(mktemp -d /tmp/pi-messaging-production.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
cp -R pi-messaging "$tmp/package"
npm install --omit=dev --ignore-scripts --package-lock=false --legacy-peer-deps --prefix "$tmp/package"
node --experimental-strip-types -e \
  "import('$tmp/package/src/broker-lifecycle.ts').then(m => { if (typeof m.ensureBroker !== 'function') process.exit(1) })"
rm -rf "$tmp"
trap - EXIT
```

Expected: all messaging tests PASS and `ensureBroker` imports without development dependencies.

- [ ] **Step 4: Commit documentation**

```bash
git add pi-messaging/README.md
git commit -S -m "docs: document messaging broker lifecycle"
```

- [ ] **Step 5: Stop before live activation**

Do not run Homebrew, chezmoi apply, stop/start the live broker, reload Pi, or connect the upgraded backend to live state. Record verification evidence for the combined lifecycle review after the participation plan is complete.
