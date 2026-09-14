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
