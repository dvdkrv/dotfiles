# Direct SSH Live Theme Synchronization Design

**Date:** 2026-09-16  
**Status:** Approved design, pending implementation plan

## Purpose

Make an already-attached Ghostty → direct SSH → tmux → Pi session follow the host terminal's light or dark appearance without reconnecting, reattaching, polling, or pressing a manual toggle.

At the same time, remove the legacy roaming-shell transport from future dotfiles provisioning and documentation. This is a forward-looking source cleanup only: applying the change must not actively uninstall an existing formula or delete an already-installed helper.

## Current failure

The current configuration forwards `LC_TERMINAL_THEME` when a connection is established and copies it into an account-wide state file from a tmux client-attachment hook. Process environments do not change after connection establishment, so later host appearance changes never reach the remote machine.

The tmux palette and the Pi extension already follow `~/.local/state/theme`. Their shared input remains `light`, so neither consumer has a new event to apply. The missing boundary is live terminal-to-tmux appearance reporting.

## Requirements

- Ghostty is the appearance authority.
- An existing direct SSH connection updates live.
- tmux and every running Pi TUI converge on the same account-wide `light` or `dark` state.
- When attached clients disagree, the most recently received valid theme event wins.
- The canonical state remains `${XDG_STATE_HOME:-$HOME/.local/state}/theme`.
- State replacement remains atomic.
- Unknown or invalid theme reports never replace a valid state.
- No polling loop, client daemon, terminal-response parser, Pi restart, or model work is introduced.
- `prefix+T` remains an explicit manual recovery control.
- The existing `LC_TERMINAL_THEME` flow remains only as an attach-time compatibility fallback.
- Future provisioning, health checks, shell integration, tests, and current documentation contain no legacy roaming-shell dependency.
- Applying the source cleanup does not actively uninstall or delete an existing local installation.

## Non-goals

- Supporting live theme propagation through terminal transports that do not carry terminal query and notification sequences.
- Changing Pi's built-in `light` and `dark` themes.
- Adding a second Pi extension or changing the signed `pi-tools` package.
- Synchronizing Neovim instances that were started before the environment changed. New processes continue to inherit the current environment; Pi uses the canonical state watcher.
- Automatically cleaning unmanaged legacy binaries or helper files from existing machines.

## Architecture

### Native terminal event path

Ghostty supports DEC private mode 2031 color-scheme reporting. tmux 3.7 subscribes to those notifications when a client starts and exposes two native hooks:

- `client-light-theme`
- `client-dark-theme`

The tmux configuration registers both hooks. Each hook invokes the existing theme helper with an explicit validated value. The helper:

1. accepts only `light` or `dark` when called explicitly;
2. prepares the selected value in a temporary file beside the canonical state;
3. applies the complete corresponding tmux palette, even when the file already contains that value;
4. only after every palette command succeeds, atomically renames the temporary file over the canonical state; and
5. leaves no temporary file after success or failure.

The event order at the tmux server defines precedence. Therefore the latest valid client event becomes the account-wide theme.

### Pi propagation

The installed Pi theme extension already watches the canonical state file with a 200 ms polling watcher and applies Pi's built-in theme through the stable UI API. Atomic file replacement is compatible with that watcher. No Pi settings, package, prompt, tool, or process lifecycle changes are required.

Theme changes remain presentation-only. They do not append conversation messages, invoke a model, reload extensions, or alter messaging state.

### Attach-time fallback

The existing client-attachment helper remains, but it is explicitly secondary:

1. a native tmux client theme event is authoritative whenever available;
2. a valid `LC_TERMINAL_THEME` may initialize the canonical state at attachment time for older clients;
3. an absent or invalid fallback value is ignored; and
4. a later native event always replaces the fallback.

The shell export and SSH `SendEnv` entry may remain because they support compatibility and new-process initialization. They are no longer described as the live synchronization mechanism.

### Manual recovery

`prefix+T` continues to toggle the canonical theme explicitly. Explicit application is idempotent: it rewrites canonical state atomically and reapplies the tmux palette even if the requested value matches the current file. A later native Ghostty event may replace this manual override, consistent with Ghostty being authoritative.

## tmux version and diagnostics

Native theme hooks require tmux 3.7 or newer.

The doctor command remains read-only and layered:

- a missing or older tmux remains a required dependency failure under the repository's existing dependency policy;
- when a tmux server is available, clients with an empty `#{client_theme}` produce a warning explaining that native live reporting has not been observed;
- the absence of a running tmux server remains non-fatal; and
- diagnostics do not send terminal queries, modify tmux options, or write the canonical state.

The README documents `tmux display-message -p '#{client_theme}'` as the direct-SSH validation command.

## Future-provisioning cleanup

The repository removes the legacy transport from all current tracked surfaces:

- package provisioning;
- the managed connection helper source;
- the zsh wrapper;
- doctor requirements;
- provisioning and doctor fixtures;
- tmux compatibility overrides that existed only for that transport;
- README setup and clipboard instructions; and
- obsolete references in retained planning documents.

A repository check prevents the removed dependency from returning to tracked source. Git history is not rewritten.

No cleanup migration is added. Removing a formula from the Brewfile does not uninstall an already-installed formula, and deleting a source-state helper does not actively delete a previously installed unmanaged target file.

## Failure behavior

- Invalid helper arguments fail before changing state or tmux.
- A failed atomic state replacement preserves the previous canonical file.
- If a tmux palette command fails, the helper reports failure and does not publish a new canonical state. Because tmux option changes are not transactional, a partial palette is possible; idempotent reapplication repairs it without a special recovery path.
- Missing theme support leaves the last valid canonical state in place and keeps manual recovery available.
- Multiple clients are intentionally last-event-wins rather than merged or session-scoped.

## Testing

### Script tests

Use a fake tmux executable and isolated state directory to verify:

- explicit light and dark values atomically update canonical state;
- the full matching palette is applied every time, including same-value reapplication;
- invalid values make no state or tmux changes; and
- manual toggle behavior remains deterministic.

### tmux integration tests

Start an isolated tmux server using the managed configuration and verify:

- both native theme hooks are registered with the expected explicit values;
- the attach fallback remains registered;
- running the light and dark hooks updates isolated canonical state and palette; and
- the configuration loads on the supported tmux version without warnings.

The tests exercise hook behavior rather than asserting only on configuration text.

### Repository and provisioning tests

Verify:

- the package bundle no longer provisions the removed dependency;
- rendered shell configuration defines no legacy wrapper;
- doctor no longer requires the removed command;
- the managed helper is absent from the source state;
- direct-SSH theme verification replaces obsolete documentation; and
- current tracked source contains no removed transport references.

Existing Pi theme watcher tests continue to prove startup ordering, atomic replacement observation, one-change delivery, cleanup, and warning behavior.

## Rollout

1. Merge and push signed dotfiles changes only after the complete repository suite passes.
2. Run an explicit human-controlled `chezmoi apply`.
3. Reload tmux configuration or start a new tmux server.
4. End the old terminal transport and connect through direct SSH from Ghostty.
5. Attach tmux and verify `#{client_theme}`, the canonical state, the tmux palette, and live Pi changes.
6. Do not reload Pi merely for a theme transition; already-loaded watchers must observe the state change.

Applying this design does not change the live messaging broker, install a new Pi package, or alter active messaging participation.
