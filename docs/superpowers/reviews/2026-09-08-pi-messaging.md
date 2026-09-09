# Pi messaging — verification and review

The initial verification sections below describe the original implementation at `dec259c`; dated follow-ups record later activation and changes.

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

## 2026-09-09 usability follow-ups

The hands-on setup subsequently registered the feature-worktree package in normal Pi settings and started the broker on a separate detached tmux server. That test service remains running; it is not reboot-persistent autostart. Existing sessions must reload and explicitly join themselves. The worktree must remain present while registration and launcher paths reference it.

Command autocomplete shipped in `42e2586`, with 125 aggregate tests. The approved role-naming follow-up now removes manual name entry, defaults to the Pi session ID, shows role/session labels, exposes session IDs through discovery, and permits self-only rename. Fresh routing identities and all admission semantics remain unchanged. Transient context guidance adds neither a model wakeup nor broker polling.

Fresh verification for role naming:

- **133 aggregate tests**, including **51 messaging tests**, zero failures/skips; typecheck, ShellCheck, rendered configuration/Chezmoi checks, headless Neovim, and diff whitespace checks passed.
- All 51 messaging tests also passed on Node **22.19.0** and **24.20.0**; primary runtime **26.5.0**. Actual Pi tool-schema validation accepts the 64-code-point Unicode name boundary.
- Real broker coverage verifies role-name publication, immutable historical sender names, unchanged queued recipients/counters, and fresh routing identity for the same session ID after rejoin. Unit tests cover invalid/targeted/concurrent/late rename, absent naming dialogs, session-title independence, numbered selector disambiguation, and transient/disabled/detached context.
- Google Flash live SDK runs passed on Pi **0.82.0** (8 inference requests) and **0.84.1** (7 requests). Without user-supplied names or recipient IDs, the initiator discovered the other participant, and both chose `protocol-initiator` / `protocol-responder`. Exactly two admissions were spent; FOLLOWUP stayed queued. Joining made zero inference requests, and identity guidance was absent from persisted session history. Combined estimate for the two passing runs: **$0.00954**, gateway billing unverified. Preliminary diagnostic runs incurred additional usage.
- The smoke cap is now 16 requests, retaining 512 output tokens/request, 20,000-byte contexts, 90 seconds, and a $0.50 estimated ceiling. Initial runs exposed a test-only assumption that every responder must list peers before renaming. Responders already know an incoming sender; the final test instead verifies real recipient discovery without providing an address and still requires exactly one role rename by each agent. Naming can occur after a send during the same normal run; historical sender-name snapshots are intentionally unchanged.

A separate read-only Gemini 3 Flash review (approximately **$0.02708** at published rates) was checked against source and tests:

- **Rejected unnamed-heartbeat overwrite concern:** an unnamed heartbeat changes only `lastSeen`. A CAS revision conflict rereads current state before reapplying that mutation, preserving a committed role name. Added a real-broker delayed-snapshot regression that forces the revision-conflict path and verifies both ledger and local name.
- **Rejected claimed validation bypass:** policy validation must succeed before the backend's awaited change returns; invalid strings never reach the local cache update. The new tool also validates/normalizes before calling heartbeat. The broker regression verifies rejected terminal-control names leave both local and remote names intact.
- **Rejected UI inconsistency:** the join notification, lists, and footer use the same `peerLabel` formatter. The confirmation deliberately shows the full session ID.
- **Kept shared action schema:** the existing Google-compatible enum/optional-fields layout remains; runtime validation explicitly rejects targeting/extra fields for rename, covered by tests. No administrative capability was added.

No source change was needed for those review claims. No user sessions were reloaded/joined, and the hands-on broker was not restarted or stopped by these tests. No merge or push was performed.

## Remaining limits

- No real-terminal automation or macOS execution was performed; SDK UI callbacks, rendering, and Linux processes were tested.
- Cross-machine connections, adversarial multi-user hosts, filesystem rollback/data loss recovery, project tracking, and knowledge workflows are not implemented.
- An admission can consume allowance without reaching Pi, and pause cannot retract an admitted message. These are explicit guarantees/limitations, not hidden test failures.
- `npm audit --omit=dev` reports three findings in unchanged pinned Pi dependencies: Pi coding-agent 0.82.0 (moderate), brace-expansion 5.0.7 (high), and undici 8.5.0 (high). Those exact versions already existed at `186cf04`; no NATS-package advisory was reported. They were not incidentally upgraded in this messaging change.

Canonical commands and operational recovery: [package README](../../../pi-messaging/README.md).
