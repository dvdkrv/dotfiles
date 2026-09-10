# Pi messaging: session identity and role-based self-naming

## Approval and scope

The user approved removing manual name entry, discovering peers, and self-selecting role-bearing names during normal work. Their final clarification supersedes the session-title fallback: **the Pi session ID is the default**. This is a focused messaging UX/tool enhancement, not automatic participation, task assignment, project tracking, or broker lifecycle work. Continue implementation/testing under the existing autonomous approval; do not merge or push.

**Superseded lifecycle detail (2026-09-10):** the approved [participation-resume follow-up](2026-09-10-pi-messaging-lifecycle-design.md) preserves this role name and routing ID when the exact saved Pi session explicitly resumes a stale/suspended identity. The fresh-identity statements below remain historical behavior for joins with no resumable candidate and for rejoining after final leave/revoke.

## Identity

- Join uses `ctx.sessionManager.getSessionId()` as both `sessionId` and initial `displayName`, without asking for a name. Keep the existing join confirmation, and show the default there.
- A role name describes the agent's existing human-assigned responsibility (for example `messaging-implementer` or `test-reviewer`). It does not confer authority. If responsibility is unknown, keep the session-ID default instead of inventing work.
- Pi session identity remains visible after renaming. Compact UI shows a role plus shortened session ID, or the session ID alone while unnamed. Discovery exposes the full session ID.
- Keep the separate existing per-join peer ID as the opaque routing key. Names and session IDs are not routing aliases. Leave/rejoin creates a fresh peer ID even for the same Pi session ID, so old inboxes are never reassigned. Number selection rows to avoid ambiguity even if names and shortened session IDs collide.
- Pi session-title changes do not overwrite messaging names. No naming restoration across fresh membership.

## Agent behavior and tool boundary

Add `peer_message` action `rename` with `displayName`. It updates only the current joined peer via the existing backend heartbeat/name operation. Reject meaningful target selectors, invalid names, unjoined/non-TUI callers, and concurrent renames of the same participation. The tool boundary normalizes harmless shared-schema padding before Pi validation: empty/null unused fields and optional reply references are absent; pagination is ignored outside status. It does not discard nonempty rename targets/content, unknown keys, required fields, or malformed nonempty IDs. Reuse existing nonempty, single-line, terminal-control-safe, 64-code-point validation. Capture the peer before awaiting and fence the result against leave/rejoin or session changes. Do not add a new ledger schema or broker API.

`peers` remains a bounded same-group metadata read, now including session IDs alongside names and routing IDs. It exposes no message bodies or other sessions' transcripts.

A synchronous `context` hook adds one ephemeral, explicitly extension-origin identity/guidance message only while joined, connected, in TUI mode, and with `peer_message` enabled. It uses local membership metadata only: no broker polling, no model calls, no injected wakeup, and no persistent session entry. It tells the agent to discover peers and choose a concise role name during normal work, maintain it when its assignment changes, and avoid repeated polling, renaming, greetings, or invented responsibilities. Metadata is not promoted into system instructions. Remove any stale copy of this extension's identity context before appending the current one; omit it after detachment.

The later approved [quiet follow-up](2026-09-09-pi-messaging-quiet-design.md) bounds naming reminders to the first two eligible requests and supplies compact identity metadata afterward, rather than repeating the full guidance indefinitely. Idle-gated follow-up delivery replaces steering busy agents.

Joining stays human-only; arming stays human-only; allowances, attempts, message envelopes, receipts, and uncertain-delivery rules are unchanged. Ordinary discovery/rename tool calls can incur normal agent-turn tokens, but the extension starts no naming-only inference.

## Validation

Test no name prompt, session-ID fallback, cancellation and late-confirmation fencing, session-title independence, own-only validated rename, discovery's session IDs, same-session fresh routing IDs, unchanged counters and queued recipients, concurrent/delayed rename fencing, and unambiguous UI selection. Test ephemeral context without network/model/queue side effects, disabled-tool and detached behavior, and no pending bodies in guidance.

Run real broker and aggregate tests plus typecheck. Update the bounded cheap-model smoke to demonstrate discovery and role naming without a user naming instruction, then retain PING/PONG/FOLLOWUP admission checks. Use only isolated test sessions and broker stores. Existing user sessions and the detached hands-on broker stay untouched. Discovery and naming are model behaviors, not an enforced tool sequence: test recipient discovery with no human-supplied address, while allowing replies to use an already known sender ID. Naming need not precede the first message; existing message sender-name snapshots stay immutable. Self-review: no placeholders, new authority, migration, or unrelated subsystem changes.
