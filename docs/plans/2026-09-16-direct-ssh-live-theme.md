# Direct SSH Live Theme Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Human constraints require inline execution and review; do not dispatch subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Ghostty appearance changes update tmux and running Pi TUIs live over direct SSH, while removing the legacy roaming-shell transport from future dotfiles provisioning.

**Architecture:** tmux 3.7 receives Ghostty mode 2031 reports and invokes native light/dark hooks. Both hooks call one idempotent, fail-closed helper that applies the tmux palette and atomically publishes `${XDG_STATE_HOME:-$HOME/.local/state}/theme`; the existing signed Pi extension watches that state. Attach-time environment forwarding remains a compatibility fallback, and no polling process or Pi package change is added.

**Tech Stack:** Bash, tmux 3.7 native hooks, Ghostty mode 2031 reporting, Chezmoi, Node.js built-in test runner, ShellCheck.

## Global Constraints

- Work only in the current isolated `direct-ssh-theme-sync` worktree on `feat/direct-ssh-theme-sync`.
- Use direct SSH as the supported live terminal transport.
- Ghostty is authoritative; the most recently received valid client event wins account-wide.
- Preserve `${XDG_STATE_HOME:-$HOME/.local/state}/theme` as the canonical state and replace it atomically.
- Accept only `light` and `dark`; invalid or unknown reports must not mutate state or tmux.
- Keep `LC_TERMINAL_THEME` only as an attach-time fallback and retain `prefix+T` as manual recovery.
- Require tmux 3.7 or newer for native live theme hooks.
- Do not add polling, a daemon, terminal-response parsing, a second Pi extension, model work, or conversation messages.
- Do not change the signed `pi-tools` package or Pi settings.
- Remove the legacy roaming-shell transport from current tracked source and future provisioning without rewriting Git history.
- Do not add an uninstall or target-file cleanup migration; already-installed unmanaged artifacts may remain.
- All commits use `David Kirov <31777857+dvdkrv@users.noreply.github.com>` and trusted SSH signing.
- Do not push, apply Chezmoi state, reload tmux or Pi, or alter live broker/session state without a later explicit human decision.

---

## File Map

- `dot_local/bin/executable_toggle-theme.sh`: sole writer of canonical theme state and tmux palette.
- `dot_local/bin/executable_sync-terminal-theme.sh`: validated attach-time environment fallback only.
- `dot_tmux.conf`: native Ghostty/tmux theme hooks, manual binding, clipboard and core tmux configuration.
- `doctor.sh`: required tmux version check and read-only optional client-theme diagnostic.
- `dot_Brewfile`: future Homebrew package provisioning.
- `.chezmoitemplates/zshrc`: shell startup integration; legacy wrapper removal.
- `README.md`: direct-SSH setup and live verification.
- `scripts/check-repository.sh`: rendered configuration checks and a tracked-source regression guard.
- `tests/provisioning.test.mjs`: theme helper, isolated tmux hook, package, shell, and Chezmoi behavior.
- `tests/doctor.test.mjs`: version and optional client-theme diagnostics.
- `docs/plans/2026-09-15-dotfiles-correctness-refresh.md`: remove obsolete dependency examples while retaining the historical plan.
- Delete the managed legacy connection helper whose basename is constructed by `printf '\155\157\163\150'` followed by `-with-agent.sh`; stop future management without adding a cleanup script.

---

### Task 1: Make theme publication idempotent and fail closed

**Files:**
- Modify: `tests/provisioning.test.mjs`
- Modify: `dot_local/bin/executable_toggle-theme.sh`

**Interfaces:**
- Consumes: optional CLI argument `light` or `dark`; no argument means manual toggle.
- Produces: exit status `0` after a complete palette application and atomic state publication; nonzero with no state publication for invalid input or tmux failure.
- Produces: canonical file `${XDG_STATE_HOME:-$HOME/.local/state}/theme` containing exactly `light\n` or `dark\n`.

