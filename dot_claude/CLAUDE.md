# Global Claude Instructions

## Commit Style
- Follow conventional commits: `type(scope): description`
- Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `style`, `perf`
- Keep commits atomic and focused
- Write the "why" in the body when the reason isn't obvious from the subject

## Git Workflow
- I use Graphite (`gt`) for stacked PR management — invoke the `/gt` skill when working with stacked branches or PRs

## GitHub PRs
- Before creating a PR, check the repo for a pull request template (`.github/PULL_REQUEST_TEMPLATE.md`, `.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE/*.md`, or `docs/pull_request_template.md`). If one exists, use it as the PR body, filling in each section — do not substitute your own structure.
- If multiple templates exist, pick the one that matches the change type; ask if unclear.
- If no template exists, fall back to the default `## Summary` / `## Test plan` format.

@RTK.md
