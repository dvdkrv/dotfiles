# Mosh SSH Agent Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve `mosh workspace-*` while automatically forwarding the local SSH agent through a temporary SSH sidecar for the Mosh session lifetime.

**Architecture:** A Bash helper parses the Mosh destination, bypasses non-workspace targets, and owns the SSH sidecar lifecycle for trusted workspace aliases. A thin zsh function transparently routes the existing `mosh` command through that helper.

**Tech Stack:** Bash, zsh, Chezmoi, Node.js built-in test runner, fake command executables

## Global Constraints

- Activate agent forwarding only for destinations matching `[user@]workspace-*`.
- Never copy or persist private key material.
- Preserve Mosh arguments and exit status.
- Stop the sidecar whenever Mosh exits or the wrapper is interrupted.
- Delegate non-workspace and unparseable invocations directly to external Mosh.
- Use batch-mode SSH so background authentication cannot prompt invisibly.

---

### Task 1: Implement and Test the Agent Sidecar Helper

**Files:**
- Create: `dot_local/bin/mosh-with-agent.sh`
- Modify: `tests/provisioning.test.mjs`

**Interfaces:**
- Consumes: original Mosh CLI arguments, external `mosh` and `ssh` commands, local `SSH_AUTH_SOCK`.
- Produces: identical Mosh behavior plus an ephemeral forwarded socket at `~/.ssh/ssh_auth_sock` for trusted workspace aliases.
- Test controls: `MOSH_AGENT_MOSH_BIN`, `MOSH_AGENT_SSH_BIN`, and `MOSH_AGENT_READY_TIMEOUT` environment variables select fake executables and a short readiness timeout.

- [ ] **Step 1: Add failing helper behavior tests**

Add test utilities that create executable fake `mosh` and `ssh` programs in a temporary directory and execute `dot_local/bin/mosh-with-agent.sh` with controlled environment variables.

Add tests with these assertions:

```javascript
assert.deepEqual(readFileSync(moshArgs, 'utf8').trim().split('\n'), expectedArgs);
assert.equal(existsSync(sshArgs), false, 'ordinary hosts must not start a sidecar');
assert.match(readFileSync(sshArgs, 'utf8'), /(^|\n)-A(\n|$)/);
assert.match(readFileSync(sshArgs, 'utf8'), /(^|\n)-T(\n|$)/);
assert.match(readFileSync(sshArgs, 'utf8'), /(^|\n)user@workspace-dkirov(\n|$)/);
assert.equal(readFileSync(sidecarStopped, 'utf8').trim(), 'stopped');
assert.equal(existsSync(moshArgs), false, 'mosh must not run before sidecar readiness');
```

Cover these cases:

1. `example.com -- tmux` bypasses SSH and preserves arguments.
2. `-p 60001 user@workspace-dkirov -- tmux` starts a sidecar, preserves arguments, and stops the sidecar after Mosh exits.
3. A fake Mosh exit status of 23 is returned after sidecar cleanup.
4. SSH exit before readiness prevents Mosh from running and returns nonzero.
5. SIGTERM sent to the wrapper stops the sidecar and exits nonzero.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test --test-name-pattern='mosh agent helper' tests/provisioning.test.mjs
```

Expected: FAIL because `dot_local/bin/mosh-with-agent.sh` does not exist.

- [ ] **Step 3: Implement the helper**

Create executable `dot_local/bin/mosh-with-agent.sh` with:

```bash
#!/usr/bin/env bash
set -uo pipefail

