# Overlay hooks: personal dotfiles with an optional private layer

## Goal

This repository is public and personal. It must install cleanly on any machine,
and contain no employer-specific settings. Machine- or employer-specific settings
come from an optional private layer installed separately. Its home and installer
are outside this repository.

## Overlay folder

The private layer writes files into `~/.config/dotfiles-overlay/`. Each file is
optional, and without the folder chezmoi applies the plain personal setup.

| File | Effect |
|---|---|
| `zshrc` | Sourced at the end of the zshrc template |
| `pi-settings.json` | Merged into `~/.pi/agent/settings.json` |
| `claude-settings.json` | Merged into `~/.claude/settings.json` |

### Merge rules (JSON files)

- **Lists that collect entries** are concatenated without duplicates, personal
  entries first:
  - Pi `packages`
  - Claude `permissions.allow`, `permissions.deny`, and `permissions.ask`
- **Every other key** is deep-merged, with the overlay's value winning: objects
  merge key by key, and scalars and other lists are replaced. Claude
  `enabledPlugins` and `extraKnownMarketplaces` are objects, so they merge this
  way.
- **The merged output has sorted keys.**

### Install scripts

The Pi package and Claude plugin install scripts read the merged settings.
Their `run_onchange` hashes include the overlay files, so a change in the
overlay re-runs them.

## Files owned entirely by the private layer

Files that are only meaningful with the private layer are not managed here. The
private layer installs them itself. An example is `~/.config/work/config.json`,
the work tracker config used by pi-tools.

## Managed-zshrc flag

The `work` data flag is renamed `managedZshrc`. It means "this machine's
`~/.zshrc` is managed by another system", so chezmoi deploys `~/.personal-zshrc`
there instead. A set `work` value is still read as a fallback.

## Boundary check

`npm run check` fails if a tracked file contains an employer identifier. The
check spells the identifiers in octal escapes, so that it does not contain them
itself.

## Cleanup

Removed as outdated (git history keeps them):

- `docs/plans/*` and `docs/specs/*` from before this spec: finished work.
- `dot_config/nvim/lua/disabled-plugins/{copilot,obsidian}.lua`: nothing loads them.

## Migration and verification

- Without an overlay, the rendered Pi and Claude settings contain only personal
  entries.
- On each existing machine with the private layer installed, the deployed files
  must be **semantically identical** to the deployed files before migration:
  - JSON files must be equal after parsing.
  - The zshrc may differ only by the moved lines, which now come from the
    overlay `zshrc`.
- Tests cover:
  - rendering without an overlay
  - merging each JSON file with an overlay
  - sourcing the overlay `zshrc`
  - the boundary check

## Out of scope

- Rewriting git history.
- The private layer's content, layout and installer.
