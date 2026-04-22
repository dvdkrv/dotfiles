---
name: gt
description: Graphite (gt) stacked-PR workflow reference. Invoke explicitly via /gt; not auto-invoked by the model.
disable-model-invocation: true
---

You are now in Graphite workflow mode. Use `gt` commands for all branch and PR operations in this session.

## Key Commands

| Command | Short | Purpose |
|---|---|---|
| `gt create <name>` | `gt bc <name>` | Create a new branch on top of current |
| `gt modify` | `gt m` | Amend the latest commit (keep existing message) |
| `gt modify -a` | `gt m -a` | Stage all changes, then amend |
| `gt modify -m "msg"` | `gt m -m "msg"` | Amend and update the commit message |
| `gt modify -a -m "msg"` | `gt m -a -m "msg"` | Stage all and amend with new message |
| `gt modify -c -m "msg"` | `gt m -c -m "msg"` | Create a **new** commit with a message |
| `gt modify -a -c -m "msg"` | `gt m -a -c -m "msg"` | Stage all and create new commit with message |
| `gt sync` | | Pull trunk, auto-restack surviving branches |
| `gt restack` | `gt rs` | Rebase stack after manual parent changes |
| `gt submit` | `gt ss` | Push all branches and open/update PRs |
| `gt submit --draft` | | Submit as draft PRs |
| `gt checkout <branch>` | `gt co` | Switch to a stack branch |
| `gt up` / `gt down` | | Navigate one step up/down in the stack |
| `gt log short` | `gt ls` | Compact view of the current stack |
| `gt squash` | | Squash commits on current branch |
| `gt delete <branch>` | | Delete a branch from the stack |

## Common Workflows

**Start a new stack:**
```sh
gt sync                                  # sync with trunk first
gt create feat/base                      # first branch
# make changes
gt modify -a -m "feat: add base layer"   # stage all and amend with message
gt create feat/next                      # next layer in stack
```

**Add a new commit to the current branch:**
```sh
# make changes
gt modify -a -c -m "feat: add X"         # stage all and create new commit
```

**Update a branch after review feedback:**
```sh
gt co <branch>
# make changes
gt modify -a -m "fix: address feedback"  # amend with updated message
gt restack                               # rebase all children
gt submit                                # update all PRs
```

**Sync after upstream merges:**
```sh
gt sync                    # pulls trunk, auto-restacks surviving branches
gt submit                  # update remaining open PRs
```

## Rules to Follow
- Use `gt create` instead of `git checkout -b`
- Use `gt modify` instead of `git commit --amend`
- Always use `-m "message"` when creating a new commit with `-c`
- Use `gt submit` instead of `git push` for stack branches
- Use `gt restack` instead of manual `git rebase` within a stack
- After any parent branch changes, always run `gt restack` before submitting
- Keep each branch focused on a single logical change
- Add stack context to PR descriptions when the PR depends on another

## PR Descriptions
When submitting PRs in a stack, include in the description:
- What this specific PR changes (not the whole stack)
- A link to the base/parent PR if applicable
- Note that it's part of a stack so reviewers know to review from bottom up
