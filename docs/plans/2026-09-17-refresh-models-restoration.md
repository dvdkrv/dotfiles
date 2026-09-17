# Conditional refresh-models Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the private `/refresh-models` Pi command whenever its existing work checkout is available, without making dotfiles provision or mutate that checkout.

**Architecture:** Render one additional local Pi package source from the Chezmoi-managed settings template only when `~/dd/datadog-pi-packages/packages/refresh-models` exists. Exercise both checkout-present and checkout-absent renders in isolated homes, leave the signed Git package installer unchanged, and document the explicit apply/reload boundary.

**Tech Stack:** Chezmoi Go templates, JSON, Node.js built-in test runner, Bash, Pi package settings.

## Global Constraints

- Execute inline only; do not dispatch subagents.
- The existing Chezmoi `work` value remains unchanged because it controls zsh deployment rather than Datadog Pi packages.
- `run_onchange_after_06-install-pi-packages.sh.tmpl` continues to install only signed immutable Git packages.
- Dotfiles must not clone, pull, build, install dependencies for, or otherwise mutate `datadog-pi-packages`.
- The private package source must be `../../dd/datadog-pi-packages/packages/refresh-models` and must appear exactly once only when its checkout exists.
- Both checkout-present and checkout-absent settings renders must be valid JSON.
- Chezmoi application and Pi `/reload` remain separate, explicit human-controlled rollout actions.
- Do not modify Pi messaging configuration, broker state, package pins, or the public `pi-tools` package.
- All commits must be signed as `David Kirov <31777857+dvdkrv@users.noreply.github.com>`; never bypass signing or force-push.

---

## File Structure

- `dot_pi/agent/settings.json.tmpl` — conditionally declares the existing private local package while retaining the signed package pins and automatic theme.
- `tests/pi-package-dependencies.test.mjs` — renders the template in isolated homes and asserts both capability branches and installer boundaries.
- `README.md` — documents checkout detection, ownership, and the explicit apply/reload sequence.

No new production script or dependency is needed.

### Task 1: Conditionally render the private Pi package

**Files:**
- Modify: `tests/pi-package-dependencies.test.mjs`
- Modify: `dot_pi/agent/settings.json.tmpl`

**Interfaces:**
- Consumes: Chezmoi `.chezmoi.homeDir` and its `stat(path)` template function.
- Produces: valid rendered JSON whose `packages` array conditionally contains `../../dd/datadog-pi-packages/packages/refresh-models`.
- Preserves: `git:git@github.com/dvdkrv/pi-tools.git@v0.1.1`, `git:github.com/obra/superpowers@v6.2.0`, and `theme: "light/dark"`.

- [ ] **Step 1: Add an isolated settings-render helper and failing capability test**

Replace the test file's imports and direct settings parse with the following support:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