- [ ] **Step 1: Extend the fake tmux harness with deterministic failure injection**

In `themeScriptHarness`, replace the fake tmux body with:

```bash
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TMUX_LOG"
if [[ "$1" == "show-environment" ]]; then
  printf 'LC_TERMINAL_THEME=%s\n' "$TMUX_THEME"
fi
if [[ -n "${TMUX_FAIL_MATCH:-}" && "$*" == *"$TMUX_FAIL_MATCH"* ]]; then
  exit 71
fi
```

Add `TMUX_FAIL_MATCH: ''` to the returned environment.

- [ ] **Step 2: Write failing tests for same-value reapplication, invalid arguments, and failed palette publication**

Add these tests beside the existing toggle test:

```js
test('explicit theme reapplies the complete palette when canonical state already matches', () => {
  const harness = themeScriptHarness('light');
  writeFileSync(harness.stateFile, 'light\n');
  const result = spawnSync('/bin/bash', [toggleThemeScript, 'light'], {
    env: harness.env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const commands = readFileSync(harness.tmuxLog, 'utf8');
  for (const option of ['status-style', 'status-left', 'status-right', 'window-status-format', 'window-status-current-format', 'pane-border-style', 'pane-active-border-style']) {
    assert.match(commands, new RegExp(`set -g ${option}`));
  }
  assert.match(commands, /set-environment -g LC_TERMINAL_THEME light/);
  assert.equal(readFileSync(harness.stateFile, 'utf8'), 'light\n');
});

test('invalid explicit theme changes neither canonical state nor tmux', () => {
  const harness = themeScriptHarness('dark');
  writeFileSync(harness.stateFile, 'dark\n');
  const result = spawnSync('/bin/bash', [toggleThemeScript, 'sepia'], {
    env: harness.env,
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(harness.stateFile, 'utf8'), 'dark\n');
  assert.equal(existsSync(harness.tmuxLog), false);
});

test('failed tmux palette does not publish a new canonical theme', () => {
  const harness = themeScriptHarness('dark');
  writeFileSync(harness.stateFile, 'dark\n');
  const result = spawnSync('/bin/bash', [toggleThemeScript, 'light'], {
    env: { ...harness.env, TMUX_FAIL_MATCH: 'status-right' },
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(harness.stateFile, 'utf8'), 'dark\n');
  assert.deepEqual(readdirSync(harness.stateHome).sort(), ['theme']);
});
```

Import `readdirSync` from `node:fs` and return `stateHome` from `themeScriptHarness`.

- [ ] **Step 3: Run the focused tests and verify the failures describe current behavior**

Run:

```bash
node --test --test-name-pattern='explicit theme reapplies|invalid explicit theme|failed tmux palette' tests/provisioning.test.mjs
```

Expected: all three tests fail because the current helper exits early on same-value input, treats `sepia` as a toggle, and publishes state before tmux commands complete.

- [ ] **Step 4: Implement strict parsing and publish state only after palette success**

Rewrite `dot_local/bin/executable_toggle-theme.sh` around this control flow while retaining the existing exact palette values:

```bash
#!/usr/bin/env bash
set -euo pipefail

STATE="${XDG_STATE_HOME:-$HOME/.local/state}/theme"
mkdir -p "$(dirname "$STATE")"
current="$(cat "$STATE" 2>/dev/null || printf '%s\n' dark)"
[[ "$current" == light || "$current" == dark ]] || current=dark

case "$#" in
  0) [[ "$current" == dark ]] && next=light || next=dark ;;
  1)
    [[ "$1" == light || "$1" == dark ]] || {
      printf 'theme must be light or dark\n' >&2
      exit 2
    }
    next="$1"
    ;;
  *)
    printf 'usage: %s [light|dark]\n' "${0##*/}" >&2
    exit 2
    ;;
esac

temporary="$(mktemp "${STATE}.tmp.XXXXXX")"
trap 'rm -f -- "$temporary"' EXIT
printf '%s\n' "$next" >"$temporary"

if [[ "$next" == dark ]]; then
  tmux set -g status-style 'bg=#1e1e2e,fg=#cdd6f4'
  tmux set -g status-left '#[bg=#a6e3a1,fg=#1e1e2e,bold] #S #[bg=#1e1e2e] '
  tmux set -g status-right '#[fg=#89b4fa]%H:%M #[fg=#cdd6f4]| #[fg=#f9e2af]%Y-%m-%d '
  tmux set -g window-status-format '#[fg=#7f849c] #I:#W '
  tmux set -g window-status-current-format '#[bg=#313244,fg=#a6e3a1,bold] #I:#W '
  tmux set -g pane-border-style 'fg=#1e1e2e'
  tmux set -g pane-active-border-style 'fg=#a6e3a1'
else
  tmux set -g status-style 'bg=#eff1f5,fg=#4c4f69'
  tmux set -g status-left '#[bg=#40a02b,fg=#eff1f5,bold] #S #[bg=#eff1f5] '
  tmux set -g status-right '#[fg=#1e66f5]%H:%M #[fg=#4c4f69]| #[fg=#df8e1d]%Y-%m-%d '
  tmux set -g window-status-format '#[fg=#acb0be] #I:#W '
  tmux set -g window-status-current-format '#[bg=#ccd0da,fg=#40a02b,bold] #I:#W '
  tmux set -g pane-border-style 'fg=#acb0be'
  tmux set -g pane-active-border-style 'fg=#40a02b'
fi

tmux set-environment -g LC_TERMINAL_THEME "$next"
mv -f -- "$temporary" "$STATE"
trap - EXIT
tmux display-message "Theme: $next" || true
```

Do not keep the old same-value early return.

- [ ] **Step 5: Run focused and complete provisioning tests**

Run:

```bash
node --test --test-name-pattern='theme|terminal theme' tests/provisioning.test.mjs
node --test tests/provisioning.test.mjs
```

Expected: PASS with no leaked temporary state files.

- [ ] **Step 6: Run ShellCheck for the helper**

Run:

```bash
shellcheck -x dot_local/bin/executable_toggle-theme.sh
```

Expected: no findings.

- [ ] **Step 7: Commit the tested helper change**

```bash
git add dot_local/bin/executable_toggle-theme.sh tests/provisioning.test.mjs
git commit -S -m "fix: publish terminal themes atomically"
```

---

### Task 2: Wire Ghostty reports to native tmux hooks

**Files:**
- Modify: `dot_tmux.conf`
- Modify: `tests/provisioning.test.mjs`

**Interfaces:**
- Consumes: tmux native hooks `client-light-theme` and `client-dark-theme`.
- Consumes: `~/.local/bin/toggle-theme.sh light|dark` from Task 1.
- Produces: account-wide last-event-wins palette and canonical state changes.

- [ ] **Step 1: Add an isolated tmux hook harness to the provisioning tests**

Add a helper that creates a temporary `HOME`, installs the tested theme helpers there, and starts a private tmux server:

```js
function tmuxThemeHarness() {
  const root = mkdtempSync(join(tmpdir(), 'dotfiles-tmux-theme-'));
  const home = join(root, 'home');
  const stateHome = join(root, 'state');
  const localBin = join(home, '.local', 'bin');
  const socket = `dotfiles-theme-${process.pid}-${Date.now()}-${Math.random()}`;
  mkdirSync(localBin, { recursive: true });
  mkdirSync(stateHome, { recursive: true });
  writeExecutable(join(localBin, 'toggle-theme.sh'), repositoryFile('dot_local/bin/executable_toggle-theme.sh'));
  writeExecutable(join(localBin, 'sync-terminal-theme.sh'), repositoryFile('dot_local/bin/executable_sync-terminal-theme.sh'));
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: stateHome };
  const run = (...args) => spawnSync('tmux', ['-L', socket, ...args], { env, encoding: 'utf8' });
  return { root, home, stateHome, stateFile: join(stateHome, 'theme'), socket, run };
}
```

