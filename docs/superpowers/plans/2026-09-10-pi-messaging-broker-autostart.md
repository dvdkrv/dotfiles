# Pi Messaging Broker Autostart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision NATS Server through Homebrew and automatically start one private detached broker from the first Pi session that needs it.

**Architecture:** A focused `broker-lifecycle.ts` module performs authenticated health checks and serializes startup with an owner-only lock. Pi calls it from `session_start` and again before opening a messaging backend; a healthy manual broker is a no-op, while a new detached NATS process survives the initiating Pi process.

**Tech Stack:** TypeScript; Node >=22.19; Pi extension lifecycle APIs tested on 0.82.0 and 0.84.1; NATS Server 2.14.6; official NATS TypeScript 3.4.0 clients; Homebrew/Chezmoi; Node test runner and jiti 2.7.0.

## Global Constraints

- Broker startup is infrastructure only: never join, resume, arm, send, read a body, or trigger a model turn.
- Start from `session_start`, never from the extension factory or resource discovery.
- One broker per existing loopback configuration; never choose a replacement port or authority after failure.
- Existing owner-only config and JetStream data remain authoritative; authentication/authority/state mismatch fails closed.
- No systemd, launchd, tmux, remote listener, custom downloader, or third-party supervisor.
- The detached broker outlives the initiating Pi session; `session_shutdown` must not stop it.
- Startup locks, logs, and metadata are owner-only, non-symlink paths and never contain the private token.
- Preserve the foreground `npm run broker --workspace pi-messaging` diagnostic path.
- Tests use isolated agent directories, ports, and process groups and clean up only processes they create.
- Do not alter the user's running broker, memberships, messages, or allowance during implementation.

---

## File structure

- `dot_Brewfile` — provision `nats-server` through the existing cross-platform package bundle.
- `tests/pi-package-dependencies.test.mjs` — assert durable broker provisioning remains declared.
- `pi-messaging/src/broker-lifecycle.ts` — authenticated probe, private startup lock/log/process metadata, detached process launch, bounded startup coordination, and `ensureBroker()`.
- `pi-messaging/src/broker.ts` — share server-config/readiness primitives while retaining foreground ownership and Ctrl+C behavior.
- `pi-messaging/extensions/messaging.ts` — invoke broker readiness at Pi session start and immediately before backend connection.
- `pi-messaging/tests/autostart.test.mjs` — deterministic and real-process startup, race, persistence, permissions, and failure tests.
- `pi-messaging/tests/helpers/autostart-contender.mjs` — independent process used to prove only one concurrent starter wins and that the broker outlives its caller.
- `pi-messaging/tests/config.test.mjs` — private-path and stale-lock edge cases.
- `pi-messaging/tests/extension.test.mjs` — Pi lifecycle integration and non-model warning behavior.
- `pi-messaging/README.md` — installation, automatic lifecycle, diagnostics, and recovery.
- `.github/workflows/check.yml` — retain the pinned CI broker and exercise broker-gated autostart tests on Node 24 and 22.19.

---

### Task 1: Provision NATS Server through the existing package bundle

**Files:**
- Modify: `tests/pi-package-dependencies.test.mjs:95-128`
- Modify: `dot_Brewfile:1-15`

**Interfaces:**
- Consumes: existing `brew bundle --file="$CHEZMOI_SOURCE_DIR/dot_Brewfile"` hook in `run_onchange_before_01-install-packages.sh.tmpl`.
- Produces: `nats-server` available on the normal Homebrew `PATH` for `ensureBroker()`.

- [ ] **Step 1: Write the failing provisioning test**

Append this repository test:

```js
test('cross-platform package bundle provisions the Pi messaging broker', () => {
  const brewfile = readFileSync('dot_Brewfile', 'utf8');
  assert.equal(
    brewfile.split(/\r?\n/).filter(line => line === 'brew "nats-server"').length,
    1,
    'nats-server should be installed exactly once through Homebrew',
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node --test --test-name-pattern='package bundle provisions' tests/pi-package-dependencies.test.mjs
```

Expected: FAIL because `dot_Brewfile` does not contain `brew "nats-server"`.

- [ ] **Step 3: Add the Homebrew formula**

Add exactly one line next to the other terminal/runtime tools:

```ruby
brew "nats-server"
```

Do not run `brew upgrade` or modify unrelated formula versions.

- [ ] **Step 4: Verify provisioning and rendered repository state**

Run:

