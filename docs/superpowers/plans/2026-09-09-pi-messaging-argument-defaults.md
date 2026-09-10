# Pi Messaging Argument Defaults Bugfix Plan

**Scope:** Fix the reported rename/send failures within the approved messaging behavior. No broker policy, addressing alias, automatic retry, participation, or allowance changes. Keep the existing feature worktree and user sessions/service untouched.

## Confirmed cause

A targeted, read-only inspection of only `peer_message` call/result entries in the reported session confirmed:

- `rename` supplied a valid role name plus `toPeerId: ""`, `text: ""`, `inReplyTo: ""`, and `beforeSequence: 1`. The extra-key guard rejected these neutral defaults.
- `send` supplied the listed routing ID and a nonempty body, but also `inReplyTo: ""`. Backend UUID validation rejected the empty optional reply reference before reserving metadata or publishing.
- No bodies or unrelated conversation content were retained in diagnostic artifacts. No live messaging operation was invoked.
- Pi's OpenAI Responses converter forwards the tool schema; there is no evidence that Pi required these extra fields. The actual model calls populated them. Previous Flash tests happened to omit unused fields.
- The real Pi pipeline regression also demonstrated that null required name/body fields could be coerced into the literal string `"null"` before execution. Preparation now rejects non-string required values before that coercion, while normalizing null only for optional/unused fields.

## Fix and tests

- [x] Reproduce with synthetic versions of the captured argument shapes through the real Pi tool-definition adapter and agent-core execution/validation pipeline, using a bounded scripted provider (no model/network calls). Also test direct extension execution.
- [x] Add `src/tool-input.ts` owning the unchanged flat action schema and a pure `preparePeerMessageArguments` normalizer. Register Pi's supported `prepareArguments` hook and also normalize at execution for callers/hooks that bypass preparation.
- [x] Empty string/null/undefined mean absent only for optional `inReplyTo` and fields unused by the selected action. Never discard a missing/empty required send recipient/body or required rename name. Drop `beforeSequence` for non-status actions; for status preserve every meaningful cursor, including 1 and invalid 0 for rejection. Keep unknown keys and meaningful rename selectors/content for rejection.
- [x] Improve parameter descriptions: `toPeerId` is the full routing ID from discovery; `inReplyTo` is a message ID and can be omitted/empty for a new message; pagination applies only to status. Do not loosen backend ID validation or alter bodies, names, IDs, or hashes.
- [x] Verify valid reply references survive, malformed nonempty IDs still fail with no write, required values still fail, unknown keys remain rejected, targeted renames remain rejected, and status pagination is unchanged. Use fabricated IDs/text, not copied user message bodies.
- [x] Run aggregate broker-gated tests, typecheck, scripted pipeline against installed Pi as well as development Pi, and repository checks. Document the compatibility fix and preserve no-auto-retry for uncertain outcomes. Finish with a signed commit without merging/pushing.

Validation: 137 aggregate tests / 55 messaging tests, zero failures/skips; all messaging tests also pass on Node 22.19.0. The real Pi argument pipeline regression passes using development 0.82.0 and installed 0.84.1. Typecheck, ShellCheck, repository checks (rendered configuration/Chezmoi and headless Neovim), and diff checks pass. Tests use fabricated messages and a scripted provider; no model inference or live board writes were performed. A test-first diagnostic improvement now identifies whether `toPeerId` or `inReplyTo` is invalid without changing either validation rule.

## Minimal expected behavior

```js
// Harmless shared-schema padding must not turn a self-rename into a targeted operation.
{ action: 'rename', displayName: 'test-reviewer', toPeerId: '', text: '', inReplyTo: '', beforeSequence: 1 }
// Prepared: { action: 'rename', displayName: 'test-reviewer' }

{ action: 'send', toPeerId: validPeerId, text: 'hello', inReplyTo: '' }
// Prepared: { action: 'send', toPeerId: validPeerId, text: 'hello' }

{ action: 'rename', displayName: 'test-reviewer', toPeerId: anotherPeerId }
// Still rejected: never silently reinterpret an explicitly targeted rename.
```