Each test must kill its private server in `finally` with `harness.run('kill-server')` and remove the temporary root.

- [ ] **Step 2: Write a failing integration test for both native hooks**

Add:

```js
test('tmux native client theme hooks publish light and dark canonical state', () => {
  const harness = tmuxThemeHarness();
  try {
    let result = harness.run('-f', '/dev/null', 'new-session', '-d', '-s', 'theme');
    assert.equal(result.status, 0, result.stderr);
    result = harness.run('source-file', new URL('../dot_tmux.conf', import.meta.url).pathname);
    assert.equal(result.status, 0, result.stderr);

    result = harness.run('set-hook', '-gR', 'client-light-theme');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(harness.stateFile, 'utf8'), 'light\n');
    assert.match(harness.run('show-options', '-gv', 'status-style').stdout, /#eff1f5/);
    assert.match(harness.run('show-options', '-gv', 'pane-border-style').stdout, /#acb0be/);

    result = harness.run('set-hook', '-gR', 'client-dark-theme');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(harness.stateFile, 'utf8'), 'dark\n');
    assert.match(harness.run('show-options', '-gv', 'status-style').stdout, /#1e1e2e/);
  } finally {
    harness.run('kill-server');
    rmSync(harness.root, { recursive: true, force: true });
  }
});
```

Import `rmSync` if it is not already imported.

- [ ] **Step 3: Run the hook test and verify it fails because hooks are empty**

Run:

```bash
node --test --test-name-pattern='tmux native client theme hooks' tests/provisioning.test.mjs
```

Expected: FAIL because running the empty native hook creates no canonical state.

- [ ] **Step 4: Register explicit native hooks in `dot_tmux.conf`**

Add directly above the existing attach hook:

```tmux
# Ghostty and tmux 3.7 use mode 2031 to report live appearance changes.
# The latest valid client report becomes the account-wide tmux and Pi theme.
set-hook -g client-light-theme 'run-shell "~/.local/bin/toggle-theme.sh light"'
set-hook -g client-dark-theme 'run-shell "~/.local/bin/toggle-theme.sh dark"'

# Compatibility fallback for clients that only forward an attach-time value.
set-hook -g client-attached 'run-shell "~/.local/bin/sync-terminal-theme.sh"'
```

Replace the old attach-hook comment rather than creating a duplicate `client-attached` hook.

- [ ] **Step 5: Run the focused and full provisioning tests**

Run:

```bash
node --test --test-name-pattern='tmux native client theme hooks|client attachment|toggle-theme' tests/provisioning.test.mjs
node --test tests/provisioning.test.mjs
```

Expected: PASS. The isolated server ends with dark canonical state after the second hook.

- [ ] **Step 6: Validate tmux configuration syntax and shell scripts**

Run:

```bash
tmux -L dotfiles-plan-check -f /dev/null start-server \; source-file dot_tmux.conf \; show-hooks -g \; kill-server
npm run lint:shell
```

Expected: tmux lists both native hooks and the attach hook; ShellCheck reports no findings.

- [ ] **Step 7: Commit native hook integration**

```bash
git add dot_tmux.conf tests/provisioning.test.mjs
git commit -S -m "feat: follow Ghostty theme events in tmux"
```

---

### Task 3: Remove the legacy transport from future provisioning

**Files:**
- Delete: the managed legacy helper resolved by `legacy_helper="dot_local/bin/$(printf '\155\157\163\150')-with-agent.sh"`.
- Modify: `dot_Brewfile`
- Modify: `.chezmoitemplates/zshrc`
- Modify: `dot_tmux.conf`
- Modify: `doctor.sh`
- Modify: `tests/provisioning.test.mjs`
- Modify: `tests/doctor.test.mjs`
- Modify: `docs/plans/2026-09-15-dotfiles-correctness-refresh.md`