```bash
node --test --test-name-pattern='package bundle provisions' tests/pi-package-dependencies.test.mjs
npm run check
git diff --check
```

Expected: provisioning test PASS; repository check reports rendered templates and Neovim startup as healthy.

- [ ] **Step 5: Commit the provisioning change**

```bash
git add dot_Brewfile tests/pi-package-dependencies.test.mjs
git commit -m "chore: provision NATS messaging broker"
```

---

### Task 2: Build authenticated readiness and private detached launch

**Files:**
- Create: `pi-messaging/src/broker-lifecycle.ts`
- Modify: `pi-messaging/src/broker.ts:1-48`
- Create: `pi-messaging/tests/autostart.test.mjs`
- Modify: `pi-messaging/tests/config.test.mjs:1-40`

**Interfaces:**
- Consumes: `BrokerConfig`, `defaultAgentDir()`, `prepareConfig()`, `readConfig()`, `markInitialized()`, `messagingDir()`, `privatePath()`, and `connectBackend()`.
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
export async function probeBroker(config: BrokerConfig, timeoutMs?: number): Promise<BrokerReadiness>;
export async function ensureBroker(options?: EnsureBrokerOptions): Promise<{ state: 'running' | 'started'; config: BrokerConfig }>;
export function writeServerConfig(agentDir: string, config: BrokerConfig): string;
```

`probeBroker()` returns `unavailable` only for connection refusal/timeout. Authentication, authority, stream, and initialized-state errors throw. `ensureBroker()` never exposes the token.

- [ ] **Step 1: Write failing no-op, launch, permission, and failure tests**

Create `autostart.test.mjs` with an `autostartRoot(t, { running?: boolean })` helper that allocates an agent directory/port, resolves `process.env.NATS_SERVER`, optionally starts the existing foreground launcher, records only its own PID, and registers bounded process/directory cleanup. The core assertions must be explicit:

```js
test('healthy authenticated broker is a no-op', async t => {
  const f = await autostartRoot(t, { running: true });
  const serverFile = join(f.root, 'messaging', 'server.json');
  const before = await stat(serverFile);
  const result = await ensureBroker({ agentDir: f.root, binary: f.binary, port: f.port });
  assert.equal(result.state, 'running');
  assert.equal((await stat(serverFile)).mtimeMs, before.mtimeMs);
});

test('ensureBroker starts a detached private broker and validates authoritative state', async t => {
  const f = await autostartRoot(t);
  const result = await ensureBroker({ agentDir: f.root, binary: f.binary, port: f.port });
  assert.equal(result.state, 'started');
  assert.equal(readConfig(f.root).initialized, true);
  for (const name of ['config.json', 'server.json', 'broker.log', 'broker-process.json']) {
    assert.equal((await stat(join(f.root, 'messaging', name))).mode & 0o777, 0o600);
  }
  const log = await readFile(join(f.root, 'messaging', 'broker.log'), 'utf8');
  assert.equal(log.includes(result.config.token), false);
  assert.equal(await probeBroker(result.config), 'ready');
});