function pkg(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SETTINGS_TEMPLATE = join(REPOSITORY_ROOT, 'dot_pi/agent/settings.json.tmpl');
const REFRESH_MODELS_SOURCE = '../../dd/datadog-pi-packages/packages/refresh-models';
const REFRESH_MODELS_CHECKOUT = 'dd/datadog-pi-packages/packages/refresh-models';

function renderPiSettings({ withRefreshModels = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dotfiles-pi-settings-'));
  const home = join(root, 'home');
  const config = join(root, 'chezmoi.toml');
  const state = join(root, 'chezmoi.boltdb');
  mkdirSync(home, { recursive: true });
  if (withRefreshModels) {
    mkdirSync(join(home, REFRESH_MODELS_CHECKOUT), { recursive: true });
  }
  writeFileSync(config, `sourceDir = ${JSON.stringify(REPOSITORY_ROOT)}\n`, 'utf8');

  try {
    const result = spawnSync(
      'chezmoi',
      [
        '--config', config,
        '--source', REPOSITORY_ROOT,
        '--destination', home,
        '--persistent-state', state,
        'execute-template',
      ],
      {
        cwd: REPOSITORY_ROOT,
        env: { ...process.env, HOME: home },
        input: readFileSync(SETTINGS_TEMPLATE, 'utf8'),
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
```

Change `pi settings load the signed Pi tools release and pinned Superpowers exactly once` to call `renderPiSettings()` instead of `pkg('dot_pi/agent/settings.json.tmpl')`.

Add this test:

```js
test('pi settings load refresh-models only when its private checkout exists', () => {
  const absent = renderPiSettings();
  const present = renderPiSettings({ withRefreshModels: true });

  assert.equal(absent.packages.filter((source) => source === REFRESH_MODELS_SOURCE).length, 0);
  assert.equal(present.packages.filter((source) => source === REFRESH_MODELS_SOURCE).length, 1);
});
```

Production change that will make this test pass: conditionally emit `REFRESH_MODELS_SOURCE` from `dot_pi/agent/settings.json.tmpl` based on the checkout under `.chezmoi.homeDir`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test --test-name-pattern='refresh-models only' tests/pi-package-dependencies.test.mjs
```

Expected: FAIL because the checkout-present render contains zero instances instead of one. The checkout-absent render must already parse successfully.

- [ ] **Step 3: Add the minimal conditional template entry**

Change `dot_pi/agent/settings.json.tmpl` to:

```gotemplate
{{- $refreshModelsCheckout := joinPath .chezmoi.homeDir "dd/datadog-pi-packages/packages/refresh-models" -}}
{
  "packages": [
    "git:git@github.com/dvdkrv/pi-tools.git@v0.1.1",
    "git:github.com/obra/superpowers@v6.2.0"{{ if stat $refreshModelsCheckout }},
    "../../dd/datadog-pi-packages/packages/refresh-models"{{ end }}
  ],
  "theme": "light/dark",
  "defaultThinkingLevel": "high"
}
```

Do not add this path to `run_onchange_after_06-install-pi-packages.sh.tmpl`.

- [ ] **Step 4: Run focused and package-policy tests and verify GREEN**

Run:

```bash
node --test tests/pi-package-dependencies.test.mjs
```

Expected: all tests in the file pass. This proves both render branches are valid JSON, the private source is conditional and unique, and the signed installer remains unchanged.

- [ ] **Step 5: Run repository rendering checks**

Run:

```bash
npm run check
git diff --check
```

Expected: both commands exit 0; the real-machine render includes the private source because the checkout exists, while repository boundaries and headless Neovim checks remain healthy.

- [ ] **Step 6: Commit the tested conditional configuration**

```bash
git add dot_pi/agent/settings.json.tmpl tests/pi-package-dependencies.test.mjs
git commit -S -m "fix: restore private model refresh package"
```

Verify:

```bash
git log -1 --show-signature --format='%H %G? %s'
```

Expected: trusted `G` signature from `SHA256:YD5aofj7Ho7upNN2q7RI2R5mPJPQGKpO+91P4NkmARY`.

### Task 2: Document ownership and the explicit reload boundary

**Files:**
- Modify: `tests/pi-package-dependencies.test.mjs`
- Modify: `tests/doctor.test.mjs`
- Modify: `README.md`

**Interfaces:**
- Consumes: the conditional source and human-controlled rollout behavior from Task 1.
- Produces: operator guidance that distinguishes managed declaration from private-checkout ownership.

- [ ] **Step 1: Add failing documentation assertions**

Extend `README documents canonical installation and delegation safety` with:

```js
  assert.match(readme, /datadog-pi-packages\/packages\/refresh-models/);
  assert.match(readme, /\/refresh-models/);
  assert.match(readme, /checkout.*not.*clone|does not clone.*checkout/i);
  assert.match(readme, /\/reload/);
```

Production change that will make these assertions pass: document the conditional private extension and explicit reload behavior in `README.md`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test --test-name-pattern='README documents canonical' tests/pi-package-dependencies.test.mjs
```

Expected: FAIL because the README does not yet mention the private checkout or `/refresh-models`.

- [ ] **Step 3: Add the operator documentation**

Add this section after `## Pi peer messaging` and its package paragraph:

```markdown
## Optional work model refresh

When `~/dd/datadog-pi-packages/packages/refresh-models` already exists, the managed Pi settings load it as a private work extension and expose `/refresh-models`. Dotfiles only declares the existing checkout; it does not clone, update, build, or install dependencies for that repository.

After applying a settings change, start a new Pi process or run `/reload` at an explicit idle boundary. Updating the private checkout also requires an explicit reload before an existing Pi process uses the new code.
```

Do not add private package contents, credentials, generated `models.json`, or internal service details.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test --test-name-pattern='README documents canonical' tests/pi-package-dependencies.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Run the complete suite and capture the doctor harness regression**

Run:

```bash
npm test
```

Expected before the harness update: doctor tests fail with `broken: dot_pi/agent/settings.json.tmpl` because their fake `chezmoi execute-template` copies template syntax verbatim instead of rendering it.

- [ ] **Step 6: Make doctor template checks use the real renderer**

In `tests/doctor.test.mjs`, resolve the real Chezmoi binary once:

```js
const doctorScript = new URL('../doctor.sh', import.meta.url).pathname;
const realChezmoi = spawnSync('sh', ['-c', 'command -v chezmoi'], { encoding: 'utf8' }).stdout.trim();
assert.notEqual(realChezmoi, '', 'chezmoi is required for doctor template tests');
```

Keep `chezmoi doctor` isolated, but replace the fake execute behavior with:

```js
  writeExecutable(join(bin, 'chezmoi'), `#!/usr/bin/env bash
case "\${1:-}" in
  doctor) exit 0 ;;
  execute-template) exec ${JSON.stringify(realChezmoi)} execute-template ;;
  *) exit 0 ;;
esac
`);
```

This delegates only template rendering and does not inspect or mutate live Chezmoi state because the harness provides an isolated `HOME`.

- [ ] **Step 7: Verify the doctor harness is GREEN**

Run:

```bash
node --test tests/doctor.test.mjs
```

Expected: all 17 doctor tests pass.

- [ ] **Step 8: Run the complete test suite and ShellCheck**

Run:

```bash
npm test
npm run lint:shell
git diff --check
```

Expected: 44 tests pass after the new capability test, ShellCheck exits 0, and no whitespace errors are reported.

- [ ] **Step 9: Commit the documentation checkpoint**

```bash
git add README.md tests/pi-package-dependencies.test.mjs tests/doctor.test.mjs docs/plans/2026-09-17-refresh-models-restoration.md
git commit -S -m "docs: explain optional model refresh package"
```

Verify the signature with:

```bash
git log -1 --show-signature --format='%H %G? %s'
```

Expected: trusted `G` signature from the configured `dvdkrv` identity.

### Task 3: Verify isolated rendering and prepare human-controlled rollout

**Files:**
- Verify only; no source changes expected.

**Interfaces:**
- Consumes: the completed settings template and tests.
- Produces: verification evidence and an explicit stop before live application or reload.

- [ ] **Step 1: Run the full repository gate**

```bash
npm test
npm run lint:shell
npm run check
git diff --check main...HEAD
```

Expected: all tests pass, ShellCheck and repository checks exit 0, and no diff whitespace errors appear.

- [ ] **Step 2: Verify a disposable checkout-present Chezmoi application**

```bash
root="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-refresh-models.XXXXXX")"
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/home/dd/datadog-pi-packages/packages/refresh-models"
printf 'sourceDir = "%s"\n' "$PWD" >"$root/chezmoi.toml"
settings_target="$root/home/.pi/agent/settings.json"
mkdir -p "$(dirname "$settings_target")"
HOME="$root/home" chezmoi \
  --config "$root/chezmoi.toml" \
  --source "$PWD" \
  --destination "$root/home" \
  --persistent-state "$root/chezmoi.boltdb" \
  apply --force "$settings_target"
jq -e --arg source '../../dd/datadog-pi-packages/packages/refresh-models' \
  '[.packages[] | select(. == $source)] | length == 1' \
  "$settings_target"
```

Expected: targeted apply exits 0 and `jq` confirms exactly one private source. No run script executes because only the settings target is applied.

- [ ] **Step 3: Verify a disposable checkout-absent render**

```bash
root="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-refresh-models-absent.XXXXXX")"
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/home"
printf 'sourceDir = "%s"\n' "$PWD" >"$root/chezmoi.toml"
HOME="$root/home" chezmoi \
  --config "$root/chezmoi.toml" \
  --source "$PWD" \
  --destination "$root/home" \
  --persistent-state "$root/chezmoi.boltdb" \
  execute-template < dot_pi/agent/settings.json.tmpl >"$root/settings-absent.json"
jq -e --arg source '../../dd/datadog-pi-packages/packages/refresh-models' \
  '[.packages[] | select(. == $source)] | length == 0' \
  "$root/settings-absent.json"
```

Expected: render exits 0 and `jq` confirms the private source is absent.

- [ ] **Step 4: Verify branch cleanliness and every new signature**

```bash
git status --short --branch
git log --show-signature --format='%H %G? %s' main..HEAD
```

Expected: clean branch and only trusted `G` signatures.

- [ ] **Step 5: Stop for integration and rollout approval**

Report the verification evidence and ask separately for:

1. merge/push approval;
2. targeted live application of `~/.pi/agent/settings.json`;
3. active Pi `/reload` at a human-selected idle boundary.

Do not run any of those actions implicitly. Do not execute `/refresh-models`; after reload, only verify command availability or run `/refresh-models version` with explicit approval.
