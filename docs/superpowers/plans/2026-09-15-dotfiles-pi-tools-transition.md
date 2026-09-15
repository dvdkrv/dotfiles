# Dotfiles Pi Tools Transition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch dotfiles to the signed immutable `dvdkrv/pi-tools@v0.1.0` package, validate it at a human-controlled idle boundary, and remove all local Pi implementation and design-history files from the current tree.

**Architecture:** First make a reversible signed transition commit that installs the verified SSH tag while retaining the local source trees as rollback material. After a fresh Pi process verifies the tagged package against retained messaging state, make a second signed cleanup commit that deletes extracted implementation, package-owned tests/workspaces, `docs/superpowers`, and the obsolete local lifecycle reference.

**Tech Stack:** chezmoi, Bash, Node.js test runner, Pi git packages, SSH Git transport, signed Git commits, NATS Server 2.14.6 provisioning.

## Global Constraints

- Do not begin until `dvdkrv/pi-tools` has a verified signed root commit and signed immutable `v0.1.0` tag.
- Work on current dotfiles `main` with a clean tree and `origin` set to `git@github-personal:dvdkrv/dotfiles.git`.
- Author and sign every new commit as `David Kirov <31777857+dvdkrv@users.noreply.github.com>` with personal fingerprint `YD5a…NkmARY`.
- Git transport is SSH only; never use HTTPS for clone, fetch, install, or push.
- Never print installed settings, broker tokens, leases, or message bodies.
- Package application, Pi reload, and messaging participation occur only after explicit human confirmation at an idle boundary.
- Do not stop or replace the verified detached broker, migrate/downgrade the ledger, alter allowance, or replay/refund messages.
- Preserve NATS/Homebrew and terminal/machine provisioning in dotfiles.
- Remove `docs/superpowers` from the current tree only; do not rewrite dotfiles history.
- Do not force-push or bypass signing.

---

### Task 1: Verify the release gate and write transition contracts

**Files:**
- Modify: `tests/pi-package-dependencies.test.mjs`

**Interfaces:**
- Consumes: remote `dvdkrv/pi-tools` signed tag `v0.1.0` and current dotfiles Pi settings/installer.
- Produces: failing tests specifying one pinned SSH package, separate Superpowers pin, and removal of local package installation behavior.

- [ ] **Step 1: Verify the remote release without installing it**

```bash
cd /home/bits/go/src/github.com/DataDog/dotfiles
git fetch origin main
git merge --ff-only origin/main
release=$(git ls-remote git@github-personal:dvdkrv/pi-tools.git 'refs/tags/v0.1.0^{}' | cut -f1)
test -n "$release"
tmp=$(mktemp -d /tmp/pi-tools-release-verify.XXXXXX)
git clone --no-checkout git@github-personal:dvdkrv/pi-tools.git "$tmp/repo"
git -C "$tmp/repo" fetch origin tag v0.1.0
git -C "$tmp/repo" -c gpg.ssh.program=ssh-keygen -c gpg.ssh.allowedSignersFile=/home/bits/.ssh/allowed_signers_personal verify-tag v0.1.0
test "$(git -C "$tmp/repo" rev-list -n1 v0.1.0)" = "$release"
rm -rf "$tmp"
```

Expected: signed tag verifies with the personal key and the peeled remote tag has one immutable commit ID.

- [ ] **Step 2: Replace local-package assertions with the new package contract**

In `tests/pi-package-dependencies.test.mjs`, define:

```js
const PI_TOOLS_SOURCE = 'git:git@github.com:dvdkrv/pi-tools.git@v0.1.0';
const SUPERPOWERS_SOURCE = 'git:github.com/obra/superpowers@v6.2.0';
```

Replace tests for seven package manifests/workspaces with assertions that:

```js
assert.equal(settings.packages.filter(source => source === PI_TOOLS_SOURCE).length, 1);
assert.equal(settings.packages.filter(source => source === SUPERPOWERS_SOURCE).length, 1);
assert.equal(settings.packages.some(source => /pi-(worktree|task|loop|claude|messaging|theme)/.test(source)), false);
assert.match(installer, /PI_TOOLS_PACKAGE="git:git@github\.com\/dvdkrv\/pi-tools\.git@v0\.1\.0"/);
assert.match(installer, /pi install "\$PI_TOOLS_PACKAGE"/);
assert.doesNotMatch(installer, /LOCAL_PACKAGES|npm install --omit=dev|--prefix "\$pkg"/);
```

