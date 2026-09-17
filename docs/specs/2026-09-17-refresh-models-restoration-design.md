# Conditional refresh-models Restoration Design

**Date:** 2026-09-17
**Status:** Proposed

## Problem

The `/refresh-models` command comes from the private local Pi package at
`~/dd/datadog-pi-packages/packages/refresh-models`. It was previously added
manually to `~/.pi/agent/settings.json`, but the Chezmoi-managed source template
did not contain it. A later `chezmoi apply` correctly replaced the target file
with the managed version and unintentionally removed that manual package entry.

The existing Chezmoi `work` value cannot safely control this package. It means
"Ansible manages `~/.zshrc` on this machine," is currently false on this host,
and changing it would also alter shell deployment.

## Goals

- Restore `/refresh-models` on machines that have the private package checkout.
- Make the configuration survive future Chezmoi applications.
- Keep non-work and unprepared machines free of private, nonexistent paths.
- Preserve the signed, immutable Git-only behavior of the Pi package installer.
- Keep package checkout, updates, active-session reloads, and command execution
  human-controlled.

## Non-goals

- Clone or update `datadog-pi-packages` automatically.
- Install development dependencies for the private package.
- Move private Datadog code into the public `pi-tools` package.
- Change the existing Chezmoi `work` value or zsh deployment behavior.
- Automatically apply Chezmoi or reload a running Pi process.
- Replace Pi's built-in `pi update --models` behavior.

## Design

### Capability detection

The settings template will derive the absolute checkout path from
`.chezmoi.homeDir`:

```text
<home>/dd/datadog-pi-packages/packages/refresh-models
```

Chezmoi's `stat` template function returns a false value when that path is
absent. The package entry will therefore be emitted only when the checkout
exists. Checkout presence is a narrower and more accurate capability signal
than the unrelated `work` value.

### Managed Pi settings

When the checkout exists, `dot_pi/agent/settings.json.tmpl` will add this Pi
package source exactly once:

```text
../../dd/datadog-pi-packages/packages/refresh-models
```

The relative source is resolved by Pi against `~/.pi/agent/settings.json`, so it
remains independent of the account's absolute home path. The two existing
signed package entries and the automatic `light/dark` theme setting remain
unchanged.

When the checkout is absent, the rendered JSON will contain only the existing
signed packages. Both branches must produce valid JSON.

### Provisioning boundary

`run_onchange_after_06-install-pi-packages.sh.tmpl` will remain unchanged. It
will continue reconciling only these immutable Git sources:

- `pi-tools v0.1.1`
- Superpowers `v6.2.0`

The private local package is loaded directly from the path declared in managed
settings. Dotfiles will not run `pi install` for it because that command would
mutate the managed target file and recreate configuration drift. Dotfiles also
will not clone, pull, build, or otherwise mutate the private checkout.

### Runtime behavior

A Chezmoi application updates the settings file but does not change an active
Pi process. After an explicit human-controlled apply, an already-running Pi TUI
requires one explicit `/reload`; new Pi processes load the package normally.
The package then registers `/refresh-models` through its existing extension
entrypoint.

If the checkout is later removed, a subsequent Chezmoi application omits the
package entry. No cleanup process deletes the checkout or changes a running Pi
session.

## Failure behavior

- Missing checkout: omit the entry silently so Pi startup remains healthy.
- Existing checkout with a broken package: Pi reports its normal package load
  error; dotfiles does not mask or repair private-package failures.
- Invalid rendered settings: repository tests fail before merge.
- Package checkout moved elsewhere: the entry is omitted until the checkout is
  restored at the documented path or this design is deliberately revised.

## Testing

Repository tests will render the settings template in two isolated home
layouts:

1. checkout present: rendered JSON includes the private relative source exactly
   once alongside both signed packages;
2. checkout absent: rendered JSON omits the private source and remains valid.

Tests will also retain the invariant that the provisioning script installs only
signed Git packages and contains no private local package path. The full test
suite, ShellCheck, repository checks, and a disposable Chezmoi render/apply of
the settings target will run before integration.

## Rollout

1. Merge and push only after explicit approval.
2. Apply only the managed Pi settings after separate explicit approval.
3. Verify `pi list` shows the private package without exposing private package
   contents.
4. Reload active Pi sessions only at a human-selected idle boundary.
5. Verify `/refresh-models version` or command completion after reload; do not
   execute a model refresh automatically.
