# Pi Automatic Light/Dark Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure every Pi process to use Pi's built-in automatic `light/dark` theme mode instead of relying on one-shot startup detection.

**Architecture:** Add the public slash-form theme pair to the chezmoi-managed global Pi settings. Protect the exact setting with an existing repository configuration test, validate the rendered managed target without printing its contents, and apply only that target to the current machine after verification.

**Tech Stack:** JSON Pi settings, chezmoi, Node.js built-in test runner, repository shell checks.

## Global Constraints

- Use the exact Pi setting `"theme": "light/dark"`; do not force either appearance.
- Use only Pi's built-in themes and automatic color-scheme notifications; add no extension, custom theme, dependency, polling loop, or terminal escape implementation.
- Do not modify saved conversations, session histories, extension/tool state, loops, messaging state, tmux, Ghostty, or upstream Pi files.
- Do not reload, restart, or send input to active Pi sessions; session reload timing remains human-controlled.
- Apply only the managed `~/.pi/agent/settings.json` target after all repository checks pass.
- Never print the complete rendered or installed settings file.
- Every repository commit must be SSH-signed.

---

### Task 1: Persist and apply explicit automatic theme selection

**Files:**
- Modify: `tests/pi-package-dependencies.test.mjs`
- Modify: `dot_pi/agent/settings.json.tmpl`

**Interfaces:**
- Consumes: Pi's public slash-form `lightTheme/darkTheme` setting syntax.
- Produces: `settings.theme === "light/dark"` in both the managed template and the rendered current-machine target.

- [ ] **Step 1: Add the failing managed-settings assertion**

Extend `pi settings load the pinned native Superpowers package exactly once` in `tests/pi-package-dependencies.test.mjs` immediately after parsing the settings:

```js
  assert.equal(
    settings.theme,
    'light/dark',
    'Pi should track terminal appearance using the built-in automatic theme pair',
  );
```

- [ ] **Step 2: Run the focused test and confirm RED**

```bash
node --test --test-name-pattern='pi settings load' tests/pi-package-dependencies.test.mjs
```

Expected: FAIL because the current parsed value is `undefined`, not `light/dark`.

- [ ] **Step 3: Add the minimal managed setting**

In `dot_pi/agent/settings.json.tmpl`, add the top-level property without changing any package, provider, model, transport, compaction, or extension setting:

```json
  "theme": "light/dark",
```

Keep the file valid JSON.

- [ ] **Step 4: Run the focused test and rendered-target validation**

```bash
node --test --test-name-pattern='pi settings load' tests/pi-package-dependencies.test.mjs
chezmoi --source "$PWD" cat ~/.pi/agent/settings.json | \
  python3 -c 'import json,sys; assert json.load(sys.stdin).get("theme") == "light/dark"'
```

Expected: PASS with no settings contents printed.

- [ ] **Step 5: Run the complete repository verification**

```bash
npm test
npm run typecheck
npm run lint:shell
npm run check
git diff --check
```

Expected: zero failures.

- [ ] **Step 6: Create the signed implementation commit**

```bash
git add tests/pi-package-dependencies.test.mjs dot_pi/agent/settings.json.tmpl
git commit -S -m "fix: enable automatic Pi theme selection"
git log -1 --show-signature --format='%h %G? %s'
```

Expected: a good SSH signature.

- [ ] **Step 7: Apply only the verified managed target**

From this worktree, explicitly select it as the chezmoi source and apply only the Pi settings target:

```bash
chezmoi --source "$PWD" apply ~/.pi/agent/settings.json
python3 - <<'PY'
import json
from pathlib import Path
settings = json.loads(Path.home().joinpath('.pi/agent/settings.json').read_text())
assert settings.get('theme') == 'light/dark'
PY
```

Expected: PASS with no settings body printed. Do not invoke `/reload` or manipulate a Pi pane.

- [ ] **Step 8: Verify final branch state**

```bash
git diff --check
git status --short --branch
git log --show-signature --format='%h %G? %s' main..HEAD
```

Expected: clean `fix/pi-auto-theme`; both design and implementation commits have good signatures. Report that affected sessions can apply the setting with human-controlled `/reload` at an idle boundary.
