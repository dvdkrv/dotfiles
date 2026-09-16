# Dotfiles correctness refresh

## Goal

Bring the configuration-focused dotfiles repository and its manual health check into agreement with the current installed stack. This is a narrow correctness pass, not a provisioning redesign.

## Scope

- Keep the published `pi-tools v0.1.1` package unchanged.
- Validate `pi-tools v0.1.1` against Pi `0.84.1` in a disposable checkout.
- Update the dotfiles Pi installer pin from `0.82.0` to `0.84.1`.
- Correct stale README claims about local Pi packages, removed design history, and the removed TypeScript command.
- Delete the ignored local `pi-superpowers-package/` residue without touching `.pi/`, `.claude/`, installed Pi packages, or messaging data.
- Add a regression assertion that the obsolete package directory is absent.
- Extend `doctor.sh` with layered checks for the current stack.

Root npm wrappers, CI structure, the SSH `run_after` lifecycle, read-only dependency transport, Pi package behavior, and messaging state are out of scope. Personal repository contribution and push remotes remain SSH; anonymous dependency pulls may remain HTTPS.

## Version policy

- Pi Coding Agent must equal `0.84.1`.
- Configured package sources must contain exactly `pi-tools v0.1.1` and Superpowers `v6.2.0`.
- Node.js must be at least `22.19.0`.
- NATS Server must remain major version 2 and be at least `2.14.6`.

Tests must keep the duplicated doctor expectations aligned with the installer and settings templates.

## Doctor behavior

Required installed commands, version policy, exact package sources, rendered JSON, SSH marker structure, and required private modes are failures when invalid.

Messaging runtime state and terminal theme state are optional until initialized:

- an absent messaging directory, broker record, or theme state produces a warning;
- present but malformed broker metadata or a theme value other than `light` or `dark` fails;
- a well-formed broker record whose process is not running warns;
- present messaging directories and lifecycle files must retain owner-only modes.

The doctor must not print broker tokens, complete settings, leases, queued bodies, or message bodies. It must not connect to the broker, create participation, change allowance, or invoke a model.

## Testing

Doctor tests use a temporary home and command shims. They cover passing versions and package pins, version drift, missing optional runtime state, malformed present state, SSH structure and modes, stale-path absence, and README accuracy. Tests never inspect the live messaging installation.

Compatibility validation uses a disposable `pi-tools v0.1.1` checkout with Pi host development packages replaced by `0.84.1`, the pinned isolated NATS test broker, and no paid inference. It runs the package tests, typecheck, production-install test, and repository check without committing package changes.

The dotfiles gate remains the complete Node test suite, ShellCheck 0.9 and the installed ShellCheck, repository checks, diff checks, signed commit verification, and remote CI.

## Rollout

Apply only changed managed files after validation. If the Pi installer reconciles the global version, the human controls the idle boundary and any Pi reload. The rollout must preserve the live broker, ledger, participation identity, allowance, and installed package data.
