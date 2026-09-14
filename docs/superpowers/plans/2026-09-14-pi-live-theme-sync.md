# Pi Live Terminal Theme Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every running interactive Pi session synchronized with the light/dark appearance already selected by the repository's tmux theme controls.

**Architecture:** Make `${XDG_STATE_HOME:-$HOME/.local/state}/theme` the canonical account-wide appearance signal and make the existing tmux helpers update it atomically. Add a focused `pi-theme-sync` package whose extension resolves initial appearance from state, then `LC_TERMINAL_THEME`, then dark; it watches the canonical state and applies Pi's loaded built-in `Theme` objects without persisting fixed theme names.

**Tech Stack:** Bash, tmux, TypeScript, Pi Extension API, Node.js `fs.watchFile`, Node.js built-in test runner, jiti, npm workspaces, chezmoi.

## Global Constraints

- Accept only the exact state values `light` and `dark` after trimming whitespace.
- A valid state file takes precedence over `LC_TERMINAL_THEME`; missing or invalid startup state falls back to a valid `LC_TERMINAL_THEME`, then `dark`.
- Preserve account-wide tmux semantics: the most recent synchronized or manual theme change wins for all attached clients and running Pi sessions.
- Apply loaded Pi `Theme` objects, never string names, so the managed `"theme": "light/dark"` setting is not replaced with a fixed theme.
- Keep `"theme": "light/dark"` in `dot_pi/agent/settings.json.tmpl` as the fallback before extension binding and outside the TUI.
- Start watchers only in TUI mode, suppress duplicate applications, ignore invalid live values, and clean up watchers idempotently on session shutdown or restart.
- Shell writers must atomically replace the canonical state file and never expose a partially written value.
- Automated tests must use temporary paths and fake UI/watcher seams; they must not mutate the real state file, tmux server, Pi settings, sessions, or processes.
- Do not kill, restart, reload, or send input to active Pi sessions. A human may run `/reload` once after installation.
- Do not change Pi upstream, add a custom palette, or depend on OSC passthrough or terminal color-scheme notifications.
- Every repository commit must be SSH-signed.

---

### Task 1: Make the tmux helpers maintain canonical theme state

**Files:**
- Modify: `tests/provisioning.test.mjs`
- Modify: `dot_local/bin/toggle-theme.sh`
- Modify: `dot_local/bin/sync-terminal-theme.sh`

**Interfaces:**
- Consumes: `LC_TERMINAL_THEME` imported into tmux and optional `toggle-theme.sh [light|dark]` input.
- Produces: an atomically replaced `${XDG_STATE_HOME:-$HOME/.local/state}/theme` containing exactly `light\n` or `dark\n` after every valid explicit synchronization, including same-as-default requests.

- [ ] **Step 1: Add a failing isolated shell-helper test harness**

Add this harness near the other script harnesses in `tests/provisioning.test.mjs`; its required filesystem imports (`mkdtempSync`, `mkdirSync`, `readFileSync`, and `writeFileSync`) already exist:

```js
const toggleThemeScript = new URL('../dot_local/bin/toggle-theme.sh', import.meta.url).pathname;
const syncTerminalThemeScript = new URL('../dot_local/bin/sync-terminal-theme.sh', import.meta.url).pathname;

function themeScriptHarness(clientTheme = 'light') {
  const root = mkdtempSync(join(tmpdir(), 'dotfiles-theme-'));
  const home = join(root, 'home');
  const stateHome = join(root, 'state');
  const bin = join(root, 'bin');
  const localBin = join(home, '.local', 'bin');
  const tmuxLog = join(root, 'tmux.log');
  mkdirSync(stateHome, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(localBin, { recursive: true });
  writeExecutable(join(localBin, 'toggle-theme.sh'), repositoryFile('dot_local/bin/toggle-theme.sh'));
  writeExecutable(join(bin, 'tmux'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TMUX_LOG"
if [[ "$1" == "show-environment" ]]; then
  printf 'LC_TERMINAL_THEME=%s\\n' "$TMUX_THEME"
fi
`);
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: stateHome,
    PATH: `${bin}:/usr/bin:/bin`,
    TMUX_LOG: tmuxLog,
    TMUX_THEME: clientTheme,
  };
  return { root, env, stateFile: join(stateHome, 'theme'), tmuxLog };
}
```

Add these tests:

```js
test('toggle-theme creates canonical state even when explicit dark matches the default', () => {
  const harness = themeScriptHarness('dark');
  const result = spawnSync('/bin/bash', [toggleThemeScript, 'dark'], {
    env: harness.env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(harness.stateFile, 'utf8'), 'dark\n');
  assert.match(repositoryFile('dot_local/bin/toggle-theme.sh'), /mktemp/);
  assert.match(repositoryFile('dot_local/bin/toggle-theme.sh'), /mv .*"\$STATE"/);
});

test('client attachment creates missing canonical state even when dark matches the default', () => {
  const harness = themeScriptHarness('dark');
  const result = spawnSync('/bin/bash', [syncTerminalThemeScript], {
    env: harness.env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(harness.stateFile, 'utf8'), 'dark\n');
  assert.match(readFileSync(harness.tmuxLog, 'utf8'), /show-environment LC_TERMINAL_THEME/);
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

```bash
node --test --test-name-pattern='canonical state|client attachment creates' tests/provisioning.test.mjs
```

Expected: FAIL because explicit `dark` exits before creating state and attachment synchronization can bypass canonical-state repair.

- [ ] **Step 3: Atomically persist state before the unchanged-theme fast path**

Replace the selection-and-fast-path section of `dot_local/bin/toggle-theme.sh` with:

```bash
# Use explicit argument if provided (dark|light), otherwise toggle
if [[ "${1:-}" == "dark" || "${1:-}" == "light" ]]; then
    next="$1"
else
    next=$([[ "$current" == "dark" ]] && echo "light" || echo "dark")
fi

temporary=$(mktemp "${STATE}.tmp.XXXXXX")
trap 'rm -f -- "$temporary"' EXIT
printf '%s\n' "$next" > "$temporary"
mv -f -- "$temporary" "$STATE"
trap - EXIT

[[ "$next" == "$current" ]] && exit 0
```

This writes valid state even when `current` is the implicit default. Keep the existing tmux style branches unchanged.

- [ ] **Step 4: Ensure attachment sync always delegates valid values**

Reduce the state comparison in `dot_local/bin/sync-terminal-theme.sh` to:

```bash
# LC_TERMINAL_THEME is imported into the tmux environment via update-environment
env_theme=$(tmux show-environment LC_TERMINAL_THEME 2>/dev/null | sed 's/^LC_TERMINAL_THEME=//')

[[ "$env_theme" == "dark" || "$env_theme" == "light" ]] || exit 0

~/.local/bin/toggle-theme.sh "$env_theme"
```

Remove the unused `STATE` and `current` variables. The toggle helper owns state comparison and repair.

- [ ] **Step 5: Run focused and shell validation**

```bash
node --test --test-name-pattern='canonical state|client attachment creates' tests/provisioning.test.mjs
shellcheck -x dot_local/bin/toggle-theme.sh dot_local/bin/sync-terminal-theme.sh
git diff --check
```

Expected: both Node tests pass, ShellCheck reports no findings, and the diff has no whitespace errors.

- [ ] **Step 6: Commit the shell state contract**

```bash
git add tests/provisioning.test.mjs dot_local/bin/toggle-theme.sh dot_local/bin/sync-terminal-theme.sh
git commit -S -m "fix: persist terminal theme state"
git log -1 --show-signature --format='%h %G? %s'
```

Expected: a good SSH signature.

---

### Task 2: Add the independently testable theme-state source

**Files:**
- Create: `pi-theme-sync/package.json`
- Create: `pi-theme-sync/src/theme-state.ts`
- Create: `pi-theme-sync/tests/theme-state.test.mjs`

**Interfaces:**
- Produces: `Appearance = "light" | "dark"`, `parseAppearance(value)`, `resolveThemeStatePath(env)`, `readAppearance(path)`, `resolveInitialAppearance(path, env, read?)`, and `watchAppearance(path, current, onAppearance, dependencies?) => () => void`.
- Consumes: only Node built-ins for production and `jiti` for TypeScript tests.

- [ ] **Step 1: Create the package manifest**

Create `pi-theme-sync/package.json`:

```json
{
  "name": "pi-theme-sync",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "test": "node --test tests/*.test.mjs"
  },
  "keywords": [
    "pi-package",
    "theme"
  ],
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "devDependencies": {
    "jiti": "2.7.0"
  },
  "pi": {
    "extensions": [
      "./extensions/theme-sync.ts"
    ]
  }
}
```

The extension path may not exist until Task 3; Task 2 tests import only `src/theme-state.ts`.

- [ ] **Step 2: Write failing state-resolution and watcher tests**

Create `pi-theme-sync/tests/theme-state.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const state = await jiti.import('../src/theme-state.ts');

test('appearance parser accepts only trimmed light and dark', () => {
  assert.equal(state.parseAppearance(' light\n'), 'light');
  assert.equal(state.parseAppearance('dark'), 'dark');
  for (const value of [undefined, '', 'sepia', 'LIGHT', 'dark mode']) {
    assert.equal(state.parseAppearance(value), undefined);
  }
});

test('state path honors XDG_STATE_HOME and otherwise HOME', () => {
  assert.equal(state.resolveThemeStatePath({ XDG_STATE_HOME: '/xdg', HOME: '/home/test' }), '/xdg/theme');
  assert.equal(state.resolveThemeStatePath({ XDG_STATE_HOME: '', HOME: '/home/test' }), '/home/test/.local/state/theme');
});

test('initial appearance prefers state then environment then dark', () => {
  assert.equal(state.resolveInitialAppearance('/state', { LC_TERMINAL_THEME: 'dark' }, () => 'light\n'), 'light');
  assert.equal(state.resolveInitialAppearance('/state', { LC_TERMINAL_THEME: 'light' }, () => undefined), 'light');
  assert.equal(state.resolveInitialAppearance('/state', { LC_TERMINAL_THEME: 'sepia' }, () => 'invalid'), 'dark');
});

test('watcher emits valid changes once and cleanup unregisters its listener', () => {
  let value = 'light\n';
  let listener;
  let unwatched;
  let unwatchCount = 0;
  const changes = [];
  const dependencies = {
    read: () => value,
    watch(_path, candidate) { listener = candidate; },
    unwatch(path, candidate) { unwatchCount += 1; unwatched = { path, candidate }; },
  };

  const close = state.watchAppearance('/state/theme', 'light', value => changes.push(value), dependencies);
  value = 'sepia\n'; listener();
  value = 'dark\n'; listener();
  listener();
  value = ''; listener();
  value = 'light\n'; listener();

  assert.deepEqual(changes, ['dark', 'light']);
  close();
  close();
  assert.equal(unwatchCount, 1);
  assert.deepEqual(unwatched, { path: '/state/theme', candidate: listener });
});
```

- [ ] **Step 3: Run the focused package test and confirm RED**

```bash
node --test pi-theme-sync/tests/theme-state.test.mjs
```

Expected: FAIL because `pi-theme-sync/src/theme-state.ts` does not exist.

- [ ] **Step 4: Implement the minimal state source**

Create `pi-theme-sync/src/theme-state.ts`:

```ts
import { readFileSync, unwatchFile, watchFile } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Appearance = "light" | "dark";

type WatchListener = () => void;

export interface WatchDependencies {
	read(path: string): string | undefined;
	watch(path: string, listener: WatchListener): void;
	unwatch(path: string, listener: WatchListener): void;
}

export function parseAppearance(value: unknown): Appearance | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized === "light" || normalized === "dark" ? normalized : undefined;
}

export function resolveThemeStatePath(env: NodeJS.ProcessEnv = process.env): string {
	const stateHome = env.XDG_STATE_HOME?.trim();
	if (stateHome) return join(stateHome, "theme");
	const home = env.HOME?.trim() || homedir();
	return join(home, ".local", "state", "theme");
}

export function readAppearance(path: string): Appearance | undefined {
	try {
		return parseAppearance(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

export function resolveInitialAppearance(
	path: string,
	env: NodeJS.ProcessEnv = process.env,
	read: (path: string) => unknown = readAppearance,
): Appearance {
	return parseAppearance(read(path)) ?? parseAppearance(env.LC_TERMINAL_THEME) ?? "dark";
}

const defaultWatchDependencies: WatchDependencies = {
	read: path => {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return undefined;
		}
	},
	watch: (path, listener) => watchFile(path, { interval: 200, persistent: false }, listener),
	unwatch: (path, listener) => unwatchFile(path, listener),
};

export function watchAppearance(
	path: string,
	current: Appearance,
	onAppearance: (appearance: Appearance) => void,
	dependencies: WatchDependencies = defaultWatchDependencies,
): () => void {
	let lastAppearance = current;
	let closed = false;
	const listener = () => {
		const nextAppearance = parseAppearance(dependencies.read(path));
		if (!nextAppearance || nextAppearance === lastAppearance) return;
		lastAppearance = nextAppearance;
		onAppearance(nextAppearance);
	};
	dependencies.watch(path, listener);
	return () => {
		if (closed) return;
		closed = true;
		dependencies.unwatch(path, listener);
	};
}
```

- [ ] **Step 5: Run the focused tests and whitespace check**

```bash
node --test pi-theme-sync/tests/theme-state.test.mjs
git diff --check
```

Expected: all four focused tests pass and the diff has no whitespace errors. The root workspace and lockfile are updated together in Task 4.

- [ ] **Step 6: Commit the state source**

```bash
git add pi-theme-sync/package.json pi-theme-sync/src/theme-state.ts pi-theme-sync/tests/theme-state.test.mjs
git commit -S -m "feat: add terminal theme state source"
git log -1 --show-signature --format='%h %G? %s'
```

Expected: a good SSH signature.

---

### Task 3: Implement Pi lifecycle synchronization with Theme objects

**Files:**
- Create: `pi-theme-sync/extensions/theme-sync.ts`
- Create: `pi-theme-sync/tests/theme-sync.test.mjs`

**Interfaces:**
- Consumes from Task 2: `Appearance`, `resolveThemeStatePath()`, `resolveInitialAppearance()`, and `watchAppearance()`.
- Produces: default Pi extension factory and named `registerThemeSync(pi, dependencies?)` test seam.
- Pi UI contract: `ctx.ui.getTheme("light" | "dark")` loads a built-in theme; `ctx.ui.setTheme(themeObject)` changes only the current process and returns `{ success: boolean; error?: string }`.

- [ ] **Step 1: Write failing extension lifecycle tests**

Create `pi-theme-sync/tests/theme-sync.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const extension = await jiti.import('../extensions/theme-sync.ts');

function setup({ mode = 'tui', initial = 'light', missingTheme, setThemeError } = {}) {
  const events = new Map();
  const applied = [];
  const notifications = [];
  const themes = { light: { name: 'light-object' }, dark: { name: 'dark-object' } };
  let watched;
  let stopped = 0;
  extension.registerThemeSync(
    { on(name, handler) { events.set(name, handler); } },
    {
      resolveStatePath: () => '/state/theme',
      resolveInitial: () => initial,
      watch(path, current, onAppearance) {
        watched = { path, current, onAppearance };
        let closed = false;
        return () => { if (!closed) { closed = true; stopped += 1; } };
      },
    },
  );
  const ctx = {
    mode,
    ui: {
      getTheme(name) { return name === missingTheme ? undefined : themes[name]; },
      setTheme(theme) {
        applied.push(theme);
        return setThemeError ? { success: false, error: setThemeError } : { success: true };
      },
      notify(message, level) { notifications.push({ message, level }); },
    },
  };
  return { events, ctx, applied, notifications, themes, watched: () => watched, stopped: () => stopped };
}

test('startup applies a loaded Theme object and live changes rerender once', async () => {
  const f = setup({ initial: 'light' });
  await f.events.get('session_start')({ reason: 'startup' }, f.ctx);
  assert.equal(f.applied[0], f.themes.light);
  assert.deepEqual(f.watched(), { path: '/state/theme', current: 'light', onAppearance: f.watched().onAppearance });

  f.watched().onAppearance('dark');
  f.watched().onAppearance('dark');
  assert.deepEqual(f.applied, [f.themes.light, f.themes.dark]);
  assert.equal(f.applied.every(value => typeof value === 'object'), true);
});

test('restart and shutdown clean watchers idempotently', async () => {
  const f = setup();
  await f.events.get('session_start')({ reason: 'startup' }, f.ctx);
  await f.events.get('session_start')({ reason: 'reload' }, f.ctx);
  assert.equal(f.stopped(), 1);
  await f.events.get('session_shutdown')({ reason: 'quit' }, f.ctx);
  await f.events.get('session_shutdown')({ reason: 'quit' }, f.ctx);
  assert.equal(f.stopped(), 2);
});

test('non-TUI sessions do not resolve themes or start watchers', async () => {
  const f = setup({ mode: 'rpc' });
  await f.events.get('session_start')({ reason: 'startup' }, f.ctx);
  assert.deepEqual(f.applied, []);
  assert.equal(f.watched(), undefined);
});

test('theme load failure preserves the current theme and warns once', async () => {
  const f = setup({ initial: 'light', missingTheme: 'light' });
  await f.events.get('session_start')({ reason: 'startup' }, f.ctx);
  assert.deepEqual(f.applied, []);
  assert.deepEqual(f.notifications, [{ message: 'Unable to load Pi theme "light".', level: 'warning' }]);
});

test('theme apply failure reports the Pi error once', async () => {
  const f = setup({ initial: 'dark', setThemeError: 'render failed' });
  await f.events.get('session_start')({ reason: 'startup' }, f.ctx);
  assert.equal(f.applied[0], f.themes.dark);
  assert.deepEqual(f.notifications, [{
    message: 'Unable to apply Pi theme "dark": render failed',
    level: 'warning',
  }]);
});
```

Keep all theme values as distinguishable objects; this test must fail if the extension passes a string to `setTheme`.

- [ ] **Step 2: Run the focused extension tests and confirm RED**

```bash
node --test pi-theme-sync/tests/theme-sync.test.mjs
```

Expected: FAIL because `extensions/theme-sync.ts` does not exist.

- [ ] **Step 3: Implement the extension lifecycle**

Create `pi-theme-sync/extensions/theme-sync.ts`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type Appearance,
	resolveInitialAppearance,
	resolveThemeStatePath,
	watchAppearance,
} from "../src/theme-state.ts";

export interface ThemeSyncDependencies {
	resolveStatePath(): string;
	resolveInitial(path: string): Appearance;
	watch(
		path: string,
		current: Appearance,
		onAppearance: (appearance: Appearance) => void,
	): () => void;
}

const defaultDependencies: ThemeSyncDependencies = {
	resolveStatePath: () => resolveThemeStatePath(),
	resolveInitial: path => resolveInitialAppearance(path),
	watch: (path, current, onAppearance) => watchAppearance(path, current, onAppearance),
};

export function registerThemeSync(
	pi: ExtensionAPI,
	dependencies: ThemeSyncDependencies = defaultDependencies,
): void {
	let stopWatching: (() => void) | undefined;
	let appliedAppearance: Appearance | undefined;
	let warned = false;

	const stop = () => {
		stopWatching?.();
		stopWatching = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		stop();
		appliedAppearance = undefined;
		warned = false;
		if (ctx.mode !== "tui") return;

		const apply = (appearance: Appearance) => {
			if (appearance === appliedAppearance) return;
			const selectedTheme = ctx.ui.getTheme(appearance);
			if (!selectedTheme) {
				if (!warned) {
					warned = true;
					ctx.ui.notify(`Unable to load Pi theme "${appearance}".`, "warning");
				}
				return;
			}
			const result = ctx.ui.setTheme(selectedTheme);
			if (!result.success) {
				if (!warned) {
					warned = true;
					ctx.ui.notify(`Unable to apply Pi theme "${appearance}": ${result.error}`, "warning");
				}
				return;
			}
			appliedAppearance = appearance;
		};

		const path = dependencies.resolveStatePath();
		const initialAppearance = dependencies.resolveInitial(path);
		apply(initialAppearance);
		stopWatching = dependencies.watch(path, initialAppearance, apply);
	});

	pi.on("session_shutdown", stop);
}

export default function themeSyncExtension(pi: ExtensionAPI): void {
	registerThemeSync(pi);
}
```

Do not replace `ctx.ui.setTheme(selectedTheme)` with a string call. The object call is the setting-preservation mechanism.

- [ ] **Step 4: Run extension and package tests**

```bash
node --test pi-theme-sync/tests/theme-sync.test.mjs
npm --prefix pi-theme-sync test
git diff --check
```

Expected: lifecycle tests and all package tests pass.

- [ ] **Step 5: Commit the extension**

```bash
git add pi-theme-sync/extensions/theme-sync.ts pi-theme-sync/tests/theme-sync.test.mjs
git commit -S -m "feat: synchronize live Pi themes"
git log -1 --show-signature --format='%h %G? %s'
```

Expected: a good SSH signature.

---

### Task 4: Wire the package into managed configuration

**Files:**
- Modify: `tests/pi-package-dependencies.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`
- Modify: `dot_pi/agent/settings.json.tmpl`
- Modify: `run_onchange_after_06-install-pi-packages.sh.tmpl`
- Modify: `scripts/check-repository.sh`
- Modify: `README.md`

**Interfaces:**
- Consumes: the `pi-theme-sync` package from Tasks 2–3.
- Produces: reproducible workspace testing/typechecking, local dependency installation, Pi resource loading from the stable chezmoi source path, and operator instructions for the one-time reload.

- [ ] **Step 1: Add failing package-integration assertions**

In `tests/pi-package-dependencies.test.mjs`, replace the `expected` object in the runtime-peer test with:

```js
const expected = {
  'pi-worktree-core/package.json': ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui'],
  'pi-worktree-manager/package.json': ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui'],
  'pi-task/package.json': ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox'],
  'pi-loop-package/package.json': ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', 'typebox'],
  'pi-claude-bridge/package.json': ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui'],
  'pi-messaging/package.json': ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox'],
  'pi-theme-sync/package.json': ['@earendil-works/pi-coding-agent'],
};
```

Also add it to the package lists in `packages with TypeScript-importing tests pin jiti as a dev dependency` and `every local Pi package has a runnable test script`.

Change the root workspace expectation to:

```js
  assert.deepEqual(root.workspaces, [
    'pi-worktree-core',
    'pi-worktree-manager',
    'pi-task',
    'pi-loop-package',
    'pi-claude-bridge',
    'pi-messaging',
    'pi-theme-sync',
  ]);
```

Extend the settings test:

```js
  assert.equal(
    settings.packages.some(source => source.endsWith('/pi-theme-sync')),
    true,
    'Pi settings should load the managed live theme package',
  );
```

Extend the installer test:

```js
  assert.match(script, /pi-theme-sync/, 'installer should include the live theme package');
```

- [ ] **Step 2: Run the focused integration tests and confirm RED**

```bash
node --test --test-name-pattern='runtime peer|TypeScript-importing|root workspace|runnable test|pi settings|package installer' tests/pi-package-dependencies.test.mjs
```

Expected: FAIL because the new package is not yet in workspaces, settings, installer, or repository checks.

- [ ] **Step 3: Add the package to workspace and TypeScript configuration**

Append `"pi-theme-sync"` to `package.json`'s `workspaces` array.

Append these entries to `tsconfig.json`'s `include` array:

```json
    "pi-theme-sync/extensions/**/*.ts",
    "pi-theme-sync/src/**/*.ts"
```

Run:

```bash
npm install --package-lock-only --ignore-scripts
```

Expected: `package-lock.json` retains the new workspace entry and remains reproducible.

- [ ] **Step 4: Add the stable managed package paths**

Add this entry to `dot_pi/agent/settings.json.tmpl`'s local package list without changing `"theme": "light/dark"`:

```json
    "{{ .chezmoi.sourceDir }}/pi-theme-sync"
```

Add the equivalent entry to `LOCAL_PACKAGES` in `run_onchange_after_06-install-pi-packages.sh.tmpl`:

```bash
  "{{ .chezmoi.sourceDir }}/pi-theme-sync"
```

Add `pi-theme-sync` to the repository-only roots checked in `scripts/check-repository.sh`:

```bash
for root in README.md package.json package-lock.json tsconfig.json docs tests scripts pi-claude-bridge pi-loop-package pi-task pi-theme-sync pi-worktree-core pi-worktree-manager; do
```

- [ ] **Step 5: Document live Pi verification and rollout**

Extend README's `Verify the terminal theme` section after the Neovim paragraph:

````markdown
Pi follows the same account-wide state after the theme-sync package is installed. Existing Pi processes need one human-controlled `/reload`; subsequent `prefix+T` or client-attachment changes update them live. Verify the canonical state without querying terminal OSC support:

```bash
cat "${XDG_STATE_HOME:-$HOME/.local/state}/theme"
```

The output should be exactly `light` or `dark` and should match tmux and Pi.
````

Do not instruct users to restart or kill Pi.

- [ ] **Step 6: Run focused integration and rendered-settings checks**

```bash
node --test --test-name-pattern='runtime peer|TypeScript-importing|root workspace|runnable test|pi settings|package installer' tests/pi-package-dependencies.test.mjs
npm run typecheck
chezmoi --source "$PWD" cat ~/.pi/agent/settings.json | python3 -c '
import json, sys
settings = json.load(sys.stdin)
assert settings["theme"] == "light/dark"
assert any(source.endswith("/pi-theme-sync") for source in settings["packages"])
'
git diff --check
```

Expected: focused tests and TypeScript pass; rendered settings retain automatic fallback and contain the stable source-tree package path; no settings contents are printed.

- [ ] **Step 7: Commit managed package integration**

```bash
git add tests/pi-package-dependencies.test.mjs package.json package-lock.json tsconfig.json dot_pi/agent/settings.json.tmpl run_onchange_after_06-install-pi-packages.sh.tmpl scripts/check-repository.sh README.md
git commit -S -m "chore: install Pi theme synchronization"
git log -1 --show-signature --format='%h %G? %s'
```

Expected: a good SSH signature.

---

### Task 5: Verify the complete behavior and prepare safe rollout

**Files:**
- Verify only: all files changed in Tasks 1–4

**Interfaces:**
- Consumes: canonical shell state, `pi-theme-sync`, managed settings, and repository validation.
- Produces: evidence that the branch is safe to merge and exact post-merge instructions; it does not touch live Pi sessions.

- [ ] **Step 1: Run the full automated test suite**

```bash
npm test
```

Expected: root provisioning tests and every workspace test, including `pi-theme-sync`, pass with zero failures or skips attributable to this change.

- [ ] **Step 2: Run static and repository checks**

```bash
npm run typecheck
npm run lint:shell
npm run check
git diff --check
```

Expected: TypeScript, ShellCheck, chezmoi boundary checks, Neovim theme checks, and whitespace checks all pass.

- [ ] **Step 3: Verify managed rendering without changing installed settings**

```bash
rendered_settings=$(mktemp)
trap 'rm -f "$rendered_settings"' EXIT
chezmoi --source "$PWD" cat ~/.pi/agent/settings.json > "$rendered_settings"
python3 - "$rendered_settings" <<'PY'
import json, sys
from pathlib import Path
settings = json.loads(Path(sys.argv[1]).read_text())
assert settings.get('theme') == 'light/dark'
matching = [source for source in settings.get('packages', []) if source.endswith('/pi-theme-sync')]
assert len(matching) == 1
assert Path(matching[0]).name == 'pi-theme-sync'
print('rendered Pi theme package and fallback setting: ok')
PY
```

Expected: the validation line prints, no settings body prints, and the installed settings remain untouched. If executing from a linked worktree, do not apply this rendering because `.chezmoi.sourceDir` points at that worktree.

- [ ] **Step 4: Verify commit signatures and branch cleanliness**

```bash
git status --short --branch
git log --show-signature --format='%h %G? %s' main..HEAD
```

Expected: the implementation worktree is clean and every implementation commit reports a good signature. Account for the already committed design and plan documents when identifying the branch base.

- [ ] **Step 5: Report the human-controlled post-merge activation**

After the implementation is merged into the stable main checkout, report these steps without executing them inside an active Pi process:

```bash
cd /home/bits/go/src/github.com/DataDog/dotfiles
chezmoi apply
```

Then the human runs `/reload` once in each already-running Pi session at a safe idle boundary. New Pi sessions load the package automatically. After that one-time activation, `prefix+T` and valid client reattachments switch Pi live via the canonical state file.
