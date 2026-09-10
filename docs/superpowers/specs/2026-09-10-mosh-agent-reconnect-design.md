# Mosh Agent Sidecar Reconnection Design

## Goal

Keep SSH-agent access available throughout long-running Mosh sessions when laptop sleep, network roaming, or NAT expiry breaks the ordinary TCP sidecar.

## Existing Behavior

The Mosh wrapper starts one SSH agent-forwarding sidecar, waits for it to expose the remote stable socket, and then runs Mosh. Mosh can roam between networks, but SSH cannot. If the sidecar disconnects after startup, Mosh remains usable while agent-backed Git authentication and commit signing stop working until the whole Mosh command is restarted.

## Design

The wrapper will supervise both child processes for the full Mosh lifetime. Initial sidecar readiness remains a prerequisite for starting Mosh. After Mosh starts, loss of the sidecar does not terminate Mosh; the wrapper quietly starts replacement sidecars until one becomes ready or Mosh exits.

Each SSH attempt uses:

- `ServerAliveInterval=15` to probe an otherwise idle connection;
- `ServerAliveCountMax=3` to declare it dead after three missed replies;
- `ConnectTimeout=10` to bound attempts while the network is unavailable;
- `BatchMode=yes` and no TTY, as in the initial implementation.

This detects a dead connection in roughly 45 seconds once the laptop can run again. SSH diagnostics from background retries are captured rather than written over the interactive Mosh display.

## Retry Policy

The first replacement attempt starts immediately. Failed replacement attempts use exponential delays of 1, 2, 4, 8, then 15 seconds, capped at 15 seconds. A successful replacement resets the delay to one second.

Both readiness waits and retry delays periodically check whether Mosh is still alive. They stop immediately when it exits rather than waiting for the current timeout or backoff period. Test-only environment values may shorten timeouts without changing production defaults.

## Process Lifecycle

The helper tracks one Mosh PID and at most one SSH PID. Dedicated functions start, stop, and reap the sidecar. A sidecar is considered usable only after its remote readiness marker appears and its local SSH process remains alive.

The main loop:

1. Starts and validates the initial sidecar.
2. Starts Mosh.
3. Polls Mosh and the sidecar.
4. Reaps and replaces a dead sidecar without stopping Mosh.
5. Returns Mosh's original exit status.

Existing signal and EXIT traps remain authoritative. They terminate an in-flight SSH attempt, the active sidecar, and Mosh before removing temporary readiness and diagnostic files.

## Remote Socket Behavior

Every successful replacement SSH connection updates `~/.ssh/ssh_auth_sock` through the existing atomic symlink operation before reporting readiness. The previous dead connection's socket is therefore replaced without requiring a new interactive shell or the workspace socket watcher.

Cleanup remains ownership-aware: a sidecar removes the stable link only when it still points at that sidecar's socket. An older connection cannot remove a newer connection's link.

## User Experience

The command remains unchanged:

```bash
mosh workspace-dkirov
```

Temporary sidecar failures do not close Mosh or require user action. Once the laptop wakes and SSH connectivity returns, agent-backed commands become available again automatically. Ordinary non-workspace Mosh destinations remain unaffected.

## Testing

Fake SSH processes will model a sidecar that reports readiness and later disconnects. Tests verify that:

- keepalive and connection-timeout options are present;
- Mosh remains alive after the first sidecar exits;
- another sidecar starts automatically;
- a failed replacement is retried while Mosh continues;
- the active replacement is cleaned up when Mosh exits or is interrupted;
- Mosh's exit status remains unchanged after reconnection;
- the existing startup-failure and non-workspace behavior remains intact.

All repository tests, TypeScript checks, ShellCheck, and repository validation must pass before direct fast-forward integration into `main`.