Keep theme `light/dark`, Superpowers telemetry, Neovim, README, and general provisioning assertions unchanged.

- [ ] **Step 3: Run the focused test and confirm the old configuration fails**

Run: `node --test tests/pi-package-dependencies.test.mjs`

Expected: FAIL because settings and installer still contain seven local package paths.

---

### Task 2: Switch settings and installer to the signed tag

**Files:**
- Modify: `dot_pi/agent/settings.json.tmpl`
- Modify: `run_onchange_after_06-install-pi-packages.sh.tmpl`
- Modify: `README.md`
- Test: `tests/pi-package-dependencies.test.mjs`

**Interfaces:**
- Consumes: exact `PI_TOOLS_SOURCE` and `SUPERPOWERS_SOURCE` strings from Task 1.
- Produces: one pinned Pi-tools package install path while retaining local package source directories physically until live validation.

- [ ] **Step 1: Replace settings package entries**

Set `packages` to exactly:

```json
[
  "git:git@github.com:dvdkrv/pi-tools.git@v0.1.0",
  "git:github.com/obra/superpowers@v6.2.0"
]
```

Keep `"theme": "light/dark"` and `"defaultThinkingLevel": "high"` unchanged.

- [ ] **Step 2: Simplify the onchange installer**

Replace the local array/npm loop with:

```bash
PI_TOOLS_PACKAGE="git:git@github.com/dvdkrv/pi-tools.git@v0.1.0"
SUPERPOWERS_PACKAGE="git:github.com/obra/superpowers@v6.2.0"

pi install "$PI_TOOLS_PACKAGE"
pi install "$SUPERPOWERS_PACKAGE"
```

Retain `set -euo pipefail` and the `pi`/`npm` prerequisite checks because Pi uses npm to install git-package dependencies. Do not call `pi remove`; settings are authoritative and stale local clones may remain inert.

- [ ] **Step 3: Point README messaging documentation to the public package**

Replace the local `pi-messaging` link with `https://github.com/dvdkrv/pi-tools` and state that dotfiles pins signed tag `v0.1.0`. Keep the local-only broker and explicit-participation safety summary.

- [ ] **Step 4: Run focused and repository verification**

```bash
node --test tests/pi-package-dependencies.test.mjs
npm test
npm run typecheck
npm run lint:shell
npm run check
git diff --check
```

Expected: all existing local-package behavior tests still run from retained trees, while configuration tests require only the signed tag.

- [ ] **Step 5: Commit and push the reversible transition**

```bash
git add dot_pi/agent/settings.json.tmpl run_onchange_after_06-install-pi-packages.sh.tmpl README.md tests/pi-package-dependencies.test.mjs
git commit -S -m 'chore: consume signed pi-tools release'
git verify-commit HEAD
git push origin main
```

Expected: push authenticates as `dvdkrv`; no local package directories are deleted in this commit.

---

### Task 3: Apply and validate the tagged package at an idle boundary

**Files:**
- Managed target only: `~/.pi/agent/settings.json`
- Managed package clone only: `~/.pi/agent/git/github.com/dvdkrv/pi-tools`

**Interfaces:**
- Consumes: human confirmation that every active Pi process is idle and may be reloaded/restarted.
- Produces: a fresh Pi process loading all six extensions from `v0.1.0` while retaining messaging v2 identity/data.

- [ ] **Step 1: Stop and request the explicit human gate**

Report the transition commit ID and ask the human to confirm that active Pi work is settled. Do not run chezmoi or reload a session before an explicit response.

- [ ] **Step 2: Apply only the Pi settings and package installer**

After confirmation, preview affected paths without printing settings contents:

```bash
chezmoi status | awk '{print $2}'
```

Abort if the preview contains an unrelated target. Apply exactly the managed settings and installer source paths:

```bash
chezmoi apply --source-path \
  dot_pi/agent/settings.json.tmpl \
  run_onchange_after_06-install-pi-packages.sh.tmpl
```

Do not display rendered settings or environment.

- [ ] **Step 3: Verify the installed source without printing complete settings**

```bash
pi list | grep -F 'git:git@github.com:dvdkrv/pi-tools.git@v0.1.0'
git -C ~/.pi/agent/git/github.com/dvdkrv/pi-tools rev-parse HEAD
git -C ~/.pi/agent/git/github.com/dvdkrv/pi-tools \
  -c gpg.ssh.program=ssh-keygen \
  -c gpg.ssh.allowedSignersFile=/home/bits/.ssh/allowed_signers_personal \
  verify-tag v0.1.0
```

