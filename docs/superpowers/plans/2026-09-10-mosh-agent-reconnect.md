# Mosh Agent Sidecar Reconnection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically restore the SSH agent sidecar after sleep or network changes without terminating a long-running Mosh session.

**Architecture:** Refactor the existing helper into explicit sidecar start/stop/readiness functions and add a supervisor loop around the Mosh child. SSH keepalives detect dead TCP connections, while bounded exponential retries recreate the remote stable socket until Mosh exits.

**Tech Stack:** Bash, OpenSSH, Node.js built-in test runner, fake SSH/Mosh processes

## Global Constraints

- Keep `mosh workspace-*` unchanged.
- Initial sidecar failure prevents Mosh startup.
- Post-start sidecar failure never terminates Mosh.
- Retry at 1, 2, 4, 8, then at most 15 seconds.
- Detect idle dead SSH connections with a 15-second keepalive and three missed replies.
- Stop all retries and children when Mosh exits or the wrapper receives a signal.
- Preserve Mosh's exit status and non-workspace behavior.

---

### Task 1: Supervise and Reconnect the Sidecar

**Files:**
- Modify: `dot_local/bin/mosh-with-agent.sh`
- Modify: `tests/provisioning.test.mjs`

**Interfaces:**
- Consumes: the existing fake-command harness, the Mosh PID, and the SSH sidecar PID.
- Produces: automatic sidecar replacement while Mosh is alive.
- Test controls: `MOSH_AGENT_READY_TIMEOUT`, `MOSH_AGENT_RETRY_INITIAL`, `MOSH_AGENT_RETRY_MAX`, and `MOSH_AGENT_POLL_INTERVAL` override production timing defaults.

- [ ] **Step 1: Extend the fake SSH harness**

Record each SSH invocation in `FAKE_SSH_ATTEMPTS`. Add a `drop-once` mode that emits readiness on its first invocation, exits shortly afterward, and keeps subsequent invocations alive. Add a `drop-then-fail-once` mode whose second invocation fails before readiness and whose third remains alive.

Add a condition-wait helper so asynchronous tests can wait for a specific attempt count without fixed sleeps.

- [ ] **Step 2: Add failing reconnection tests**

Add tests asserting:

```javascript
assert.match(sshArgs, /(^|\n)ServerAliveInterval=15(\n|$)/);
assert.match(sshArgs, /(^|\n)ServerAliveCountMax=3(\n|$)/);
assert.match(sshArgs, /(^|\n)ConnectTimeout=10(\n|$)/);
assert.equal(attemptCount(harness), 2);
assert.equal(child.exitCode, null, 'mosh wrapper must remain alive during reconnection');
```

Test one successful replacement and one failed replacement followed by recovery. In both cases, keep fake Mosh alive while waiting for the replacement, then terminate the wrapper and verify the latest sidecar is stopped.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
node --test --test-name-pattern='mosh agent helper.*(keepalive|reconnect)' tests/provisioning.test.mjs
```

Expected: FAIL because keepalive options and reconnection supervision are absent.

- [ ] **Step 4: Refactor sidecar lifecycle**

In `dot_local/bin/mosh-with-agent.sh`, add production defaults:

```bash
RETRY_INITIAL="${MOSH_AGENT_RETRY_INITIAL:-1}"
RETRY_MAX="${MOSH_AGENT_RETRY_MAX:-15}"
POLL_INTERVAL="${MOSH_AGENT_POLL_INTERVAL:-0.2}"
```

Create functions with these responsibilities:

- `process_is_running PID`: liveness check.
- `stop_sidecar`: terminate, wait for, and clear the tracked SSH PID.
- `start_sidecar`: truncate readiness/diagnostic files, launch SSH, wait for readiness, and return nonzero after killing failed or timed-out attempts.
- `wait_for_retry SECONDS`: sleep in polling increments only while Mosh remains alive.

Launch SSH with:

```bash
"$SSH_BIN" \
  -A -T \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 \
  -- "$destination" "$remote_command"
```

Capture SSH stderr in a temporary diagnostics file. Print it only when the initial sidecar cannot start.

- [ ] **Step 5: Add the supervisor loop**

After initial readiness, start Mosh and poll both children. When SSH exits, reap it and attempt an immediate replacement. On each failed replacement, wait the current delay and double it without exceeding `RETRY_MAX`. Reset to `RETRY_INITIAL` after successful readiness.

Every readiness wait and backoff loop must stop if Mosh exits. The EXIT trap remains responsible for terminating an in-flight SSH attempt and removing both temporary files.

- [ ] **Step 6: Run focused tests and verify GREEN**

```bash
node --test --test-name-pattern='mosh agent helper' tests/provisioning.test.mjs
```

Expected: all helper tests pass, including reconnection cases.

- [ ] **Step 7: Run complete validation**

```bash
npm test
npm run typecheck
npm run lint:shell
npm run check
```

Expected: all commands exit successfully.

- [ ] **Step 8: Commit**

```bash
git add dot_local/bin/mosh-with-agent.sh tests/provisioning.test.mjs
git commit -m "fix: reconnect mosh SSH agent sidecar"
```

---

### Task 2: Integrate Directly into Main

**Files:**
- No additional file changes.

**Interfaces:**
- Consumes: a clean, signed feature branch containing current `origin/main`.
- Produces: a fast-forward update to remote `main`.

- [ ] **Step 1: Review the final diff**

Run a read-only reviewer against `origin/main..HEAD`. Resolve all Critical and Important findings.

- [ ] **Step 2: Verify and integrate**

```bash
git fetch origin main
git status --short
git diff --check origin/main...HEAD
git log --format='%h %G? %s' origin/main..HEAD
git push origin HEAD:main
```

Refuse the push if `origin/main` contains commits absent from the feature branch. Verify the remote main hash equals local HEAD afterward.
