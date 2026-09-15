# Pi Tools Package Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create and release `dvdkrv/pi-tools` as one organization-neutral Pi package containing the six existing extensions and their shared implementation.

**Architecture:** Consolidate the seven current local package trees into one root package with six entrypoints, capability-scoped source and test directories, and one dependency graph. Preserve behavior while rewriting only paths, package boundaries, examples, and repository infrastructure; publish one clean signed root snapshot and immutable signed `v0.1.0` tag.

**Tech Stack:** TypeScript, Node.js 22.19+/24, Node test runner, jiti 2.7.0, Pi 0.82.0 SDK peers, NATS/JetStream 3.4.0 client libraries, NATS Server 2.14.6, GitHub Actions, SSH-signed Git commits/tags.

## Global Constraints

- Work in `~/personal/pi-tools`; the source dotfiles checkout is read-only during this plan.
- Use SSH only. `origin` must be `git@github-personal:dvdkrv/pi-tools.git`.
- Every working commit and the final root commit must be signed by `SHA256:YD5aofj7Ho7upNN2q7RI2R5mPJPQGKpO+91P4NkmARY` and authored as `David Kirov <31777857+dvdkrv@users.noreply.github.com>`.
- Preserve extension behavior and the messaging v2 wire/ledger formats exactly; do not connect to live messaging state.
- Tests use isolated brokers and scripted providers; no paid inference, live broker mutation, or live message-body reads.
- Do not copy Git history, `node_modules`, credentials, broker state, sessions, scratch reports, or `docs/superpowers`.
- Public tracked files must contain no `DataDog`, `datadog`, `ddog`, `/home/bits`, or `/Users/david.kirov` identifiers.
- Keep `git:github.com/obra/superpowers@v6.2.0` outside this package.
- The final published branch contains one clean signed root commit. Checkpoint commits are local-only and are squashed before push.
- Never move or replace the published `v0.1.0` tag.

---

### Task 1: Bootstrap the single-package contract

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `LICENSE`
- Create: `tests/package.test.mjs`

**Interfaces:**
- Consumes: empty `dvdkrv/pi-tools` remote and the forwarded `github-personal` SSH identity.
- Produces: one root package manifest with `pi.extensions`, `./messaging/public`, root validation scripts, and fixed dependency versions used by every later task.

- [ ] **Step 1: Clone the empty repository over the personal SSH route**

```bash
mkdir -p ~/personal
cd ~/personal
git clone git@github-personal:dvdkrv/pi-tools.git
cd pi-tools
git switch -c main
```

Expected: the clone reports an empty repository and `git remote get-url origin` prints `git@github-personal:dvdkrv/pi-tools.git`.

- [ ] **Step 2: Configure and verify repository-local identity**

```bash
git config --local user.name 'David Kirov'
git config --local user.email '31777857+dvdkrv@users.noreply.github.com'
git config --local user.signingkey ~/.ssh/id_ed25519_personal.pub
git config --local gpg.format ssh
git config --local gpg.ssh.program ssh-keygen
git config --local gpg.ssh.allowedSignersFile ~/.ssh/allowed_signers_personal
git config --local commit.gpgsign true
git config --local tag.gpgsign true
ssh -T github-personal 2>&1 | grep -F 'Hi dvdkrv!'
```

Expected: GitHub identifies `dvdkrv`; no work email appears in `git config --local --list`.

- [ ] **Step 3: Write the failing package contract test**

Create `tests/package.test.mjs` asserting:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const extensions = [
  './extensions/claude-skill.ts',
  './extensions/loop.ts',
  './extensions/messaging.ts',
  './extensions/task.ts',
  './extensions/theme-sync.ts',
  './extensions/worktree-manager.ts',
];

test('root manifest exposes one Pi package', () => {
  assert.equal(pkg.name, 'pi-tools');
  assert.equal(pkg.version, '0.1.0');
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, 'MIT');
  assert.deepEqual(pkg.pi?.extensions, extensions);
  assert.equal(pkg.exports?.['./messaging/public'], './src/messaging/public.ts');
  assert.deepEqual(pkg.engines, { node: '>=22.19.0' });
});

test('Pi host imports are peers and NATS clients are runtime dependencies', () => {
  for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox']) {
    assert.equal(pkg.peerDependencies?.[name], '*');
  }
  for (const name of ['@nats-io/transport-node', '@nats-io/jetstream', '@nats-io/kv']) {
    assert.equal(pkg.dependencies?.[name], '3.4.0');
  }
  assert.equal(pkg.devDependencies?.jiti, '2.7.0');
});

