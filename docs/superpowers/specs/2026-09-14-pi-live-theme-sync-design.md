# Pi live terminal theme synchronization design

Date: 2026-09-14
Status: Approved for implementation planning

## Problem

Pi is configured with the built-in automatic theme pair, `"light/dark"`, but terminal appearance detection is unreliable through the current SSH/Mosh and tmux path. The Pi processes have `LC_TERMINAL_THEME=light` but no `COLORFGBG`. Pi does not consult `LC_TERMINAL_THEME`; when its color-scheme and OSC 11 queries do not produce a result, it falls back to the dark theme.

This creates a mixed, low-contrast interface: Pi's dark palette supplies bright foregrounds and explicit dark message backgrounds while the terminal itself retains a light default background. The existing automatic setting also cannot guarantee live changes through a multiplexer that does not forward terminal color-scheme notifications.

The shell and tmux setup already have a separate appearance contract. `LC_TERMINAL_THEME` carries `light` or `dark` from the client, `sync-terminal-theme.sh` reacts on tmux client attachment, and `toggle-theme.sh` changes tmux styling. The intended shared state path is `${XDG_STATE_HOME:-$HOME/.local/state}/theme`, although the current scripts do not guarantee that the file exists.

## Selected behavior

Make the existing theme state file the canonical live appearance signal for tmux and Pi. A small local Pi package will provide an extension that reads and watches this file. Every running interactive Pi session will apply the built-in `light` or `dark` theme when the shared state changes.

Both manual `prefix+T` changes and client-attachment synchronization will update the same state, so tmux and all running Pi sessions converge on one appearance. This deliberately preserves the current account-wide tmux semantics: when differently themed clients are attached concurrently, the most recent synchronized or manual change wins globally.

## Components and data flow

### Canonical theme state

`toggle-theme.sh` remains the only writer for manual and attachment-driven changes. It will validate the requested value and always ensure the state file contains exactly `light` or `dark`, including when the requested appearance matches the implicit default and the file does not yet exist. The write will replace the state atomically so readers never observe partial content.

`sync-terminal-theme.sh` will continue reading tmux's imported `LC_TERMINAL_THEME`. For a valid value, it will delegate to `toggle-theme.sh` even when that value appears unchanged, allowing the toggle helper to establish or repair canonical state. Missing or invalid client values remain no-ops.

The flow is:

1. SSH/Mosh supplies `LC_TERMINAL_THEME`, or the user presses `prefix+T`.
2. The existing shell helper chooses `light` or `dark`, updates tmux styling, and atomically writes the canonical state file.
3. Each running Pi extension instance observes the state change.
4. Each interactive Pi TUI applies the corresponding built-in theme and rerenders.

### Pi theme-sync package

Add a focused local package, `pi-theme-sync`, following the repository's existing Pi package layout. It will contain the extension, independently testable state-resolution and watching logic, a package manifest, and package-local tests. Add it to the root workspace, managed Pi package list, and local package installation flow.

On `session_start` in TUI mode, the extension will:

1. Resolve the state path using `XDG_STATE_HOME` when set, otherwise `$HOME/.local/state`.
2. Read a valid value from the state file.
3. If the file is absent or invalid, fall back to a valid process `LC_TERMINAL_THEME`; if neither is valid, use `dark`.
4. Load Pi's built-in theme with `ctx.ui.getTheme(name)` and apply the returned `Theme` object with `ctx.ui.setTheme(theme)`.
5. Start a low-latency file watch that also handles file creation and atomic replacement.

The extension must apply a `Theme` object rather than call `setTheme("light")` or `setTheme("dark")`. Pi persists string theme selections to `settings.json`, which would destroy the managed `"light/dark"` setting. Applying the loaded object changes only the current process, disables its unreliable terminal notification synchronization, and leaves managed settings unchanged.

The watcher will ignore missing, empty, and invalid transient values. It will remember the last applied valid appearance and rerender only when that value changes. A valid file value always takes precedence over the startup environment because process environment cannot change after launch.

On `session_shutdown`, the extension will stop its watcher. Startup and shutdown must be idempotent so reload and session replacement cannot leave duplicate watchers behind.

### Existing automatic setting

Keep `"theme": "light/dark"` in managed Pi settings. It remains a safe default before extensions bind, on modes where the live extension does not run, and if the package fails to load. The extension becomes authoritative only for a running interactive TUI.

## Error handling

- Missing state at startup falls back to `LC_TERMINAL_THEME`, then dark.
- Invalid state never changes an already-running Pi theme.
- Failure to load a named built-in theme leaves the current theme unchanged and emits one concise TUI warning rather than repeatedly notifying on every watch event.
- Watch errors do not crash Pi. The implementation uses a watch mechanism that tolerates a missing file and atomic replacement.
- Non-TUI modes do not start background watchers or attempt theme changes.

## Rollout

Package and settings changes will be managed through chezmoi using the repository's existing installation flow. After installation, each already-running Pi process requires one human-controlled `/reload` to load the new extension. From that point forward, appearance changes propagate live without further reloads or process restarts.

The rollout must not kill Pi processes, alter session histories, or reload active sessions automatically.

## Testing

Add automated coverage for:

- state-file precedence over `LC_TERMINAL_THEME`;
- valid environment fallback and dark final fallback;
- rejection of invalid, empty, or missing state;
- initial theme application by `Theme` object rather than a persisted string name;
- live light-to-dark and dark-to-light updates;
- suppression of duplicate applications;
- watcher cleanup and idempotent session lifecycle handling;
- no watcher or theme mutation outside TUI mode;
- canonical state creation and repair by the shell helpers;
- package declaration in the root workspace, managed settings, dependency checks, and local installer.

Use temporary directories and injected watcher/UI seams so tests do not mutate the real theme state, tmux server, Pi settings, or running sessions. Run the focused package and shell tests, aggregate Node tests, TypeScript checking, ShellCheck, repository checks, and whitespace checks.

## Non-goals

- Per-client themes for multiple clients attached to one tmux server.
- Custom Pi color palettes.
- Polling or signaling Pi processes from shell scripts.
- Depending on OSC passthrough or terminal color-scheme notification support.
- Changing Pi upstream's terminal detection implementation.
- Automatically reloading or restarting existing Pi sessions during installation.