MOSH_BIN="${MOSH_AGENT_MOSH_BIN:-$(command -v mosh || true)}"
SSH_BIN="${MOSH_AGENT_SSH_BIN:-$(command -v ssh || true)}"
READY_TIMEOUT="${MOSH_AGENT_READY_TIMEOUT:-10}"
READY_MARKER="__MOSH_AGENT_READY__"
```

Implement a parser for documented Mosh flags, options with values, long `--name=value` forms, and `--`. Select the first positional destination. Immediately `exec "$MOSH_BIN" "$@"` when the destination is absent, cannot be parsed safely, uses `--local`, or does not match `[user@]workspace-*`.

For workspace aliases, require executable Mosh and SSH commands plus a usable local agent socket. Create a readiness file with `mktemp`, start:

```bash
"$SSH_BIN" -A -T -o BatchMode=yes -- "$destination" "$remote_command" >"$ready_file" &
sidecar_pid=$!
```

The remote command must atomically link `~/.ssh/ssh_auth_sock` to its forwarded `SSH_AUTH_SOCK`, print `__MOSH_AGENT_READY__`, wait indefinitely, and remove the link on exit only when it still points to that connection's socket.

Poll for the marker until `READY_TIMEOUT`; fail if SSH exits or the timeout expires. Install EXIT/INT/TERM/HUP cleanup traps that terminate and wait for the sidecar and delete the local readiness file. Run Mosh without `exec`, capture its status, and return that status after cleanup.

Mark the file executable:

```bash
chmod 755 dot_local/bin/mosh-with-agent.sh
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
node --test --test-name-pattern='mosh agent helper' tests/provisioning.test.mjs
```

Expected: all helper tests pass.

- [ ] **Step 5: Run ShellCheck**

Run:

```bash
shellcheck -x dot_local/bin/mosh-with-agent.sh
```

Expected: exit status 0 with no diagnostics.

- [ ] **Step 6: Commit the helper**

```bash
git add dot_local/bin/mosh-with-agent.sh tests/provisioning.test.mjs
git commit -m "feat: add mosh SSH agent sidecar"
```

---

### Task 2: Preserve the Existing Mosh Command

**Files:**
- Modify: `.chezmoitemplates/zshrc`
- Modify: `tests/provisioning.test.mjs`

**Interfaces:**
- Consumes: external `mosh` command and executable `~/.local/bin/mosh-with-agent.sh`.
- Produces: a zsh `mosh()` function that passes every argument to the helper.

- [ ] **Step 1: Add a failing shell-integration assertion**

Add a provisioning test asserting that `.chezmoitemplates/zshrc` contains a guarded function equivalent to:

```zsh
if whence -p mosh >/dev/null 2>&1 && [[ -x "$HOME/.local/bin/mosh-with-agent.sh" ]]; then
  mosh() {
    "$HOME/.local/bin/mosh-with-agent.sh" "$@"
  }
fi
```

The test must also confirm the function passes `"$@"` without flattening arguments.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test --test-name-pattern='zsh routes mosh' tests/provisioning.test.mjs
```

Expected: FAIL because no wrapper function exists.

- [ ] **Step 3: Add the guarded zsh function**

Append the exact guarded function above near the existing command integrations in `.chezmoitemplates/zshrc`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test --test-name-pattern='zsh routes mosh' tests/provisioning.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Run all validation**

```bash
npm test
npm run typecheck
npm run lint:shell
npm run check
```

Expected: all commands exit successfully.

- [ ] **Step 6: Commit the shell integration**

```bash
git add .chezmoitemplates/zshrc tests/provisioning.test.mjs
git commit -m "feat: route workspace mosh through agent sidecar"
```

---

### Task 3: Integrate

**Files:**
- No additional file changes.

**Interfaces:**
- Consumes: verified commits on `feat/mosh-agent-sidecar` based on `origin/main`.
- Produces: a pushed feature branch or direct `main` update according to the user's integration choice.

- [ ] **Step 1: Verify the final tree and commit signatures**

```bash
git status --short
git diff --check origin/main...HEAD
git log --format='%h %G? %s' origin/main..HEAD
```

Expected: clean status, no whitespace errors, and `G` for every commit signature.

- [ ] **Step 2: Fetch and refuse non-fast-forward integration**

```bash
git fetch origin main
test "$(git rev-list --left-right --count origin/main...HEAD | awk '{print $1}')" -eq 0
```

Expected: the feature contains the current remote main without rewriting history.

- [ ] **Step 3: Push the selected integration target**

Push only after applying the branch-finishing workflow and honoring the user's selected integration option.