test('wrong authentication and occupied ports fail closed', async t => {
  const f = await foreignBroker(t);
  await assert.rejects(
    ensureBroker({ agentDir: f.root, binary: f.binary, port: f.port, startupTimeoutMs: 1000 }),
    /authentication|authorization|occupied|configuration/i,
  );
  assert.equal(readConfig(f.root).authorityId, f.config.authorityId);
});
```

Add a `foreignBroker(t)` helper that creates a normal messaging config for a free port, starts a separate token-authenticated NATS process on that port with a different token, and registers cleanup for that exact PID. Also test missing binary, initialized ledger loss, startup timeout, unsafe log/lock permissions, and symlink rejection. Record spawned test PIDs and terminate only those in `t.after()`.

- [ ] **Step 2: Run focused tests to verify the module is absent**

Run:

```bash
NATS_SERVER=/tmp/pi-message-queue-review/bin/nats-server \
PI_MESSAGING_REQUIRE_BROKER=1 \
node --test pi-messaging/tests/autostart.test.mjs pi-messaging/tests/config.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/broker-lifecycle.ts`.

- [ ] **Step 3: Factor server configuration out of the foreground launcher**

Move the existing private `server.json` write into exported `writeServerConfig(agentDir, config)`. It must continue using `O_NOFOLLOW`, mode `0600`, loopback host, configured port/token, the existing data path and limits, and `sync_interval: 'always'`.

Keep `runBroker()` behavior unchanged:

```ts
const file = writeServerConfig(agentDir, config);
const child = spawn(binary, ['-c', file], { stdio: ['ignore', 'ignore', 'pipe'] });
```

Its signal handlers still stop only its owned foreground child and preserve data.

- [ ] **Step 4: Implement authenticated probing**

In `broker-lifecycle.ts`, connect with the configured token, no reconnect, and the supplied short timeout. On successful transport connection, call `connectBackend(config, { initialize: !config.initialized })`, close it, and mark a newly initialized config only after that succeeds.

Use a narrow classifier:

```ts
function unavailable(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /ECONNREFUSED|connection refused|TIMEOUT|timed out|no servers available/i.test(text);
}
```

Do not classify authentication, permission, authority, missing-ledger, or stream-configuration failures as unavailable.

- [ ] **Step 5: Implement private lock, log, and detached spawn**

Acquire `startup.lock` with `O_CREAT | O_EXCL | O_NOFOLLOW` and mode `0600`. Store only `{ pid, createdAt }`. After lock acquisition, probe again before spawning.

Open `broker.log` with `O_CREAT | O_TRUNC | O_NOFOLLOW`, mode `0600`, and spawn:

```ts
const child = spawn(binary, ['-c', serverFile], {
  detached: true,
  stdio: ['ignore', logFd, logFd],
});
```

Write `broker-process.json` atomically with `{ pid, startedAt, server }`, never the token. Wait until `probeBroker()` returns `ready`, then call `child.unref()`. On initialization failure, kill the newly created process group, wait for exit, retain config/data/log, and rethrow. Always release an owned startup lock.

A waiter probes until the bounded deadline. It may unlink a startup lock only when its filesystem timestamp is older than `startupTimeoutMs`, after one final failed probe. A healthy probe always wins over lock metadata.

- [ ] **Step 6: Run focused tests green**

Run:

```bash
NATS_SERVER=/tmp/pi-message-queue-review/bin/nats-server \
PI_MESSAGING_REQUIRE_BROKER=1 \
node --test pi-messaging/tests/autostart.test.mjs pi-messaging/tests/config.test.mjs pi-messaging/tests/broker.test.mjs
npm run typecheck
```

Expected: all focused tests PASS; TypeScript reports no errors.

- [ ] **Step 7: Commit the lifecycle module**

```bash
git add pi-messaging/src/broker-lifecycle.ts pi-messaging/src/broker.ts \
  pi-messaging/tests/autostart.test.mjs pi-messaging/tests/config.test.mjs
git commit -m "feat: start private messaging broker on demand"
```

---

### Task 3: Prove concurrent startup and caller-independent lifetime

**Files:**
- Create: `pi-messaging/tests/helpers/autostart-contender.mjs`
- Modify: `pi-messaging/tests/autostart.test.mjs`

**Interfaces:**
- Consumes: `ensureBroker(options)` from Task 2 and isolated test root/binary/port values over IPC.
- Produces: process-level evidence that one broker survives starter exit and startup races do not create another authority/process.

- [ ] **Step 1: Write the independent contender helper**

The helper imports `ensureBroker`, executes it once, sends only non-secret result metadata over IPC, and exits naturally:

```js
process.on('message', async ({ agentDir, binary, port }) => {
  try {
    const result = await ensureBroker({ agentDir, binary, port, startupTimeoutMs: 10000 });
    process.send?.({ state: result.state, authorityId: result.config.authorityId });
    process.disconnect?.();
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.message : String(error) });
    process.disconnect?.();
    process.exitCode = 1;
  }
});
```

- [ ] **Step 2: Write the process-level race and lifetime regression test**

Add a test that forks eight contenders at once against one empty isolated agent directory. Assert:

```js
assert.equal(results.filter(r => r.state === 'started').length, 1);
assert.equal(new Set(results.map(r => r.authorityId)).size, 1);
await Promise.all(children.map(child => once(child, 'exit')));
assert.equal(await probeBroker(readConfig(root)), 'ready');
const processInfo = JSON.parse(await readFile(join(root, 'messaging', 'broker-process.json'), 'utf8'));
assert.doesNotThrow(() => process.kill(processInfo.pid, 0));
```

Then start a ninth contender and assert it returns `running`. Kill the isolated NATS PID from `broker-process.json` in cleanup and verify no descendant remains.

- [ ] **Step 3: Run the process-level test against Task 2's lock implementation**

Run:

```bash
for i in 1 2 3; do
  NATS_SERVER=/tmp/pi-message-queue-review/bin/nats-server \
  PI_MESSAGING_REQUIRE_BROKER=1 \
  node --test --test-name-pattern='concurrent startup' pi-messaging/tests/autostart.test.mjs || exit
 done