**Interfaces:**
- Produces: no future package install, managed helper, shell wrapper, health requirement, transport-only tmux override, or test fixture.
- Preserves: existing installed artifacts because no uninstall or cleanup migration is created.

- [ ] **Step 1: Replace positive provisioning expectations with a failing absence test**

Before deleting implementation, replace the package test with:

```js
test('future provisioning omits the retired roaming-shell transport', () => {
  const removed = ['mo', 'sh'].join('');
  const packages = repositoryFile('dot_Brewfile');
  const zsh = repositoryFile('.chezmoitemplates/zshrc');
  assert.doesNotMatch(packages, new RegExp(`^brew "${removed}"$`, 'm'));
  assert.doesNotMatch(zsh, new RegExp(removed, 'i'));
  assert.equal(existsSync(new URL(`../dot_local/bin/${removed}-with-agent.sh`, import.meta.url)), false);
});
```

This expresses the future-provisioning contract without reintroducing the retired name as a contiguous tracked string.

- [ ] **Step 2: Run the absence test and verify it fails on all three current surfaces**

Run:

```bash
node --test --test-name-pattern='future provisioning omits' tests/provisioning.test.mjs
```

Expected: FAIL because the formula, wrapper, and managed helper still exist.

- [ ] **Step 3: Remove the managed implementation and package entry**

Perform only source-state deletion:

```bash
legacy_helper="dot_local/bin/$(printf '\155\157\163\150')-with-agent.sh"
rm "$legacy_helper"
```

Delete the corresponding formula line from `dot_Brewfile`. Do not add `brew uninstall`, `brew bundle cleanup`, a Chezmoi removal attribute, or an always-run deletion script.

- [ ] **Step 4: Remove the shell wrapper and transport-only tmux override**

Delete the guarded wrapper block from `.chezmoitemplates/zshrc`.

Delete only this transport-specific terminal override from `dot_tmux.conf`:

```tmux
set -as terminal-overrides ',xterm-256color:Ms=...'
```

Retain `set -g set-clipboard on`, copy-mode bindings, and `copy-to-clipboard.sh`.

- [ ] **Step 5: Remove retired helper harnesses and behavior tests**

From `tests/provisioning.test.mjs`, delete:

- the retired helper URL constant;
- its fake-client harness and runner;
- helper-only wait/count utilities if no remaining test uses them;
- every helper lifecycle/retry/exit-status test;
- the old zsh-wrapper positive test; and
- the transport-specific OSC 52 override test.

Keep generic SSH management, clipboard, theme, package, and Chezmoi tests.

- [ ] **Step 6: Remove the command from doctor and its fixture**

Delete the retired command from the `doctor.sh` required command loop and from the fake-command list in `tests/doctor.test.mjs`. Do not weaken any other required dependency.

- [ ] **Step 7: Remove obsolete mentions from the retained correctness plan**

In `docs/plans/2026-09-15-dotfiles-correctness-refresh.md`, remove the retired command from the two example command lists. Do not rewrite Git history or remove unrelated plan content.

- [ ] **Step 8: Run focused provisioning and doctor tests**

Run:

```bash
node --test tests/provisioning.test.mjs tests/doctor.test.mjs
```

Expected: both test files pass. README cleanup and the final zero-reference boundary follow in Task 5.

- [ ] **Step 9: Run ShellCheck**

Run:

```bash
npm run lint:shell
```

Expected: no findings, including no stale reference to the deleted helper.

- [ ] **Step 10: Commit the future-provisioning cleanup**

```bash
git add -A
git commit -S -m "refactor: retire roaming shell provisioning"
```

---

