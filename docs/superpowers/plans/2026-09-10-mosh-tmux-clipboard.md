# Mosh and tmux Clipboard Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Neovim and tmux copy-mode selections reach the local clipboard through Mosh.

**Architecture:** Ensure trusted workspace connections launch the Homebrew Mosh 1.4 server before remote shell initialization, while respecting explicit server commands. At the tmux-to-Mosh boundary, override the `Ms` capability for Mosh's `xterm-256color` terminal so an empty clipboard selector becomes the `c` selector required by Mosh.

**Tech Stack:** Bash, tmux terminfo capabilities, OSC 52, Mosh 1.4, Node.js test runner, Chezmoi

## Global Constraints

- Apply the Mosh server default only to `workspace-*` destinations.
- Preserve caller-provided `--server COMMAND` and `--server=COMMAND` options.
- Preserve ordinary non-workspace Mosh arguments unchanged.
- Scope the OSC 52 override to `xterm-256color` so direct local Ghostty sessions are unchanged.
- Keep Neovim mappings and clipboard configuration unchanged.

---

### Task 1: Select the Homebrew Mosh server for workspaces

**Files:**
- Modify: `tests/provisioning.test.mjs:213-230`
- Modify: `dot_local/bin/mosh-with-agent.sh:4-9,228-232`

**Interfaces:**
- Consumes: original Mosh arguments and an optional caller-provided `--server` option.
- Produces: `mosh_args`, an array passed to `MOSH_BIN`, with a default `--server=PATH=... mosh-server` prepended only when needed.

- [ ] **Step 1: Update the workspace test to require the default remote server command**

In `mosh agent helper forwards workspace agents and stops its sidecar`, keep `args` as the caller input and assert that the fake Mosh receives:

```javascript
const remoteServer = '--server=PATH=/home/linuxbrew/.linuxbrew/bin:/opt/homebrew/bin:/usr/local/bin:$PATH mosh-server';
assert.deepEqual(
  readFileSync(harness.moshArgs, 'utf8').trim().split('\n'),
  [remoteServer, ...args],
);
```

- [ ] **Step 2: Add a test for an explicit server override**

Add:

```javascript
test('mosh agent helper preserves an explicit workspace server command', () => {
  const harness = moshAgentHarness();
  const args = ['--server', '/custom/mosh-server', 'workspace-dkirov'];

  const result = runMoshAgent(harness, args);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(harness.moshArgs, 'utf8').trim().split('\n'), args);
});
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
node --test --test-name-pattern='mosh agent helper.*(forwards workspace|explicit workspace server)' tests/provisioning.test.mjs
```

Expected: the workspace default test fails because no server argument is added; the explicit-server behavior already passes.

- [ ] **Step 4: Implement the default remote server selection**

Near the production defaults in `dot_local/bin/mosh-with-agent.sh`, add:

```bash
REMOTE_MOSH_SERVER='PATH=/home/linuxbrew/.linuxbrew/bin:/opt/homebrew/bin:/usr/local/bin:$PATH mosh-server'
```

After the workspace destination and credential validation but before starting the sidecar, build the final Mosh arguments:

```bash
mosh_args=("$@")
has_server_override=0
for argument in "$@"; do
  case "$argument" in
    --server | --server=*)
      has_server_override=1
      break
      ;;
  esac
done
if ((has_server_override == 0)); then
  mosh_args=("--server=$REMOTE_MOSH_SERVER" "${mosh_args[@]}")
fi
```

Change the Mosh launch to:

```bash
"$MOSH_BIN" "${mosh_args[@]}" &
```

- [ ] **Step 5: Run focused tests and shell lint to verify GREEN**

Run:

```bash
node --test --test-name-pattern='mosh agent helper' tests/provisioning.test.mjs
shellcheck -x dot_local/bin/mosh-with-agent.sh
```

Expected: all Mosh helper tests pass and shellcheck exits 0.

- [ ] **Step 6: Commit the Mosh server fix**

```bash
git add dot_local/bin/mosh-with-agent.sh tests/provisioning.test.mjs
git commit -m "fix: select modern Mosh server for workspaces"
```

---

### Task 2: Emit the OSC 52 selector Mosh accepts

**Files:**
- Modify: `tests/provisioning.test.mjs:363-374`
- Modify: `dot_tmux.conf:40-44`

**Interfaces:**
- Consumes: tmux `Ms` parameters `%p1` (clipboard selector) and `%p2` (base64 payload).
- Produces: an OSC 52 sequence that preserves non-empty selectors and substitutes `c` for an empty selector.

- [ ] **Step 1: Add a test for the effective tmux capability**

Add this test after the portable tmux integration test:

```javascript
test('tmux loads a Mosh-compatible OSC 52 clipboard capability', () => {
  const socket = `dotfiles-osc52-${process.pid}-${Date.now()}`;
  const tmuxConfig = new URL('../dot_tmux.conf', import.meta.url).pathname;
  const result = spawnSync('tmux', [
    '-L', socket,
    '-f', '/dev/null',
    'start-server', ';',
    'source-file', tmuxConfig, ';',
    'show-options', '-sv', 'terminal-overrides', ';',
    'kill-server',
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /xterm-256color:Ms=.*52;.*%p1.*%ec.*%p2/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test --test-name-pattern='Mosh-compatible OSC 52' tests/provisioning.test.mjs
```

Expected: FAIL because `terminal-overrides` does not contain the Mosh-compatible `Ms` entry.

- [ ] **Step 3: Add the scoped tmux capability override**

After `set -g set-clipboard on` in `dot_tmux.conf`, add:

```tmux
# Mosh 1.4 accepts OSC 52 only with selector "c"; tmux leaves it empty for load-buffer -w.
set -as terminal-overrides ',xterm-256color:Ms=\E]52;%?%p1%l%t%p1%s%ec%;;%p2%s\007'
```

- [ ] **Step 4: Run the focused test and parse the configuration**

Run:

```bash
node --test --test-name-pattern='Mosh-compatible OSC 52' tests/provisioning.test.mjs
tmux -L dotfiles-clipboard-check -f /dev/null start-server \; source-file "$PWD/dot_tmux.conf" \; show-options -sv terminal-overrides \; kill-server
```

Expected: the test passes and the effective option includes the `xterm-256color:Ms=` override.

- [ ] **Step 5: Capture the resulting sequence in an isolated pseudo-terminal**

Run:

```bash
tmp="$(mktemp -d)"
printf 'OSC52_OVERRIDE_PROBE' > "$tmp/payload"
cat > "$tmp/run.sh" <<EOF
#!/usr/bin/env bash
sleep 0.3
tmux -L osc52-override load-buffer -w '$tmp/payload'
sleep 0.3
EOF
chmod +x "$tmp/run.sh"
TERM=xterm-256color script -qec \
  "tmux -L osc52-override -f '$PWD/dot_tmux.conf' new-session '$tmp/run.sh'" \
  "$tmp/typescript" >/dev/null 2>&1 || true
python3 - "$tmp/typescript" <<'PY'
import re
import sys

output = open(sys.argv[1], 'rb').read()
sequences = [
    match.group(0)
    for match in re.finditer(rb'\x1b\]52;.*?\x07', output)
]
expected = b'\x1b]52;c;T1NDNTJfT1ZFUlJJREVfUFJPQkU=\x07'
assert sequences == [expected], sequences
print(repr(sequences[0]))
PY
rm -rf "$tmp"
```

Expected:

```text
b'\x1b]52;c;T1NDNTJfT1ZFUlJJREVfUFJPQkU=\x07'
```

- [ ] **Step 6: Commit the tmux compatibility fix**

```bash
git add dot_tmux.conf tests/provisioning.test.mjs
git commit -m "fix: emit Mosh-compatible clipboard sequences"
```

---

### Task 3: Document and verify deployment

**Files:**
- Modify: `README.md:57-75`
- Create: `docs/superpowers/plans/2026-09-10-mosh-tmux-clipboard.md`

**Interfaces:**
- Consumes: updated dotfiles applied on the local and remote machines.
- Produces: deployment and live-session verification instructions.

- [ ] **Step 1: Add clipboard verification instructions**

After the terminal-theme verification section in `README.md`, add:

````markdown
### Verify clipboard forwarding over Mosh

Apply the updated dotfiles on both the local and remote machines. End the existing Mosh connection, reconnect normally, attach tmux, and reload its configuration:

```bash
tmux source-file ~/.tmux.conf
tmux show-options -g set-clipboard
```

Verify the active remote server is the Homebrew Mosh 1.4 binary:

```bash
pid="$(pgrep -n mosh-server)"
readlink "/proc/$pid/exe"
```

Test the transport from inside tmux:

```bash
printf 'mosh clipboard test' | tmux load-buffer -w -
```

Pasting locally should produce `mosh clipboard test`. Neovim `<leader>y` and tmux copy-mode `y`/Enter use the same OSC 52 path.
````

- [ ] **Step 2: Run all repository validation**

Run:

```bash
npm test
npm run typecheck
npm run lint:shell
npm run check
```

Expected: all commands exit 0; broker-dependent tests may remain skipped when `nats-server` is unavailable.

- [ ] **Step 3: Review scope and whitespace**

Run:

```bash
git diff --check
git status --short
git diff origin/main...HEAD --stat
```

Expected: no whitespace errors and only the design, plan, Mosh wrapper, tmux config, focused tests, and README are changed.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md docs/superpowers/plans/2026-09-10-mosh-tmux-clipboard.md
git commit -m "docs: explain Mosh clipboard verification"
```