Expected: installed checkout equals the peeled release commit recorded in Task 1.

- [ ] **Step 4: Human-reload into the tagged package**

The human closes/reloads the current Pi process at the idle boundary and opens a fresh process. The agent must not launch or reload Pi itself.

- [ ] **Step 5: Validate lifecycle state through metadata-only operations**

The human explicitly runs `/messages join <group>` and selects/resumes the intended exact-session identity. Use `peer_message peers` only after that action to verify the current peer is online. Verify the ledger remains version 2 and broker readiness succeeds without reading bodies, changing allowance, or creating a verification participation.

- [ ] **Step 6: Record rollout evidence**

Record only the installed release commit, successful six-entrypoint load, metadata-only online presence, ledger version, and broker readiness. Do not record peer leases, tokens, settings, or bodies.

---

### Task 4: Write cleanup contracts after live validation

**Files:**
- Modify: `tests/pi-package-dependencies.test.mjs`
- Modify: `scripts/check-repository.sh`
- Modify: `.chezmoiignore`
- Modify: `.github/workflows/check.yml`

**Interfaces:**
- Consumes: successful Task 3 live validation.
- Produces: failing tests/checks that require dotfiles to have no local Pi implementation/workspaces while retaining the two pinned package sources.

- [ ] **Step 1: Add absence assertions before deleting files**

Assert all of these paths are absent:

```js
const extracted = [
  'pi-claude-bridge',
  'pi-loop-package',
  'pi-messaging',
  'pi-task',
  'pi-theme-sync',
  'pi-worktree-core',
  'pi-worktree-manager',
];
for (const path of extracted) assert.equal(existsSync(path), false, `${path} should be extracted`);
assert.equal(existsSync('tsconfig.json'), false);
```

Assert root `package.json` has no `workspaces`, Pi SDK dev dependencies, Pi overrides, or `typecheck` script. Assert workflow has no NATS download, `PI_MESSAGING_REQUIRE_BROKER`, or `messaging-minimum-runtime` job.

- [ ] **Step 2: Update repository-only checks and ignore rules**

Remove extracted directory names from `scripts/check-repository.sh`’s repository-only root loop. Remove `pi-*/` from `.chezmoiignore`; keep `docs/` ignored until Task 6 deletes it. Change the workflow contract to require only `npm ci`, `npm test`, `npm run lint:shell`, and `npm run check`.

- [ ] **Step 3: Run focused tests and confirm cleanup is still required**

Run: `node --test tests/pi-package-dependencies.test.mjs`

Expected: FAIL on existing extracted directories, root workspaces, and TypeScript tooling.

---

### Task 5: Remove extracted implementation and simplify dotfiles validation

**Files:**
- Delete: `pi-claude-bridge/`
- Delete: `pi-loop-package/`
- Delete: `pi-messaging/`
- Delete: `pi-task/`
- Delete: `pi-theme-sync/`
- Delete: `pi-worktree-core/`
- Delete: `pi-worktree-manager/`
- Delete: `tsconfig.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/check.yml`
- Modify: `tests/pi-package-dependencies.test.mjs`
- Modify: `scripts/check-repository.sh`
- Modify: `.chezmoiignore`

**Interfaces:**
- Consumes: cleanup contracts and verified remote package from Tasks 3–4.
- Produces: a configuration/provisioning-only dotfiles repository with root Node tests and shell/repository checks.

- [ ] **Step 1: Delete only tracked extracted product trees**

```bash
git rm -r pi-claude-bridge pi-loop-package pi-messaging pi-task pi-theme-sync pi-worktree-core pi-worktree-manager
git rm tsconfig.json
```

Do not delete installed `~/.pi` git packages or messaging data.

- [ ] **Step 2: Simplify root package metadata**

Remove `workspaces`, `overrides`, Pi SDK/typebox/TypeScript/jiti dev dependencies, and the `typecheck` script. Set the test script to:

```json
"test": "node --test tests/*.test.mjs"
```

Keep `lint:shell` and `check`. Regenerate the lockfile with:

```bash
npm install --package-lock-only --ignore-scripts
npm ci --ignore-scripts
```

- [ ] **Step 3: Simplify CI**

Remove NATS download steps and the entire Node 22 messaging job. Keep the Node 24 validation job with system tools, `npm ci --ignore-scripts`, `npm test`, `npm run lint:shell`, and `npm run check`.

- [ ] **Step 4: Run cleanup verification**

```bash
npm test
npm run lint:shell
npm run check
git diff --check
```

