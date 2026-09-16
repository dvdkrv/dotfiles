# Dotfiles Correctness Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align dotfiles documentation, provisioning pins, stale local state, and manual health checks with the current Pi `0.84.1` installation.

**Architecture:** Keep `pi-tools v0.1.1` immutable and validate it against Pi `0.84.1` only in a disposable checkout. Add isolated shell-health tests around `doctor.sh`, then make one focused signed dotfiles implementation commit and apply provisioning changes only at a human-approved idle boundary.

**Tech Stack:** Bash, Node.js test runner, chezmoi, jq, ShellCheck, npm, Pi Coding Agent, NATS Server.

## Global Constraints

- Do not modify or release `pi-tools`; keep its configured source at signed `v0.1.1`.
- Pi Coding Agent must equal `0.84.1`.
- Node.js must be at least `22.19.0`.
- NATS Server must remain major version 2 and be at least `2.14.6`.
- Keep Superpowers pinned at `v6.2.0`.
- Personal repository contribution and push remotes remain SSH; read-only dependency pulls may use HTTPS.
- Doctor and tests must not print tokens, complete settings, leases, queued bodies, or message bodies.
- Tests must use temporary homes and isolated brokers; never mutate live messaging state.
- Preserve `.pi/`, `.claude/`, installed packages, broker data, participation, identity, and allowance.
- Delete only the ignored obsolete `pi-superpowers-package/` directory.
- Use inline execution only; do not dispatch subagents.

---

### Task 1: Validate `pi-tools v0.1.1` against Pi `0.84.1`

**Files:**
- No repository changes.

**Interfaces:**
- Consumes: signed tag `v0.1.1`, Pi host packages `0.84.1`, isolated NATS Server.
- Produces: compatibility evidence required before changing the dotfiles Pi pin.

- [ ] **Step 1: Create a disposable tagged checkout**

```bash
root="$(mktemp -d /tmp/pi-tools-0841.XXXXXX)"
git clone --quiet --branch v0.1.1 --single-branch \
  git@github-personal:dvdkrv/pi-tools.git "$root/pi-tools"
test "$(git -C "$root/pi-tools" rev-parse 'v0.1.1^{}')" = \
  8eb8311bca97c7c96a59ca9dd3066b914aaf9a8f
```

- [ ] **Step 2: Replace only disposable host development packages**

```bash
cd "$root/pi-tools"
npm pkg set \
  'devDependencies.@earendil-works/pi-ai=0.84.1' \
  'devDependencies.@earendil-works/pi-coding-agent=0.84.1' \
  'devDependencies.@earendil-works/pi-tui=0.84.1' \
  'overrides.@earendil-works/pi-ai=0.84.1' \
  'overrides.@earendil-works/pi-coding-agent=0.84.1' \
  'overrides.@earendil-works/pi-tui=0.84.1'
npm install --ignore-scripts
for package in pi-ai pi-coding-agent pi-tui; do
  test "$(node -p "require('./node_modules/@earendil-works/$package/package.json').version")" = 0.84.1
done
```

Expected: all three installed host packages report `0.84.1`; the real checkout remains untouched.

- [ ] **Step 3: Run compatibility validation without inference**

```bash
PI_MESSAGING_REQUIRE_BROKER=1 \
NATS_SERVER="$(command -v nats-server)" \
npm test
npm run typecheck
npm run test:install
npm run check
git diff --check
```

Expected: 245 tests pass with zero skips, production installation loads six entrypoints, typecheck and repository checks pass, and no paid provider is invoked.

- [ ] **Step 4: Remove the disposable checkout**

```bash
cd /home/bits/go/src/github.com/DataDog/dotfiles
rm -rf "$root"
```

---

### Task 2: Add failing correctness contracts for stale repository state

**Files:**
- Modify: `tests/pi-package-dependencies.test.mjs`
- Modify: `tests/provisioning.test.mjs`

**Interfaces:**
- Consumes: current repository files.
- Produces: failing contracts for the obsolete directory, Pi pin, and README.

- [ ] **Step 1: Extend the extracted-path assertion**

Add `'pi-superpowers-package'` to the `extracted` array in `tests/pi-package-dependencies.test.mjs`.

- [ ] **Step 2: Add README accuracy assertions**

Extend the README test with:

```js
assert.doesNotMatch(readme, /local Pi packages/i);
assert.doesNotMatch(readme, /npm run typecheck/);
assert.doesNotMatch(readme, /`pi-\*`|`docs\/superpowers\/`/);
assert.match(readme, /signed .*pi-tools.*v0\.1\.1/i);
```

- [ ] **Step 3: Update the reviewed Pi pin contract**

In `tests/provisioning.test.mjs`, change the installer assertion to:

```js
assert.match(piInstaller, /^PI_VERSION="0\.84\.1"$/m);
```

- [ ] **Step 4: Verify the contracts fail for the intended reasons**

```bash
node --test tests/pi-package-dependencies.test.mjs tests/provisioning.test.mjs
```

