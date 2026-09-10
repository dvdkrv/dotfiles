# Mosh SSH Agent Sidecar Design

## Goal

Preserve the normal `mosh workspace-name` command while making the local SSH agent available inside trusted Datadog workspace sessions for the lifetime of Mosh.

## Constraints

- Mosh cannot transport SSH agent protocol channels.
- Forward the agent only to destinations whose SSH alias matches `[user@]workspace-*`.
- Do not copy private keys into a workspace.
- Do not leave a persistent forwarding connection after Mosh exits.
- Preserve all original Mosh arguments and its exit status.
- Non-workspace Mosh destinations must behave exactly as they do without the wrapper.

## Architecture

A thin zsh function named `mosh` delegates to a standalone Bash helper. Keeping lifecycle and parsing logic in a script makes it testable without real network connections. The helper locates the external Mosh executable, extracts the destination from supported Mosh arguments, and chooses one of two paths:

1. Non-workspace or unparseable destination: execute Mosh directly.
2. `[user@]workspace-*`: start an SSH agent-forwarding sidecar, wait for readiness, run Mosh, and clean up the sidecar.

The zsh function is defined only when both the helper and external `mosh` command are available.

## Workspace Sidecar Lifecycle

The helper starts a background SSH session using agent forwarding, no TTY, and batch authentication. Its remote command:

1. Requires a valid forwarded `SSH_AUTH_SOCK`.
2. Creates `~/.ssh` if needed.
3. Atomically updates `~/.ssh/ssh_auth_sock` to reference the forwarded socket.
4. Emits a readiness marker.
5. Remains alive until the local wrapper terminates it.
6. On exit, removes the stable link only if it still references that sidecar's socket.

The helper waits for the readiness marker with a bounded timeout. Authentication or readiness failure stops before Mosh starts and prints an actionable error. Once ready, it runs the real Mosh process and retains responsibility for cleanup, so it does not use `exec` on the workspace path.

An EXIT/INT/TERM trap terminates and waits for the SSH sidecar, removes local temporary files, and preserves Mosh's exit status. Existing workspace socket-watcher behavior remains compatible but is not required for sidecar readiness.

## Destination Parsing

The parser recognizes Mosh's documented option forms, including flags, `-p VALUE`, long `--name=value` options, and `--` as the option terminator. The first positional argument is the destination. Matching strips an optional `user@` prefix before checking `workspace-*`.

Help, version, local mode, missing destinations, and unknown option layouts bypass sidecar setup and delegate unchanged to Mosh. This favors normal Mosh behavior over guessing a destination.

## Security

Agent forwarding grants the remote workspace access to request signatures while the sidecar is active. Restricting activation to explicit `workspace-*` aliases prevents accidental forwarding to arbitrary Mosh servers. Batch mode prevents a hidden background process from soliciting credentials.

No private key material is written to disk. The remote stable path is only a symbolic link to the ephemeral socket created by SSH.

## Testing

Repository tests use fake `mosh` and `ssh` executables to verify:

- ordinary hosts bypass SSH and preserve arguments;
- workspace and `user@workspace-*` destinations start the sidecar;
- Mosh starts only after the readiness marker;
- options and commands are passed through unchanged;
- the sidecar is terminated after success, Mosh failure, and interruption;
- sidecar startup failure prevents Mosh from running;
- shell configuration exposes the wrapper only when its dependencies exist.

The full repository tests, TypeScript checks, ShellCheck, and repository validation run before integration.