```

- [ ] **Step 4: Run the contract test and confirm the package is absent**

Run: `node --test tests/package.test.mjs`

Expected: FAIL because `package.json` does not exist.

- [ ] **Step 5: Create the root manifest and configuration**

Create `package.json` with `private: true`, `type: "module"`, `license: "MIT"`, `keywords: ["pi-package"]`, the exact six-entry `pi.extensions` array above, and:

```json
{
  "scripts": {
    "test": "node --test tests/*.test.mjs tests/*/*.test.mjs",
    "test:messaging": "PI_MESSAGING_REQUIRE_BROKER=1 node --test tests/messaging/*.test.mjs",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "check": "node scripts/check-repository.mjs",
    "broker": "node --experimental-strip-types src/messaging/broker.ts",
    "test:live": "node scripts/messaging-live-smoke.mjs"
  },
  "exports": {
    "./messaging/public": "./src/messaging/public.ts"
  },
  "dependencies": {
    "@nats-io/jetstream": "3.4.0",
    "@nats-io/kv": "3.4.0",
    "@nats-io/transport-node": "3.4.0"
  },
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  },
  "devDependencies": {
    "@earendil-works/pi-ai": "0.82.0",
    "@earendil-works/pi-coding-agent": "0.82.0",
    "@earendil-works/pi-tui": "0.82.0",
    "@types/node": "26.1.1",
    "jiti": "2.7.0",
    "typebox": "1.3.8",
    "typescript": "7.0.2"
  },
  "overrides": {
    "@earendil-works/pi-ai": "0.82.0",
    "@earendil-works/pi-coding-agent": "0.82.0",
    "@earendil-works/pi-tui": "0.82.0",
    "typebox": "1.3.8"
  },
  "engines": { "node": ">=22.19.0" }
}
```

Create `tsconfig.json` with the dotfiles compiler options and `include: ["extensions/**/*.ts", "src/**/*.ts"]`. Create `.gitignore` containing `node_modules/`, coverage output, logs, and editor/OS artifacts. Add the standard MIT license with copyright `2026 David Kirov`.

- [ ] **Step 6: Generate the lockfile and verify the package contract**

```bash
npm install --package-lock-only --ignore-scripts
node --test tests/package.test.mjs
```

Expected: all manifest and dependency assertions pass.

- [ ] **Step 7: Create a signed local checkpoint**

```bash
git add package.json package-lock.json tsconfig.json .gitignore LICENSE tests/package.test.mjs
git commit -S -m 'chore: define consolidated Pi package'
git verify-commit HEAD
```

Expected: a good signature for the noreply personal email and fingerprint `YD5a…NkmARY`. Do not push.

---

### Task 2: Consolidate worktree, task, and Claude bridge capabilities

**Files:**
- Create: `src/worktree/index.ts`
- Create: `src/worktree/fuzzy-select.ts`
- Create: `extensions/worktree-manager.ts`
- Create: `extensions/task.ts`
- Create: `extensions/claude-skill.ts`
- Create: `tests/worktree/core.test.mjs`
- Create: `tests/worktree/fuzzy-select.test.mjs`
- Create: `tests/worktree/worktree-manager.test.mjs`
- Create: `tests/worktree/worktree-manager-redesign.test.mjs`
- Create: `tests/task/task.test.mjs`
- Create: `tests/claude-bridge/claude-skill.test.mjs`
- Create: `tests/claude-bridge/fuzzy-select.test.mjs`

**Interfaces:**
- Consumes: `src/worktree/index.ts` and `src/worktree/fuzzy-select.ts` copied byte-for-byte before import rewrites.
- Produces: relative imports from the three extensions to the internal worktree modules; no `pi-worktree-core` runtime package.

- [ ] **Step 1: Copy tests first and update only their new module paths**

Copy the four worktree/core-manager tests, the task test, and two Claude bridge tests from the source checkout into the paths above. Update imports as follows:

```text
../../pi-worktree-core/src/fuzzy-select.ts -> ../../src/worktree/fuzzy-select.ts
../src/index.ts                           -> ../../src/worktree/index.ts
../src/fuzzy-select.ts                    -> ../../src/worktree/fuzzy-select.ts
../extensions/<name>.ts                   -> ../../extensions/<name>.ts
```

In worktree fixtures replace `/home/bits` with `/home/alice` while preserving the same assertions.

- [ ] **Step 2: Run the capability tests and confirm missing modules**

Run:

```bash
node --test tests/worktree/*.test.mjs tests/task/*.test.mjs tests/claude-bridge/*.test.mjs
```

Expected: FAIL with missing `src/worktree` or extension entrypoints.

- [ ] **Step 3: Copy implementation and replace package imports with relative imports**

Copy the two worktree source files and three extension entrypoints. Apply these exact import changes:

```text
pi-worktree-core/index        -> ../src/worktree/index.ts
pi-worktree-core/fuzzy-select -> ../src/worktree/fuzzy-select.ts
```

In `extensions/worktree-manager.ts`, change the manual repository placeholder from `~/go/src/github.com/DataDog/repo` to `~/src/github.com/owner/repo`. Do not change command names, tool schemas, rendering, worktree safety, or process behavior.

- [ ] **Step 4: Run focused tests and typecheck**

```bash
node --test tests/worktree/*.test.mjs tests/task/*.test.mjs tests/claude-bridge/*.test.mjs
npm run typecheck
```

Expected: all focused tests and typecheck pass for the source files present at this checkpoint.

- [ ] **Step 5: Create a signed local checkpoint**

```bash
git add extensions src/worktree tests/worktree tests/task tests/claude-bridge
git commit -S -m 'feat: consolidate worktree and task tools'
git verify-commit HEAD
```

Do not push.

---

### Task 3: Import the cache-stable loop extension

**Files:**
- Create: `extensions/loop.ts`
- Create: `tests/loop/loop.test.mjs`
- Create: `tests/loop/loop-sdk.test.mjs`

**Interfaces:**
- Consumes: the verified loop implementation from dotfiles `main`.
- Produces: unchanged `loop_control` schema, decision latch, default 12-run cap, 1–100 validation, initial-run accounting, 85% context stop, and cache-stable tool surface.

- [ ] **Step 1: Copy loop tests before the entrypoint**

Copy both tests to `tests/loop/` and change their entrypoint import to `../../extensions/loop.ts`.

- [ ] **Step 2: Verify the missing-entrypoint failure**

Run: `node --test tests/loop/*.test.mjs`

Expected: FAIL because `extensions/loop.ts` does not exist.

- [ ] **Step 3: Copy the loop extension without behavioral edits**

Copy `pi-loop-package/extensions/loop.ts` to `extensions/loop.ts`. Preserve the exact tool name, static description/guidance, termination result, context check, and no-request-prefix-mutation behavior.

- [ ] **Step 4: Run focused tests**

Run: `node --test tests/loop/*.test.mjs`

Expected: all loop policy and offline SDK tests pass.

- [ ] **Step 5: Create a signed local checkpoint**

```bash
git add extensions/loop.ts tests/loop
git commit -S -m 'feat: import bounded Pi loop control'
git verify-commit HEAD
```

Do not push.

---

### Task 4: Import lifecycle-safe messaging

**Files:**
- Create: `extensions/messaging.ts`
- Create: `src/messaging/*.ts`
- Create: `tests/messaging/*.test.mjs`
- Create: `tests/messaging/helpers/*.mjs`
- Create: `scripts/messaging-live-smoke.mjs`

**Interfaces:**
- Consumes: the verified ledger-v2 messaging source and tests from dotfiles `main`, `extensions/loop.ts`, and root NATS dependencies.
- Produces: the unchanged `connectBackend`, `MessagingRuntime`, `ensureBroker`, `connectReader`, `peer_message`, and `/messages` interfaces under consolidated paths.

- [ ] **Step 1: Copy messaging tests and rewrite only relative paths**

Copy every tracked messaging test and helper to `tests/messaging/`. Copy `scripts/live-smoke.mjs` to `scripts/messaging-live-smoke.mjs`. Apply this path mapping:

```text
../src/<file>.ts             -> ../../src/messaging/<file>.ts
../../src/<file>.ts          -> ../../../src/messaging/<file>.ts   (helpers)
../extensions/messaging.ts   -> ../../extensions/messaging.ts
../../pi-loop-package/extensions/loop.ts -> ../../extensions/loop.ts
../src/nats-backend.ts       -> ../src/messaging/nats-backend.ts   (live script)
```

Keep broker helpers isolated and retain `PI_MESSAGING_REQUIRE_BROKER` behavior.

- [ ] **Step 2: Verify the moved tests fail on missing messaging modules**

Run:

```bash
NATS_SERVER=/tmp/pi-messaging-nats-2.14.6/nats-server-v2.14.6-linux-amd64/nats-server \
PI_MESSAGING_REQUIRE_BROKER=1 node --test tests/messaging/*.test.mjs
```

Expected: FAIL because `src/messaging` and `extensions/messaging.ts` do not exist. The command must not reference the live broker configuration.

- [ ] **Step 3: Copy source and update the extension entrypoint imports**

Copy all `pi-messaging/src/*.ts` into `src/messaging/` and copy the extension entrypoint. Change its imports from `../src/<file>.ts` to `../src/messaging/<file>.ts`. Do not change contracts, NATS subjects/streams, ledger versions, CAS behavior, lease fencing, batching, delivery, receipts, lifecycle behavior, or UI decisions.

- [ ] **Step 4: Run mandatory messaging verification**

```bash
NATS_SERVER=/tmp/pi-messaging-nats-2.14.6/nats-server-v2.14.6-linux-amd64/nats-server \
PI_MESSAGING_REQUIRE_BROKER=1 node --test tests/messaging/*.test.mjs
```

Expected: all messaging tests pass with zero skips. Verify afterward that no `pi-messaging-test-*` NATS process or temporary root remains.

- [ ] **Step 5: Verify the public export and nonparticipating import**

```bash
node --experimental-strip-types --input-type=module <<'EOF'
const api = await import('./src/messaging/public.ts');
if (typeof api.connectReader !== 'function') throw new Error('connectReader export missing');
console.log('messaging-public-export-ok');
EOF
```

Expected: import succeeds without connecting, joining, or starting a process.

- [ ] **Step 6: Create a signed local checkpoint**

```bash
git add extensions/messaging.ts src/messaging tests/messaging scripts/messaging-live-smoke.mjs
git commit -S -m 'feat: import lifecycle-safe Pi messaging'
git verify-commit HEAD
```

Do not push.

---

### Task 5: Import live theme synchronization

**Files:**
- Create: `extensions/theme-sync.ts`
- Create: `src/theme/state.ts`
- Create: `tests/theme/theme-state.test.mjs`
- Create: `tests/theme/theme-sync.test.mjs`

**Interfaces:**
- Consumes: current theme-state parser/watcher behavior and Pi `light`/`dark` themes.
- Produces: the same lifecycle-safe theme synchronization with the consolidated `src/theme/state.ts` import.

- [ ] **Step 1: Copy tests and point them at consolidated paths**

Copy both theme tests. Change `../src/theme-state.ts` to `../../src/theme/state.ts` and the entrypoint import to `../../extensions/theme-sync.ts`.

- [ ] **Step 2: Confirm missing modules**

Run: `node --test tests/theme/*.test.mjs`

Expected: FAIL because the consolidated theme files do not exist.

- [ ] **Step 3: Copy implementation with one path rewrite**

Copy `theme-state.ts` to `src/theme/state.ts` and the extension entrypoint to `extensions/theme-sync.ts`. Change its import to `../src/theme/state.ts`. Preserve watcher startup fencing, cleanup, persistence, and built-in Pi theme selection behavior.

- [ ] **Step 4: Run focused tests and full typecheck**

```bash
node --test tests/theme/*.test.mjs
npm run typecheck
```

Then add `existsSync` to the existing `node:fs` import and extend `tests/package.test.mjs` with:

```js
test('package resources exist', () => {
  for (const path of extensions) {
    assert.equal(existsSync(new URL(`..${path.slice(1)}`, import.meta.url)), true, path);
  }
});
```

Run: `node --test tests/package.test.mjs`

Expected: theme tests, typecheck, and all six package resource checks pass.

- [ ] **Step 5: Create a signed local checkpoint**

```bash
git add extensions/theme-sync.ts src/theme tests/theme
git commit -S -m 'feat: import live Pi theme synchronization'
git verify-commit HEAD
```

Do not push.

---

### Task 6: Add neutral public documentation and repository checks

**Files:**
- Create: `README.md`
- Create: `scripts/check-repository.mjs`
- Modify: `tests/package.test.mjs`

**Interfaces:**
- Consumes: all consolidated capabilities and their root manifest.
- Produces: public installation/security documentation and a deterministic organization-neutrality/private-state check.

- [ ] **Step 1: Extend the repository contract test**

Add assertions that README contains each extension name, the full-system-access warning, NATS 2.14.6 requirement, loopback-only messaging boundary, human-controlled participation/allowance/recovery, and these SSH install commands:

```text
pi install git:git@github.com:dvdkrv/pi-tools.git@v0.1.0
pi -e git:git@github.com:dvdkrv/pi-tools.git@v0.1.0
```

Assert that `scripts/check-repository.mjs` exists and that no nested `package.json` is present below the root.

- [ ] **Step 2: Verify documentation/check failures**

Run: `node --test tests/package.test.mjs`

Expected: FAIL because README and the repository checker are missing.

- [ ] **Step 3: Write the README**

Use these sections in order: `Pi Tools`, `Security`, `Extensions`, `Installation`, `Messaging broker`, `Messaging lifecycle`, `Configuration`, `Development`, and `Release policy`. Document all six entrypoints, the separate Superpowers package, NATS loopback/token boundary, no automatic participation, signed immutable tags, and the exact install commands above. Use generic paths such as `~/src/github.com/owner/repo`.

- [ ] **Step 4: Implement repository checks**

Create `scripts/check-repository.mjs` to enumerate tracked files with `git ls-files -z`, reject symlinks, reject tracked `node_modules`, reject files named `config.json`, `server.json`, `broker.log`, or `broker-process.json`, and scan UTF-8 tracked text for:

```js
const forbidden = [
  /DataDog/i,
  /ddog/i,
  /\/home\/bits/,
  /\/Users\/david\.kirov/,
  /BEGIN OPENSSH PRIVATE KEY/,
  /PM_CONTROL.*token/i,
];
```

Permit no exceptions. Print only file paths and rule names, never matching content.

- [ ] **Step 5: Run public-boundary checks**

```bash
node --test tests/package.test.mjs
npm run check
git diff --check
```

Expected: all pass and no private content is printed.

- [ ] **Step 6: Create a signed local checkpoint**

```bash
git add README.md scripts/check-repository.mjs tests/package.test.mjs
git commit -S -m 'docs: document the consolidated Pi package'
git verify-commit HEAD
```

Do not push.

---

### Task 7: Add Node compatibility CI and installation tests

**Files:**
- Create: `.github/workflows/check.yml`
- Create: `tests/install.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: the complete root package and pinned NATS archive checksum.
- Produces: Node 22.19 and 24 CI, production-install validation, and extension entrypoint import validation without inference.

- [ ] **Step 1: Add a failing install-script contract**

Extend `tests/package.test.mjs` with:

```js
test('root scripts include the production install matrix', () => {
  assert.equal(pkg.scripts?.['test:install'], 'node --test tests/install.test.mjs');
});
```

Run: `node --test tests/package.test.mjs`

Expected: FAIL because `test:install` is absent.

- [ ] **Step 2: Implement the production-install test**

Create `tests/install.test.mjs` that copies only tracked package files into a temporary directory, runs:

```text
npm install --omit=dev --package-lock=false --ignore-scripts --legacy-peer-deps
```

then symlinks only the installed Pi host peers (`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`) from the test host into the temporary `node_modules`. Import each of the six extension entrypoints with jiti and assert that its default export is a function. Always delete the temporary root.

Use `git ls-files -z` for the copy list, exclude `.git`, and create relative parent directories before copying. Resolve host peers with `createRequire(import.meta.url).resolve('<package>/package.json')`; never copy installed settings or agent directories. Make subprocess output bounded to 50 KiB. Add `"test:install": "node --test tests/install.test.mjs"` to `package.json`, regenerate the lockfile, and run:

```bash
node --test tests/package.test.mjs
npm run test:install
```

Expected: the new script contract and all six production-installed entrypoint imports pass without live configuration.

- [ ] **Step 3: Add CI**

Create `.github/workflows/check.yml` with read-only contents permission and two jobs:

- `validate` on Node 24: checkout, setup-node cache, download NATS Server 2.14.6, verify SHA-256 `61c3d55f69f61ec616b75782250936445f2819e9e5f2ae6159b10a31abd2200c`, `npm ci --ignore-scripts`, mandatory broker-gated `npm test`, `npm run typecheck`, `npm run check`, and `git diff --check`.
- `minimum-runtime` on Node 22.19.0: the same verified broker download, `npm ci --ignore-scripts`, mandatory broker-gated `npm test`, and `npm run typecheck`.

Use isolated `$RUNNER_TEMP` paths. Do not launch Pi or call a provider.

- [ ] **Step 4: Run the complete local matrix**

```bash
npm ci --ignore-scripts
PI_MESSAGING_REQUIRE_BROKER=1 \
NATS_SERVER=/tmp/pi-messaging-nats-2.14.6/nats-server-v2.14.6-linux-amd64/nats-server \
npm test
npm run typecheck
npm run check
git diff --check
```

Expected: all tests pass with zero broker skips. Run the same `npm test` and typecheck commands under Node 22.19.0 and Node 24 using the available version manager or downloaded runtimes.

- [ ] **Step 5: Create a signed local checkpoint**

```bash
git add .github/workflows/check.yml tests/install.test.mjs package.json package-lock.json
git commit -S -m 'ci: verify Pi package compatibility'
git verify-commit HEAD
```

Do not push.

---

### Task 8: Produce and publish the clean signed v0.1.0 snapshot

**Files:**
- No product-file changes expected.
- Rewrites: local unpublished Git history only.

**Interfaces:**
- Consumes: fully verified checkpoint tree from Tasks 1–7.
- Produces: one signed root commit on `main`, one signed immutable `v0.1.0` tag, and a verified public SSH release.

- [ ] **Step 1: Record and verify the checkpoint tree**

```bash
cd ~/personal/pi-tools
checkpoint_tree=$(git rev-parse HEAD^{tree})
git status --short
git log --format='%G? %h %ae %s' --reverse
```

Expected: clean worktree; every checkpoint shows `G` and the noreply email.

- [ ] **Step 2: Run the final mandatory verification**

```bash
PI_MESSAGING_REQUIRE_BROKER=1 \
NATS_SERVER=/tmp/pi-messaging-nats-2.14.6/nats-server-v2.14.6-linux-amd64/nats-server \
npm test
npm run typecheck
npm run check
git diff --check
```

Expected: zero failures and zero broker skips. Confirm no test broker processes or temporary roots remain.

- [ ] **Step 3: Replace local checkpoint history with one signed root commit**

```bash
root_commit=$(printf '%s\n\n%s\n' \
  'feat: publish consolidated Pi tools' \
  'Consolidate the locally maintained Pi extensions into one package.' \
  | git commit-tree -S "$checkpoint_tree")
git reset --hard "$root_commit"
test "$(git rev-parse HEAD^{tree})" = "$checkpoint_tree"
git verify-commit HEAD
```

Expected: `git rev-list --count HEAD` is `1`; tree hash is unchanged; signature belongs to the personal key.

- [ ] **Step 4: Create and verify the signed annotated tag**

```bash
git tag -s v0.1.0 -m 'pi-tools v0.1.0'
git verify-tag v0.1.0
test "$(git rev-list -n1 v0.1.0)" = "$(git rev-parse HEAD)"
```

Expected: good personal SSH signature and exact HEAD target.

- [ ] **Step 5: Push branch and tag over SSH**

```bash
test "$(git remote get-url origin)" = 'git@github-personal:dvdkrv/pi-tools.git'
git push --set-upstream origin main
git push origin refs/tags/v0.1.0
```

Never use `--force` and never retag.

- [ ] **Step 6: Verify remote refs and GitHub identity**

```bash
test "$(git ls-remote origin refs/heads/main | cut -f1)" = "$(git rev-parse HEAD)"
test "$(git ls-remote origin 'refs/tags/v0.1.0^{}' | cut -f1)" = "$(git rev-parse HEAD)"
ssh -T github-personal 2>&1 | grep -F 'Hi dvdkrv!'
```

Expected: remote branch and peeled tag point to the verified root commit.

- [ ] **Step 7: Validate a fresh tagged Pi install without touching live settings**

```bash
tmp=$(mktemp -d /tmp/pi-tools-tag-install.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
PI_CODING_AGENT_DIR="$tmp/agent" \
  pi install 'git:git@github.com:dvdkrv/pi-tools.git@v0.1.0'
PI_CODING_AGENT_DIR="$tmp/agent" pi list \
  | grep -F 'git:git@github.com:dvdkrv/pi-tools.git@v0.1.0'
```

Run the repository’s offline entrypoint/import matrix against the resulting clone. Expected: all six entrypoints load, no provider request occurs, and the temporary agent directory is removed.

- [ ] **Step 8: Record the release evidence for the dotfiles transition**

Record only commit ID, tag verification, test counts, Node versions, and install result in the implementation handoff. Do not record settings, credentials, leases, or message bodies.