Expected failures: `pi-superpowers-package` exists, README contains stale claims, and Pi is pinned to `0.82.0`.

---

### Task 3: Correct stale files and pins

**Files:**
- Modify: `README.md`
- Modify: `run_onchange_after_05-install-pi.sh.tmpl`
- Delete locally: ignored `pi-superpowers-package/`

**Interfaces:**
- Consumes: failing contracts from Task 2.
- Produces: accurate documentation, Pi `0.84.1` pin, and no obsolete package residue.

- [ ] **Step 1: Update the Pi installer pin**

Change only:

```bash
PI_VERSION="0.84.1"
```

Keep the existing fail-closed npm installation command.

- [ ] **Step 2: Make README describe the current repository**

Update the introduction and layout to describe a chezmoi configuration/provisioning repository that consumes signed Pi packages. Remove `npm run typecheck`, local `pi-*` package claims, and `docs/superpowers/` layout claims. Refer to theme sync as part of signed `pi-tools`, not a local package.

- [ ] **Step 3: Guard and delete only ignored obsolete residue**

```bash
test -d pi-superpowers-package
test -z "$(git ls-files pi-superpowers-package)"
test "$(git clean -ndX -- pi-superpowers-package | wc -l)" -ge 1
git clean -fdX -- pi-superpowers-package
test ! -e pi-superpowers-package
test -d .pi
test -d .claude
```

- [ ] **Step 4: Run the focused contracts**

```bash
node --test tests/pi-package-dependencies.test.mjs tests/provisioning.test.mjs
```

Expected: all focused tests pass.

---

### Task 4: Add isolated doctor health contracts

**Files:**
- Create: `tests/doctor.test.mjs`
- Test: `doctor.sh`

**Interfaces:**
- Consumes: `doctor.sh` as a subprocess.
- Produces: `doctorHarness(overrides)` and contracts for layered failure/warning behavior.

- [ ] **Step 1: Build a temporary command and home harness**

Create `tests/doctor.test.mjs` with helpers that:

```js
function writeExecutable(path, content) {
  writeFileSync(path, content, { mode: 0o755 });
}

function doctorHarness(overrides = {}) {
  // Create root/home/bin, ~/.ssh/config, and ~/.ssh/config_chezmoi.
  // Give ~/.ssh mode 0700 and config files mode 0600.
  // Shim brew, starship, zoxide, fzf, nvim, npm, tmux, and git.
  // Shim node --version as v22.19.0.
  // Shim pi --version as 0.84.1 and pi list with the two exact package sources.
  // Shim nats-server --version as "nats-server: v2.14.6".
  // Shim chezmoi doctor as success and execute-template as stdin passthrough.
  // Keep real bash, awk, grep, jq, stat, kill, and core utilities later in PATH.
  // Return { root, home, env } with optional FAKE_* overrides.
}
```

Invoke `doctor.sh` with `spawnSync('bash', [doctorScript], { env, encoding: 'utf8' })`.

- [ ] **Step 2: Add healthy and optional-state tests**

Assert a healthy harness exits zero, reports Pi/package/version checks, warns for absent broker and theme state, and reports zero failures.

- [ ] **Step 3: Add version and package failure tests**

Use shim environment overrides and assert nonzero status for each of:

```text
Pi 0.82.0
Node 22.18.0
NATS 2.14.5
NATS 3.0.0
missing pi-tools v0.1.1
missing Superpowers v6.2.0
```

- [ ] **Step 4: Add present runtime-state tests**

Create these temporary cases:

- theme file containing `sepia`: fail;
- theme file containing `light`: pass;
- malformed `broker-process.json`: fail without echoing its contents;
- valid positive PID that is not running: warn and exit zero;
- messaging directory or lifecycle file with group/world permissions: fail.

Include a sentinel token in `config.json` and assert it never appears in stdout or stderr.

- [ ] **Step 5: Run the doctor tests and verify they fail**

```bash
node --test tests/doctor.test.mjs
```

Expected: failures because current `doctor.sh` has no version, package, runtime-state, SSH-structure, or permission policy.

---

### Task 5: Implement layered doctor checks

**Files:**
- Modify: `doctor.sh`
- Test: `tests/doctor.test.mjs`

**Interfaces:**
- Consumes: command outputs and filesystem state.
- Produces: exit zero when no hard failures; warnings do not change exit status.

- [ ] **Step 1: Add policy constants and portable helpers**

Add:

```bash
EXPECTED_PI_VERSION="0.84.1"
EXPECTED_PI_TOOLS="git:git@github.com:dvdkrv/pi-tools.git@v0.1.1"
EXPECTED_SUPERPOWERS="git:github.com/obra/superpowers@v6.2.0"
MIN_NODE_VERSION="22.19.0"
MIN_NATS_VERSION="2.14.6"
```

Implement numeric `version_at_least ACTUAL MINIMUM` using `awk -F.` so it works on macOS and Linux. Implement `mode_of PATH` with `stat -f '%Lp'` on Darwin and `stat -c '%a'` elsewhere. Never evaluate version strings as shell code.