Expected: all configuration/provisioning tests pass; no test accesses the live broker or Pi package source.

- [ ] **Step 5: Confirm the installed tag remains independent of deleted sources**

```bash
pi list | grep -F 'git:git@github.com:dvdkrv/pi-tools.git@v0.1.0'
test -d ~/.pi/agent/git/github.com/dvdkrv/pi-tools
```

Expected: installed package remains available after local source deletion. Do not print full settings.

- [ ] **Step 6: Create a signed cleanup checkpoint**

```bash
git add -A
git commit -S -m 'refactor: remove extracted Pi implementation'
git verify-commit HEAD
```

Do not push until Task 6 removes design history and final checks pass.

---

### Task 6: Remove design history and obsolete lifecycle reference

**Files:**
- Delete: `docs/superpowers/`
- Delete locally after commit: `.worktrees/pi-messaging-lifecycle`
- Delete locally after commit: branch `feat/pi-messaging-lifecycle`

**Interfaces:**
- Consumes: successful cleanup checkpoint and confirmed lifecycle integration/rollout.
- Produces: no design-history files in the current tree and no obsolete lifecycle worktree/branch, while preserving Git history.

- [ ] **Step 1: Remove the current design-history tree**

```bash
git rm -r docs/superpowers
```

Do not use filter-repo, rebase, or any history-rewriting command.

- [ ] **Step 2: Verify current-tree absence and historical availability**

```bash
test ! -e docs/superpowers
git show HEAD~1:docs/superpowers/specs/2026-09-15-pi-tools-extraction-design.md >/dev/null
```

Expected: absent from the working tree but available in earlier history.

- [ ] **Step 3: Amend only the unpublished cleanup checkpoint**

```bash
git add -A
git commit --amend -S --no-edit
git verify-commit HEAD
```

Expected: cleanup remains one signed commit; no published history is rewritten.

- [ ] **Step 4: Remove the obsolete local worktree and branch**

```bash
test "$(git rev-parse feat/pi-messaging-lifecycle)" = a551ebaa049a430adc98256e201978dbda090bcd
test -z "$(git -C /home/bits/go/src/github.com/DataDog/dotfiles/.worktrees/pi-messaging-lifecycle status --short)"
git worktree remove /home/bits/go/src/github.com/DataDog/dotfiles/.worktrees/pi-messaging-lifecycle
git worktree prune
git branch -D feat/pi-messaging-lifecycle
```

Expected: the exact obsolete reference is removed after its clean-state/head guard passes. Do not delete any unrelated worktree or branch.

---

### Task 7: Final verification, review, and push

**Files:**
- No additional changes expected.

**Interfaces:**
- Consumes: signed transition and cleanup commits plus installed `v0.1.0` package.
- Produces: verified and pushed configuration-focused dotfiles `main`.

- [ ] **Step 1: Run the complete repository verification again**

```bash
npm ci --ignore-scripts
npm test
npm run lint:shell
npm run check
git diff --check origin/main..HEAD
```

Expected: all pass. Confirm `git status --short` is empty.

- [ ] **Step 2: Verify commit identity and signatures**

```bash
git log origin/main..HEAD --format='%G? %H %an <%ae> %s'
for commit in $(git rev-list origin/main..HEAD); do git verify-commit "$commit"; done
```

Expected: every new commit has status `G`, the noreply personal email, and fingerprint `YD5a…NkmARY`.

- [ ] **Step 3: Perform an inline whole-diff review**

Review `git diff origin/main..HEAD` for accidental removal of non-Pi provisioning, stale local paths, settings exposure, HTTPS Git sources, organization-specific package references, and any behavior change outside extraction. Record accepted minor issues explicitly. Do not launch subagents unless the human separately revives that option.

- [ ] **Step 4: Push over the personal SSH route**

```bash
test "$(git remote get-url origin)" = 'git@github-personal:dvdkrv/dotfiles.git'
git push origin main
git fetch origin main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
git verify-commit HEAD
```

Never use `--force`.

- [ ] **Step 5: Confirm live infrastructure remains intact**

Verify the detached Homebrew NATS 2.14.6 broker is ready, its private paths retain owner-only modes, and the installed tagged package is present. Do not join, arm, inspect bodies, change allowance, or restart the broker during this check.

- [ ] **Step 6: Report completion evidence**

Report the `pi-tools` root commit/tag, dotfiles transition and cleanup commits, test counts, Node versions, signature verification, remote parity, and cleanup results. Do not report private settings, tokens, leases, or bodies.