### Task 4: Add tmux version and client-theme diagnostics

**Files:**
- Modify: `doctor.sh`
- Modify: `tests/doctor.test.mjs`

**Interfaces:**
- Consumes: `tmux -V` output such as `tmux 3.7c`.
- Consumes: optional `tmux list-clients -F '#{client_theme}'` output.
- Produces: required failure below tmux 3.7; warning for attached clients with unknown theme; no mutation and no failure when no tmux server is running.

- [ ] **Step 1: Make the doctor harness model tmux version and client reports**

Remove `tmux` from the generic fake-command loop and add:

```js
writeExecutable(join(bin, 'tmux'), `#!/usr/bin/env bash
case "\${1:-}" in
  -V)
    printf 'tmux %s\n' "\${FAKE_TMUX_VERSION:-3.7c}"
    ;;
  list-clients)
    case "\${FAKE_TMUX_CLIENTS:-no-server}" in
      no-server) exit 1 ;;
      unknown) printf 'unknown\n' ;;
      mixed) printf 'dark\nunknown\n' ;;
      light) printf 'light\n' ;;
      dark) printf 'dark\n' ;;
    esac
    ;;
  *) exit 0 ;;
esac
`);
```

Add `FAKE_TMUX_VERSION: '3.7c'` and `FAKE_TMUX_CLIENTS: 'no-server'` to the default environment.

- [ ] **Step 2: Write failing tests for the version floor and unknown client warning**

Add:

```js
test('doctor rejects tmux older than 3.7', () => {
  const result = runDoctor({ overrides: { FAKE_TMUX_VERSION: '3.6a' } });
  assert.notEqual(result.status, 0, outputOf(result));
  assert.match(outputOf(result), /tmux.*3\.7/i);
});

test('doctor warns when an attached tmux client has not reported a theme', () => {
  const result = runDoctor({ overrides: { FAKE_TMUX_CLIENTS: 'mixed' } });
  assert.equal(result.status, 0, outputOf(result));
  assert.match(outputOf(result), /tmux.*client.*theme.*unknown/i);
});

test('doctor accepts a reported tmux client theme', () => {
  const result = runDoctor({ overrides: { FAKE_TMUX_CLIENTS: 'dark' } });
  assert.equal(result.status, 0, outputOf(result));
  assert.match(outputOf(result), /tmux.*client.*theme.*dark/i);
  assert.doesNotMatch(outputOf(result), /theme.*unknown/i);
});
```

- [ ] **Step 3: Run the new doctor tests and verify they fail for missing diagnostics**

Run:

```bash
node --test --test-name-pattern='tmux older|tmux client' tests/doctor.test.mjs
```

Expected: FAIL because doctor neither parses tmux versions nor inspects optional client-theme metadata.

- [ ] **Step 4: Implement the required tmux version check**

Add `MIN_TMUX_VERSION="3.7"` beside other reviewed versions. In the reviewed-versions section:

```bash
if command -v tmux >/dev/null 2>&1; then
    tmux_output="$(tmux -V 2>/dev/null || true)"
    tmux_version="$(sed -nE 's/^tmux ([0-9]+\.[0-9]+).*/\1/p' <<<"$tmux_output")"
    if [[ "$tmux_version" =~ ^[0-9]+\.[0-9]+$ ]] && version_at_least "$tmux_version" "$MIN_TMUX_VERSION"; then
        ok "tmux $tmux_version satisfies minimum $MIN_TMUX_VERSION"
    else
        bad "tmux must be at least $MIN_TMUX_VERSION (found ${tmux_output:-unknown})"
    fi
fi
```

- [ ] **Step 5: Implement read-only optional client-theme reporting**

After canonical theme validation, add:

```bash
if command -v tmux >/dev/null 2>&1; then
    if tmux_client_themes="$(tmux list-clients -F '#{?client_theme,#{client_theme},unknown}' 2>/dev/null)"; then
        if grep -qx 'unknown' <<<"$tmux_client_themes"; then
            warn "at least one attached tmux client theme is unknown; direct SSH live reporting has not been observed"
        else
            themes="$(sort -u <<<"$tmux_client_themes" | paste -sd, -)"
            ok "tmux client theme reporting is active ($themes)"
        fi
        unset tmux_client_themes themes
    fi
fi
```

Do not query terminal devices, send escape sequences, print client TTYs, or fail merely because no tmux server exists.

- [ ] **Step 6: Run doctor tests and ShellCheck**

Run:

```bash
node --test tests/doctor.test.mjs
shellcheck -x doctor.sh
```

Expected: all doctor tests pass and ShellCheck reports no findings.

- [ ] **Step 7: Commit diagnostics**

```bash
git add doctor.sh tests/doctor.test.mjs
git commit -S -m "feat: diagnose native tmux theme reporting"
```

---

### Task 5: Document direct SSH and enforce the repository boundary

**Files:**
- Modify: `README.md`
- Modify: `scripts/check-repository.sh`
- Modify: `tests/provisioning.test.mjs`

**Interfaces:**
- Produces: exact human validation flow for Ghostty, direct SSH, tmux, canonical state, and Pi.
- Produces: repository check that rejects any future tracked reference to the retired transport.

- [ ] **Step 1: Write a failing repository-boundary test through the real check script**

The Task 3 scan already establishes the current tree can become clean. Add this executable guard near the beginning of `scripts/check-repository.sh`, after `cd "$repo"`:

```bash
removed_transport="$(printf '\155\157\163\150')"
if git grep -in -- "$removed_transport"; then
  echo "Removed terminal transport remains in tracked source" >&2
  exit 1
fi
unset removed_transport
```

Before removing the final README references, run:

```bash
bash scripts/check-repository.sh
```

Expected: FAIL and list only remaining documentation references. If Task 3 already removed every reference, temporarily add a lowercase occurrence to a disposable tracked fixture, confirm the guard fails, then revert that fixture before continuing. Do not commit the deliberate failure.

- [ ] **Step 2: Replace terminal-theme verification with direct-SSH native reporting**

Rewrite the README theme section to instruct:

```bash
tmux display-message -p '#{client_theme}'
cat "${XDG_STATE_HOME:-$HOME/.local/state}/theme"
tmux show-options -gv status-style
```

State that:

- the connection must be direct SSH from Ghostty;
- `#{client_theme}` must be exactly `light` or `dark`;
- changing host appearance should update all three outputs without reconnecting or reattaching;
- a running Pi TUI should change within roughly 200 ms without `/reload`; and
- `prefix+T` is manual recovery, not the normal synchronization path.

Keep the existing Neovim verification but clarify that a newly started Neovim inherits the current environment.

- [ ] **Step 3: Replace obsolete clipboard instructions with transport-neutral direct-SSH verification**

Keep OSC 52 validation focused on tmux and Ghostty:

```bash
printf 'direct ssh clipboard test' | tmux load-buffer -w -
```

State that local paste should produce the text and that Neovim and copy-mode use the same tmux clipboard path. Do not mention or restore the removed transport-specific selector override.

- [ ] **Step 4: Add a focused documentation/provisioning assertion**

Add to `tests/provisioning.test.mjs`:

```js
test('README documents native direct-SSH theme verification', () => {
  const readme = repositoryFile('README.md');
  assert.match(readme, /direct SSH/i);
  assert.match(readme, /#\{client_theme\}/);
  assert.match(readme, /client-light-theme|client-dark-theme/);
  assert.match(readme, /200 ms/i);
});
```

- [ ] **Step 5: Run focused tests and the repository check**

Run:

```bash
node --test --test-name-pattern='README documents native' tests/provisioning.test.mjs
npm run check
```

