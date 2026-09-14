# Pi Automatic Light/Dark Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure every Pi process to use Pi's built-in automatic `light/dark` theme mode instead of relying on one-shot startup detection.

**Architecture:** Add the public slash-form theme pair to the chezmoi-managed global Pi settings. Protect the exact setting with an existing repository configuration test and validate the rendered target without printing its contents. After verification, atomically change only the installed settings' top-level theme value; never apply a linked-worktree rendering whose `.chezmoi.sourceDir` would replace stable package paths.

**Tech Stack:** JSON Pi settings, chezmoi, Node.js built-in test runner, repository shell checks.

## Global Constraints

- Use the exact Pi setting `"theme": "light/dark"`; do not force either appearance.
- Use only Pi's built-in themes and automatic color-scheme notifications; add no extension, custom theme, dependency, polling loop, or terminal escape implementation.
- Do not modify saved conversations, session histories, extension/tool state, loops, messaging state, tmux, Ghostty, or upstream Pi files.
- Do not reload, restart, or send input to active Pi sessions; session reload timing remains human-controlled.
- Update only the top-level `theme` value in `~/.pi/agent/settings.json` after all repository checks pass; preserve every other value and the existing file mode.
- Never apply a template rendered with the linked worktree as `.chezmoi.sourceDir`, and never print the complete rendered or installed settings file.
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

- [ ] **Step 7: Atomically update only the installed theme value**

Do not apply a template from the linked worktree because its `.chezmoi.sourceDir` would replace the stable package paths. Preserve every existing JSON value and file mode while changing only the top-level theme:

```bash
python3 - <<'PY'
import json, os, stat, tempfile
from pathlib import Path
path = Path.home() / '.pi/agent/settings.json'
before = path.lstat()
assert stat.S_ISREG(before.st_mode) and not path.is_symlink()
settings = json.loads(path.read_text())
settings['theme'] = 'light/dark'
fd, temporary = tempfile.mkstemp(prefix=f'.{path.name}.', dir=path.parent)
try:
    os.fchmod(fd, stat.S_IMODE(before.st_mode))
    with os.fdopen(fd, 'w') as handle:
        json.dump(settings, handle, indent=2)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
installed = json.loads(path.read_text())
assert installed.get('theme') == 'light/dark'
assert stat.S_IMODE(path.stat().st_mode) == stat.S_IMODE(before.st_mode)
PY
```

Expected: PASS with no settings body printed. Do not invoke `/reload` or manipulate a Pi pane. After this branch is merged, normal chezmoi application from `main` will retain the same theme value and stable package paths.

- [ ] **Step 8: Verify final branch state**

```bash
git diff --check
git status --short --branch
git log --show-signature --format='%h %G? %s' main..HEAD
```

Expected: clean `fix/pi-auto-theme`; both design and implementation commits have good signatures. Report that affected sessions can apply the setting with human-controlled `/reload` at an idle boundary.
