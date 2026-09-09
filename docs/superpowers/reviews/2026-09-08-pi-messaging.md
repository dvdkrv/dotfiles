# Pi messaging — verification and review

Implementation branch: `feat/pi-messaging`, based on `186cf04` (the reviewed design and explicit implementation approval). No push, merge, global Pi activation, or persistent service installation was performed. Core commits are present through `181eeb2`, followed by the final signed integration/review commit. The first final-commit attempt was blocked by a missing SSH-agent socket. After agent forwarding was restored, `ssh-add -l` confirmed access, all 121 tests and repository checks were rerun successfully, and the configured `dd-gitsign` signer was used without bypassing signing.

## Verification

- Clean `npm ci --ignore-scripts`, aggregate `npm test` (**121 tests, including 39 messaging tests; zero failures/skips**), TypeScript, ShellCheck, and repository checks pass. The repository checks include rendered JSON/Chezmoi boundaries and headless Neovim startup.
- Messaging tests exercise policy, actual NATS processes, a 14-process contention race with exactly 12 successful admissions, hard broker restart, a proxy dropping a successful ledger-write acknowledgment, actual broker replay, pause versus pending pull, lifecycle fencing, human UI controls, metadata-only tools, and the independent loop extension.
- The explicit broker gate fails when nats-server is unavailable; ordinary tests label broker cases as skipped in that situation. The recorded successful runs supplied the binary and did not skip broker tests.
- All 39 messaging tests pass on Node 22.19.0 minimum and Node 24.20.0; primary development verification uses Node 26.5.0. CI configurations were added, but GitHub CI itself has not been run because the branch has not been pushed.
- A standalone copy installed with `--omit=dev --ignore-scripts --legacy-peer-deps` loads under installed Pi without creating messaging state. This checks that dependencies do not accidentally rely on the workspace's development install.
- nats-server 2.14.6 was downloaded to temporary storage and checked against the official release checksum. Test brokers and standalone-install directories were cleaned up; no persistent broker was started.

## Live models

Real SDK sessions passed on repository Pi 0.82.0 and installed Pi 0.84.1 using `ai-gw-google/gemini-3-flash-preview`. Each successful bounded run made six inference requests. PING and PONG consumed two shared admissions; FOLLOWUP remained queued. No built-in file or shell tools were enabled.

The harness uses scripted human TUI dialogs, not real terminal interaction. It enforces eight requests, 512 output tokens/request, bounded input, a 90-second deadline, and a $0.50 estimated upper bound. Per-run observed usage was approximately **$0.002** at Google's standard text rates. The configured gateway catalogue had zero-filled prices; these were replaced only in the test's model object using published rates, not treated as free inference. Gateway billing is not independently verified.

The initial Anthropic Haiku attempt failed credential refresh before a model response; credentials were not modified to bypass that failure. An initial Google probe exercised the exchange but exposed ineffective instrumentation (`requests: 0`); it was not used as evidence of bounded testing. The limiter was moved to the actual `ModelRuntime.streamSimple` boundary, assertions require a nonzero bounded request count, and the tests were rerun successfully.

## Independent review and disposition

A separate read-only Gemini 3 Flash review inspected the source, tests, and plan; estimated cost approximately $0.022. Findings were checked against code rather than applied blindly:

- **Confirmed cleanup gap:** leave metadata can commit before consumer deletion fails. Prune now reclaims inactive/orphaned consumers. It lists consumers before reading current membership so a concurrent new join is not deleted; merely stale active identities still require explicit human revocation. A real-broker regression failed before the fix and passes afterward.
- **Completed retention wiring:** throttled send-time maintenance applies the seven-day terminal-history policy. Read-only status/reader operations do not perform maintenance. Pending work and credits remain intact.
- **Rejected suggested concurrent-pump race:** the existing `flight` promise coalesces wakeups; awaited loop iterations are sequential. The backend also prevents overlapping fetches. Runtime tests cover delayed reservations and multiple notifications.
- **Rejected model-time acknowledgment concern:** broker acknowledgment follows admission, not model completion; its timeout does not need to match LLM generation duration. Actual broker replay is tested without a second admission.
- **Rejected identity-reuse concern:** every join creates a UUID and a distinct consumer name. Old inbox reassignment would violate the approved design. Leave-during-join cancellation is tested.
- **Rejected claimed transient world-readable token file:** the file is opened with mode 0600 inside a 0700 directory; there is no later chmod window. This remains a trusted-host/local-user design, not remote TLS server authentication.
- **Clarified human resend:** a new human composition intentionally gets a new identity. Uncertain-publication errors now tell the human to inspect first rather than implying a safe retry after rejoining.

Additional regressions fixed stale selected-group replacement, late dialog/status operations after leaving, blank-name behavior, malformed array-backed ledgers, and carriage-return/tab rendering.

## Remaining limits

- No real-terminal automation or macOS execution was performed; SDK UI callbacks, rendering, and Linux processes were tested.
- Cross-machine connections, adversarial multi-user hosts, filesystem rollback/data loss recovery, project tracking, and knowledge workflows are not implemented.
- An admission can consume allowance without reaching Pi, and pause cannot retract an admitted message. These are explicit guarantees/limitations, not hidden test failures.
- `npm audit --omit=dev` reports three findings in unchanged pinned Pi dependencies: Pi coding-agent 0.82.0 (moderate), brace-expansion 5.0.7 (high), and undici 8.5.0 (high). Those exact versions already existed at `186cf04`; no NATS-package advisory was reported. They were not incidentally upgraded in this messaging change.

Canonical commands and operational recovery: [package README](../../../pi-messaging/README.md).