Expected: PASS; the repository scanner reports no tracked retired-transport references, Chezmoi boundaries remain valid, and headless Neovim checks pass.

- [ ] **Step 6: Run ShellCheck**

Run:

```bash
npm run lint:shell
```

Expected: no findings in the new repository guard.

- [ ] **Step 7: Commit documentation and boundary enforcement**

```bash
git add README.md scripts/check-repository.sh tests/provisioning.test.mjs
git commit -S -m "docs: adopt direct SSH terminal integration"
```

---

### Task 6: Complete verification and inline review

**Files:**
- Review all files changed since `69a3c390def133d02f790ec48ff6afde3846817a`.
- No new implementation file is expected unless verification identifies a concrete defect.

**Interfaces:**
- Produces: clean, signed, locally verified feature branch ready for explicit integration choice.

- [ ] **Step 1: Run the complete test suite**

```bash
npm test
```

Expected: all tests pass with zero failures, skips, cancellations, or todos.

- [ ] **Step 2: Run all shell and repository checks**

```bash
npm run lint:shell
npm run check
git diff --check 014b1088cf8e52c2c89545f6e1c5406311a929de...HEAD
```

Expected: all commands exit zero.

- [ ] **Step 3: Validate a disposable Chezmoi target without touching `$HOME`**

```bash
root="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-direct-ssh.XXXXXX")"
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/home"
: >"$root/chezmoi.toml"
toggle_target="$root/home/.local/bin/toggle-theme.sh"
sync_target="$root/home/.local/bin/sync-terminal-theme.sh"
mkdir -p "$(dirname "$toggle_target")"
chezmoi --config "$root/chezmoi.toml" \
  --source "$PWD" \
  --destination "$root/home" \
  --persistent-state "$root/chezmoi.boltdb" \
  apply --force "$toggle_target" "$sync_target"

test -x "$toggle_target"
test -x "$sync_target"
test ! -e "$root/home/.local/bin/$(printf '\155\157\163\150')-with-agent.sh"
```

Expected: disposable apply succeeds and installs only current theme helpers.

- [ ] **Step 4: Confirm zero tracked retired-transport references and no personal data**

```bash
removed_transport="$(printf '\155\157\163\150')"
test -z "$(git grep -in -- "$removed_transport" || true)"
npm run check
```

Expected: no retired references; only intentional generic test fixtures from the privacy scan.

- [ ] **Step 5: Review the behavioral diff against the approved spec**

```bash
git diff --stat 014b1088cf8e52c2c89545f6e1c5406311a929de...HEAD
git diff 014b1088cf8e52c2c89545f6e1c5406311a929de...HEAD -- \
  dot_tmux.conf \
  dot_local/bin/executable_toggle-theme.sh \
  dot_local/bin/executable_sync-terminal-theme.sh \
  doctor.sh \
  README.md \
  scripts/check-repository.sh
```

Review explicitly for:

- native hook values are not reversed;
- state is published only after successful palette application;
- same-value events repair tmux idempotently;
- invalid input cannot toggle accidentally;
- attach fallback cannot override a later native event;
- doctor is read-only and optional client absence is non-fatal;
- no uninstall or cleanup migration exists;
- no Pi or live messaging configuration changed; and
- tests use isolated state, tmux sockets, and Chezmoi destinations.

- [ ] **Step 6: Verify every feature commit signature and repository cleanliness**

```bash
git log --show-signature --format='%H %G? %s' 014b1088cf8e52c2c89545f6e1c5406311a929de..HEAD
git status --short --branch
```

Expected: every commit shows a good signature from `SHA256:YD5aofj7Ho7upNN2q7RI2R5mPJPQGKpO+91P4NkmARY`; the worktree is clean.

- [ ] **Step 7: Stop for explicit integration and rollout decisions**

Do not merge, push, apply Chezmoi state, source the live tmux configuration, reconnect sessions, or reload Pi automatically. Present the verified branch and request the next human decision.