```

Expected: all three runs PASS if Task 2's lock semantics hold across processes. A failure is evidence of a process-boundary defect, not permission to weaken authentication or authority checks.

- [ ] **Step 4: Investigate and fix only a confirmed process-boundary defect**

If Step 3 fails, preserve its output, trace winner/waiter probes and lock ownership, and adjust only the demonstrated lock acquisition/wait logic. The lock winner remains the sole spawner; waiters use capped authenticated probes. An ambiguous config/ledger write remains an error and is never retried as a fresh authority. If Step 3 passes, make no production change in this step.

Use condition-based waits rather than fixed sleeps in tests. Bound every child, probe, and cleanup wait.

- [ ] **Step 5: Verify race and persistence green**

Run:

```bash
for i in 1 2 3; do
  NATS_SERVER=/tmp/pi-message-queue-review/bin/nats-server \
  PI_MESSAGING_REQUIRE_BROKER=1 \
  node --test --test-name-pattern='concurrent startup|survives starter' pi-messaging/tests/autostart.test.mjs || exit
 done
```

Expected: one starter each run, one authority, authenticated broker remains after all contenders exit, and cleanup removes only the isolated process.

- [ ] **Step 6: Commit the process-race coverage**

```bash
git add pi-messaging/tests/autostart.test.mjs pi-messaging/tests/helpers/autostart-contender.mjs \
  pi-messaging/src/broker-lifecycle.ts
git commit -m "test: cover concurrent broker autostart"
```

---

### Task 4: Integrate readiness with Pi lifecycle without joining

**Files:**
- Modify: `pi-messaging/extensions/messaging.ts:10-55,68-94`
- Modify: `pi-messaging/tests/extension.test.mjs:10-125`

**Interfaces:**
- Consumes: `ensureBroker(): Promise<{ state; config }>`.
- Produces: `registerMessaging(pi, factory?, ensure?)`, where the optional third dependency enables deterministic lifecycle tests without spawning a process.

- [ ] **Step 1: Replace the obsolete inert-start assertion with failing lifecycle tests**

Update the fixture to capture ensure calls separately from backend-factory calls. Add assertions:

```js
test('session start ensures infrastructure without joining or granting allowance', async t => {
  const f = fixture(t);
  assert.equal(f.ensureCalls.length, 0, 'factory load must remain inert');
  await f.events.get('session_start')({ reason: 'startup' }, f.ctx);
  assert.equal(f.ensureCalls.length, 1);
  assert.equal(f.connectCalls.length, 0);
  assert.equal(f.backend.peer, undefined);
  assert.equal(f.state.groups[f.group.id].limit, 0);
  assert.equal(f.delivered.length, 0);
});

