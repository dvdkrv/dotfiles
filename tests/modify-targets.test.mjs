import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

// What chezmoi would write to `target` (relative to a fresh home) when it currently holds `current`.
export function renderTarget(target, current) {
  const root = mkdtempSync(join(tmpdir(), 'dotfiles-modify-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  if (current !== undefined) {
    mkdirSync(dirname(join(home, target)), { recursive: true });
    writeFileSync(join(home, target), current);
  }
  const config = join(root, 'chezmoi.toml');
  writeFileSync(config, `sourceDir = ${JSON.stringify(ROOT)}\n`);
  try {
    const result = spawnSync('chezmoi', ['--config', config, '--source', ROOT, '--destination', home, '--persistent-state', join(root, 'state.boltdb'), 'cat', join(home, target)], {
      cwd: ROOT,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });
    return { status: result.status, output: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function render(target, current) {
  const result = renderTarget(target, current);
  assert.equal(result.status, 0, result.stderr);
  return result.output;
}

const settings = (current) => JSON.parse(render('.pi/agent/settings.json', current));

test('Pi settings keep keys Pi adds, and managed keys win', () => {
  const fresh = settings();
  const current = { ...fresh, lastChangelogVersion: '1.0.0', theme: 'stale', powerline: { ...fresh.powerline, extra: true } };
  const updated = settings(JSON.stringify(current));
  assert.equal(updated.lastChangelogVersion, '1.0.0');
  assert.equal(updated.theme, fresh.theme);
  assert.deepEqual(updated.packages, fresh.packages);
  assert.equal(updated.powerline.extra, true);
});

test('Pi settings render unchanged output when only Pi-added keys differ (no apply prompt)', () => {
  const once = render('.pi/agent/settings.json', JSON.stringify({ lastChangelogVersion: '1.0.0' }));
  assert.equal(render('.pi/agent/settings.json', once), once);
});

test('Pi-written settings (its key order, trailing newline, an added key) are left byte for byte', () => {
  const fresh = settings();
  const piStyle = `${JSON.stringify({ ...fresh, lastChangelogVersion: '1.0.0' }, null, 2)}\n`;
  assert.equal(render('.pi/agent/settings.json', piStyle), piStyle);
});

test('invalid current Pi settings fail instead of being overwritten', () => {
  assert.notEqual(renderTarget('.pi/agent/settings.json', '{ not json').status, 0);
});

const MARKER = '# Added by other tools; chezmoi keeps lines below this marker.';
const INSTALLER_LINE = '[ -f "/opt/tool/init.zsh" ] && . "/opt/tool/init.zsh"';

test('zshrc keeps lines appended by installers below a marker, and is stable', () => {
  const managed = render('.zshrc');
  assert.doesNotMatch(managed, /Added by other tools/);
  const once = render('.zshrc', `${managed}\n${INSTALLER_LINE}\n`);
  assert.ok(once.startsWith(managed.trimEnd()), 'managed content comes first');
  assert.match(once, new RegExp(`\\n${MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n${INSTALLER_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n$`));
  assert.equal(render('.zshrc', once), once);
  const twice = render('.zshrc', `${once}echo second\n`);
  assert.match(twice, /init\.zsh"\necho second\n$/);
});

test('zshrc never moves lines edited in place; only lines after the managed content are kept', () => {
  const managed = render('.zshrc');
  const edited = managed.replace('_link="$HOME/.ssh/ssh_auth_sock"', '_link="$HOME/.ssh/edited_sock"');
  assert.notEqual(edited, managed);
  const once = render('.zshrc', `${edited}\n${INSTALLER_LINE}\n`);
  assert.equal(once, `${managed}\n${MARKER}\n${INSTALLER_LINE}\n`);
});

test('zshrc keeps a whole appended block on first apply, even lines the managed zshrc also has', () => {
  const managed = render('.zshrc');
  const block = 'if [ -f "/opt/tool/env.zsh" ]; then\n  . "/opt/tool/env.zsh"\n\n  export TOOL=1\nfi';
  const once = render('.zshrc', `${managed}\n${block}\n\n`);
  assert.equal(once, `${managed}\n${MARKER}\n${block}\n`);
  assert.equal(render('.zshrc', once), once);
});

test('zshrc drops kept lines only when they are deleted by hand', () => {
  const managed = render('.zshrc');
  const once = render('.zshrc', `${managed}\n${INSTALLER_LINE}\n`);
  assert.equal(render('.zshrc', once.replace(`${INSTALLER_LINE}\n`, '')), managed);
});

const BEGIN = '## BEGIN -- chezmoi';
const END = '## END -- chezmoi';

test('ssh config gets exactly one managed block, at the end, keeping other hosts', () => {
  const current = ['Host github.com', '  User git', '', BEGIN, 'Include old', END, '', 'Host critical.example', '  IdentityFile ~/.ssh/critical', ''].join('\n');
  const updated = render('.ssh/config', current);
  assert.match(updated, /Host github\.com[\s\S]*Host critical\.example/);
  assert.equal(updated.split(BEGIN).length - 1, 1);
  assert.match(updated, /\n\n## BEGIN -- chezmoi\nInclude ~\/\.ssh\/config_chezmoi\n## END -- chezmoi\n$/);
  assert.doesNotMatch(updated, /Include old/);
  assert.equal(render('.ssh/config', updated), updated, 'stable: no blank lines pile up');
});

test('ssh config is created with only the block when missing', () => {
  assert.equal(render('.ssh/config'), `${BEGIN}\nInclude ~/.ssh/config_chezmoi\n${END}\n`);
});

test('ssh config with unbalanced markers fails instead of being rewritten', () => {
  for (const current of [`${BEGIN}\nInclude old\nHost x\n`, `Host x\n${END}\n`, `${BEGIN}\n${BEGIN}\n${END}\n`]) {
    const result = renderTarget('.ssh/config', current);
    assert.notEqual(result.status, 0, current);
    assert.match(result.stderr, /unbalanced chezmoi markers/i);
  }
});

test('the ssh config is private', () => {
  const managed = spawnSync('chezmoi', ['--source', ROOT, 'managed', '--path-style', 'source-relative'], { encoding: 'utf8', cwd: ROOT }).stdout;
  assert.match(managed, /^private_dot_ssh\/modify_private_config$/m);
  assert.doesNotMatch(readFileSync(join(ROOT, '.chezmoiignore'), 'utf8'), /\.ssh\/config$/m);
});