- [ ] **Step 2: Expand required command and version checks**

Require:

```text
chezmoi brew starship zoxide fzf nvim jq node npm pi nats-server tmux git
```

Check exact Pi, minimum Node, and NATS major/minimum policy. If a command is missing, record one failure and skip checks that require it.

- [ ] **Step 3: Validate package metadata without dumping settings**

Capture `pi list` only after Pi passes command discovery. Count fixed-string matches for each expected source and require exactly one. Report only the package name and pass/fail result, not the captured output.

- [ ] **Step 4: Validate SSH structure and private modes**

Require `~/.ssh` mode `0700`, `~/.ssh/config` mode `0600`, one balanced chezmoi marker pair, and exactly one managed include line. Preserve the existing agent-socket check.

- [ ] **Step 5: Validate optional theme and messaging state**

Use `${XDG_STATE_HOME:-$HOME/.local/state}/theme`. Warn when absent; accept only `light` or `dark` when present.

For `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/messaging`, warn when absent. When present, require mode `0700`; require mode `0600` for each present lifecycle JSON/log/lock file and `0700` for present `data/`. Parse only `.pid` from `broker-process.json` with jq. Malformed metadata fails; a valid but non-running PID warns.

- [ ] **Step 6: Keep JSON rendering and final exit behavior**

Retain template rendering checks. Ensure warnings do not increment `fail`, hard errors do, and the final process exits nonzero only when `fail > 0`.

- [ ] **Step 7: Run doctor and focused repository tests**

```bash
node --test tests/doctor.test.mjs
node --test tests/pi-package-dependencies.test.mjs tests/provisioning.test.mjs
shellcheck -x doctor.sh
```

Expected: all pass.

---

### Task 6: Verify, review, commit, and push

**Files:**
- All modified files from Tasks 2–5.

**Interfaces:**
- Consumes: completed implementation.
- Produces: one signed implementation commit on dotfiles `main`.

- [ ] **Step 1: Run complete local verification**

```bash
npm ci --ignore-scripts
npm test
npm run lint:shell
npm run check
git diff --check
```

Also run ShellCheck 0.9 explicitly:

```bash
shellcheck_root="$(mktemp -d /tmp/shellcheck-0.9.0.XXXXXX)"
curl -fsSL https://github.com/koalaman/shellcheck/releases/download/v0.9.0/shellcheck-v0.9.0.linux.x86_64.tar.xz -o "$shellcheck_root/shellcheck.tar.xz"
tar -xJf "$shellcheck_root/shellcheck.tar.xz" -C "$shellcheck_root"
"$shellcheck_root/shellcheck-v0.9.0/shellcheck" -x \
  *.sh *.sh.tmpl dot_claude/hooks/*.sh dot_local/bin/*.sh scripts/*.sh
rm -rf "$shellcheck_root"
```

Expected: all checks pass and no test broker remains.

- [ ] **Step 2: Perform an inline whole-diff review**

Confirm the diff changes only the approved README, Pi pin, doctor, and tests. Search for stale local package claims. Confirm `.pi/`, `.claude/`, installed packages, and messaging data were not changed.

- [ ] **Step 3: Create the signed implementation commit**

```bash
git add README.md doctor.sh \
  run_onchange_after_05-install-pi.sh.tmpl \
  tests/doctor.test.mjs tests/pi-package-dependencies.test.mjs tests/provisioning.test.mjs
git commit -S -m 'fix: align dotfiles health checks and pins'
git verify-commit HEAD
```

- [ ] **Step 4: Push through the personal SSH route and wait for CI**

```bash
test "$(git remote get-url origin)" = 'git@github-personal:dvdkrv/dotfiles.git'
git push origin main
git fetch origin main --quiet
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
```

Wait for the exact-head GitHub Actions run and require success.

---

### Task 7: Apply at a human-controlled idle boundary

**Files:**
- Apply: `run_onchange_after_05-install-pi.sh.tmpl`

**Interfaces:**
- Consumes: pushed, CI-green commit and explicit human approval.
- Produces: installed Pi `0.84.1` and a clean doctor result.

- [ ] **Step 1: Ask for the idle-boundary gate**

Stop and obtain explicit confirmation before applying. Do not launch, close, or reload Pi automatically.

- [ ] **Step 2: Apply only changed provisioning sources**

```bash
chezmoi apply --source-path run_onchange_after_05-install-pi.sh.tmpl
```

Do not apply unrelated targets.

- [ ] **Step 3: Verify installed state without secrets**

```bash
test "$(pi --version)" = 0.84.1
pi list | grep -Fq 'git:git@github.com:dvdkrv/pi-tools.git@v0.1.1'
pi list | grep -Fq 'git:github.com/obra/superpowers@v6.2.0'
bash doctor.sh
```

Verify the live broker process and owner-only modes without reading message bodies, tokens, or leases. The human controls any subsequent Pi reload.