test('startup failure warns outside model context and messages command retries', async t => {
  const f = fixture(t, { ensureError: new Error('nats-server missing') });
  await f.events.get('session_start')({ reason: 'startup' }, f.ctx);
  assert.match(f.notices.at(-1)[0], /nats-server missing/i);
  f.succeedEnsure();
  await f.commands.get('messages').handler('status', f.ctx);
  assert.equal(f.ensureCalls.length, 2);
  assert.equal(f.delivered.length, 0);
});
```

Keep non-TUI participation controls rejected before backend connection. In non-TUI startup, assert no dialog method is called.

- [ ] **Step 2: Run the extension tests red**

Run:

```bash
node --test --test-name-pattern='session start ensures|startup failure warns' pi-messaging/tests/extension.test.mjs
```

Expected: FAIL because `session_start` currently only shuts down state and `registerMessaging` has no ensure dependency.

- [ ] **Step 3: Wire `ensureBroker` into the session lifecycle**

Change registration to accept a defaulted readiness dependency:

```ts
export function registerMessaging(
  pi: ExtensionAPI,
  factory: () => Promise<MessagingBackend> = configuredBackend,
  ensure: () => Promise<unknown> = () => ensureBroker(),
): void
```

On `session_start`, first finish local detach/reset, then call `ensure()` in a separate guarded block. Report one concise warning through `ctx.ui.notify(..., 'warning')` only when `ctx.hasUI`; do not inject a custom message or throw through model context.

In the `/messages` handler, call the injected `ensure()` immediately before invoking the backend factory whenever a connection is needed. A healthy broker is a no-op, and tests can prove the retry without starting a process. Keep `configuredBackend()` focused on reading config/connecting, and keep dialogs/backend participation human-triggered.

Do not add a shutdown call for the detached broker.

- [ ] **Step 4: Run lifecycle and coexistence tests**

Run:

```bash
node --test pi-messaging/tests/extension.test.mjs pi-messaging/tests/coexistence.test.mjs
npm run typecheck
```

Expected: all tests PASS; factory load remains process-free; session start does not join/arm/deliver; loop extension behavior is unchanged.

- [ ] **Step 5: Commit Pi lifecycle integration**

```bash
git add pi-messaging/extensions/messaging.ts pi-messaging/tests/extension.test.mjs
git commit -m "feat: ensure messaging broker on Pi startup"
```

---

### Task 5: Documentation and full autostart verification

**Files:**
- Modify: `pi-messaging/README.md:1-25,77-118`
- Modify: `.github/workflows/check.yml:25-68` only if the new test file is not already included by `tests/*.test.mjs`
- Modify: `docs/superpowers/reviews/2026-09-08-pi-messaging.md`

**Interfaces:**
- Consumes: completed startup behavior and test evidence.
- Produces: accurate operator guidance and final validation record; no new runtime API.

- [ ] **Step 1: Update operator documentation**

Document:

- `brew bundle`/Chezmoi provisions NATS Server;
- first Pi `session_start` performs authenticated autostart;
- broker remains after Pi exits and retains `~/.pi/agent/messaging/data`;
- healthy foreground/manual brokers are reused;
- startup failures do not join or arm anything;
- private log/process metadata locations and token exclusion;
- manual command remains available for diagnostics;
- no OS-login service exists, so startup happens only after Pi is opened.

Remove statements that the extension never starts the broker or requires a babysat foreground terminal.

- [ ] **Step 2: Run broker-gated aggregate verification**

Run:

```bash
NATS_SERVER=/tmp/pi-message-queue-review/bin/nats-server \
PI_MESSAGING_REQUIRE_BROKER=1 npm test
npm run typecheck
npm run lint:shell
npm run check
git diff --check
```

Expected: zero failures/skips in messaging broker tests; all repository checks pass.

- [ ] **Step 3: Run minimum/current Node and installed Pi checks**

Run:

```bash
NATS_SERVER=/tmp/pi-message-queue-review/bin/nats-server \
PI_MESSAGING_REQUIRE_BROKER=1 \
/home/bits/.npm/_npx/992a19d7d9bf36d4/node_modules/node/bin/node \
  --test pi-messaging/tests/*.test.mjs

PI_MESSAGING_PI_SDK=/home/linuxbrew/.linuxbrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js \
node --test pi-messaging/tests/extension.test.mjs
```

Expected: all messaging tests PASS on Node 22.19.0; extension lifecycle tests PASS against installed Pi 0.84.1. The repository development suite covers Pi 0.82.0.

- [ ] **Step 4: Verify production-only package installation**

Use an isolated copy; never modify the live Pi package registration:

```bash
tmp="$(mktemp -d /tmp/pi-messaging-production.XXXXXX)"
cp -R pi-messaging "$tmp/package"
npm install --omit=dev --ignore-scripts --package-lock=false --legacy-peer-deps --prefix "$tmp/package"
node --experimental-strip-types -e "import('$tmp/package/src/broker-lifecycle.ts').then(m => { if (typeof m.ensureBroker !== 'function') process.exit(1) })"
rm -rf "$tmp"
```

Expected: install/import succeeds without dev dependencies.

- [ ] **Step 5: Record evidence and commit docs**

Add dated evidence to the messaging review without claiming OS-login startup or changing the resume protocol yet.

```bash
git add pi-messaging/README.md .github/workflows/check.yml \
  docs/superpowers/reviews/2026-09-08-pi-messaging.md
git commit -m "docs: document messaging broker autostart"
```

- [ ] **Step 6: Review the broker-autostart boundary**

Before beginning the resume plan, inspect the full diff and verify:

```bash
git diff --check HEAD~5..HEAD
git status --short
```

Confirm the feature starts only infrastructure, contains no session membership restoration, and has not touched the user's live broker/config/state. Request an independent code review; fix Critical/Important findings before proceeding.
