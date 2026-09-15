# Pi Tools Extraction Design

## Status and scope

This design extracts every locally maintained Pi extension and its implementation from dotfiles into the public `dvdkrv/pi-tools` repository. The new repository starts from one clean snapshot rather than copied Git history, exposes one installable Pi package, and remains organization-neutral. Dotfiles returns to configuration and machine provisioning.

The messaging lifecycle forward-port is already integrated, its v2 ledger migration is complete, and detached NATS autostart has been verified against retained data. Extraction must preserve that behavior and must not perform another messaging migration.

## Goals

- Publish one coherent Pi package containing the six current extension entrypoints and their shared implementation.
- Preserve existing behavior, safety properties, public APIs, and compatibility coverage.
- Make the public repository understandable without dotfiles context or organization-specific assumptions.
- Consume releases from dotfiles through signed immutable tags over SSH.
- Attribute and sign future work in both repositories as the `dvdkrv` GitHub account.
- Remove local Pi implementation and `docs/superpowers/` from the current dotfiles tree without rewriting history.

## Non-goals

- Rewriting existing dotfiles commits or importing their history into `pi-tools`.
- Redesigning extension behavior during extraction.
- Bundling the third-party `obra/superpowers` package.
- Moving NATS installation or other machine provisioning out of dotfiles.
- Copying broker credentials, ledger data, message bodies, Pi sessions, installed settings, or other private state.
- Publishing generated bundles or an npm release in the initial version.

## Repository and identity

The repository is `dvdkrv/pi-tools`, checked out at `~/personal/pi-tools`. Git transport is SSH only. Contribution uses an isolated `github-personal` SSH host route backed by the forwarded personal key and a distinct control socket, so it cannot reuse a work-account connection.

Both `pi-tools` and the existing dotfiles checkout use repository-local Git configuration for future commits:

- author: `David Kirov <31777857+dvdkrv@users.noreply.github.com>`;
- authentication: the personal SSH key registered to `dvdkrv`;
- signing: the same GitHub-registered SSH signing key;
- signed commits and signed annotated tags are mandatory.

Existing history is not rewritten.

## Package architecture

`pi-tools` is one package with one dependency graph, lockfile, TypeScript configuration, test runner, and Pi manifest:

```text
pi-tools/
├── extensions/
│   ├── claude-skill.ts
│   ├── loop.ts
│   ├── messaging.ts
│   ├── task.ts
│   ├── theme-sync.ts
│   └── worktree-manager.ts
├── src/
│   ├── messaging/
│   ├── theme/
│   └── worktree/
├── tests/
│   ├── claude-bridge/
│   ├── loop/
│   ├── messaging/
│   ├── task/
│   ├── theme/
│   └── worktree/
├── package.json
├── package-lock.json
├── tsconfig.json
├── README.md
└── LICENSE
```

The root `package.json` explicitly lists all six extension entrypoints in `pi.extensions`. Pi host packages remain `peerDependencies` with `"*"` ranges, while NATS and other non-host runtime libraries remain normal `dependencies`. Development-only test tooling remains in `devDependencies`.

The current worktree-core code becomes an internal shared module used by the Claude bridge, task, and worktree-manager extensions. It is not a seventh extension. Messaging keeps a stable exported public subpath so programmatic consumers are not forced to import internals.

The external `git:github.com/obra/superpowers@v6.2.0` package remains separate and pinned.

## Behavior-preserving import

The first snapshot copies only tracked product source, tests, and useful user documentation. Imports and fixtures are updated for the consolidated directory structure, but behavioral changes are out of scope.

Public documentation and examples use generic repository roots and names. The import excludes design history, scratch reports, local package installations, `node_modules`, absolute home paths, company-specific examples, tokens, broker configuration, logs, JetStream data, session files, and message content.

The root README documents:

- each extension and its commands/tools;
- Pi installation and full-system-access security implications;
- the NATS requirement and local-only messaging trust boundary;
- human-controlled messaging participation, allowance, recovery, and rollout;
- development, test, and release commands.

The repository uses the MIT license.

## Verification

The consolidated repository preserves all existing tests and provides root commands for test, typecheck, lint, and repository checks. Verification includes:

- every extension and shared-module unit test;
- messaging tests against isolated NATS 2.14.6 brokers only;
- no live groups, sessions, messages, allowances, credentials, or broker state in tests;
- Node 22 and Node 24 compatibility;
- offline Pi SDK loading and installation matrices with no paid inference;
- production-dependency installation with Pi host peers supplied by the host;
- package-manifest and public-export validation;
- scans for secrets, private state, absolute personal paths, and organization-specific identifiers;
- `git diff --check`, signed-commit verification, and signed-tag verification.

The package must load all six extensions from a fresh local install before release. After tagging, a fresh git-source installation of the immutable tag must pass before dotfiles changes.

## Release

The initial release is a signed annotated `v0.1.0` tag. Tags are immutable by policy: a failed release is corrected with a new version, never by moving or replacing a published tag.

The release sequence is:

1. verify the clean consolidated tree;
2. create and verify a signed commit;
3. create and verify the signed annotated `v0.1.0` tag;
4. push the branch and tag over the `github-personal` SSH route;
5. verify the remote commit and tag;
6. run a fresh installation matrix from the tag.

## Dotfiles transition

Only after the tagged package passes verification, dotfiles changes to one canonical SSH package source:

```text
git:git@github.com:dvdkrv/pi-tools.git@v0.1.0
```

Using canonical `github.com` for read-only installation does not change the repository-local `github-personal` contribution route. The installer reconciles the pinned tag, and Pi settings replace the seven local source paths with the one git package. `obra/superpowers` remains separately pinned.

Dotfiles retains Pi settings, terminal integration, NATS installation, broker data ownership, and other machine provisioning. It removes:

- `pi-claude-bridge/`;
- `pi-loop-package/`;
- `pi-messaging/`;
- `pi-task/`;
- `pi-theme-sync/`;
- `pi-worktree-core/`;
- `pi-worktree-manager/`;
- root workspace configuration and tests owned by the extracted package;
- `docs/superpowers/` from the current tree.

Git history is preserved. The obsolete local lifecycle reference worktree and branch may be removed after the tagged-package transition verifies successfully because integration and live rollout are complete.

## Rollout and rollback

Package application remains human-controlled and occurs only while Pi sessions are idle. Relocating the messaging package does not change the existing broker authority, credentials, data paths, ledger format, peer identities, durable consumers, queues, or allowance. Loading the new package must not join, resume, arm, deliver, read a body, or invoke a model automatically.

The dotfiles transition is a separate signed commit. If installation verification fails, local package sources remain available until the failure is resolved. After transition, rollback is a normal signed revert to the preceding dotfiles commit followed by a human-controlled package reconciliation at an idle boundary. No message replay, refund, or ledger downgrade is attempted.
