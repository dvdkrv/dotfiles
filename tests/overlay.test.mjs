import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

// Render a source template for a fresh home, optionally with overlay files.
function render(templatePath, overlay = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dotfiles-overlay-'));
  const home = join(root, 'home');
  const overlayDir = join(home, '.config', 'dotfiles-overlay');
  mkdirSync(overlayDir, { recursive: true });
  for (const [name, content] of Object.entries(overlay)) {
    writeFileSync(join(overlayDir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  const config = join(root, 'chezmoi.toml');
  writeFileSync(config, `sourceDir = ${JSON.stringify(ROOT)}\n`);
  try {
    const result = spawnSync('chezmoi', ['--config', config, '--source', ROOT, '--destination', home, '--persistent-state', join(root, 'state.boltdb'), 'execute-template'], {
      cwd: ROOT,
      env: { ...process.env, HOME: home },
      input: readFileSync(join(ROOT, templatePath), 'utf8'),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return { output: result.stdout, home };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const pi = (overlay) => JSON.parse(render('dot_pi/agent/settings.json.tmpl', overlay).output);

test('without an overlay, Pi settings hold only personal entries', () => {
  const settings = pi();
  assert.equal(settings.theme, 'system');
  assert.equal(settings.defaultProvider, undefined, 'the provider default comes from an overlay');
  assert.ok(settings.packages.length >= 3);
  assert.ok(settings.packages.every((source) => /^(git|npm):/.test(source)), 'no local or private checkouts');
});

test('an overlay adds Pi packages after personal ones, without duplicates, and its keys win', () => {
  const personal = pi();
  const settings = pi({ 'pi-settings.json': {
    packages: [personal.packages[0], 'npm:private-plugin@1.0.0'],
    defaultProvider: 'private-gateway',
    theme: 'dark',
    powerline: { preset: 'compact' },
  } });
  assert.deepEqual(settings.packages, [...personal.packages, 'npm:private-plugin@1.0.0']);
  assert.equal(settings.defaultProvider, 'private-gateway');
  assert.equal(settings.theme, 'dark');
  assert.equal(settings.powerline.preset, 'compact');
  assert.deepEqual(settings.powerline.customItems, personal.powerline.customItems, 'objects merge key by key');
});

test('zshrc sources the overlay zshrc last, when it exists', () => {
  const shell = readFileSync(join(ROOT, '.chezmoitemplates/zshrc'), 'utf8').trimEnd().split('\n');
  assert.match(shell.at(-1), /^if \[\[ -r "\$HOME\/\.config\/dotfiles-overlay\/zshrc" \]\]; then source "\$HOME\/\.config\/dotfiles-overlay\/zshrc"; fi$/);
});

test('the repository boundary check rejects employer identifiers', () => {
  const root = mkdtempSync(join(tmpdir(), 'dotfiles-boundary-'));
  try {
    const script = readFileSync(join(ROOT, 'scripts/check-repository.sh'), 'utf8');
    const boundary = script.slice(script.indexOf('# Repository boundary'), script.indexOf('# End repository boundary'));
    assert.ok(boundary.length > 0, 'the check has a repository boundary section');
    spawnSync('git', ['init', '-q'], { cwd: root });
    const word = String.fromCharCode(68, 97, 116, 97, 100, 111, 103); // spelled out so this file passes the check
    writeFileSync(join(root, 'leak.txt'), `uses ${word.toLowerCase()} config\n`);
    spawnSync('git', ['add', 'leak.txt'], { cwd: root });
    const leaking = spawnSync('bash', ['-c', `set -euo pipefail\n${boundary}`], { cwd: root, encoding: 'utf8' });
    assert.notEqual(leaking.status, 0, 'a tracked file with an employer identifier fails the check');
    writeFileSync(join(root, 'leak.txt'), 'clean\n');
    spawnSync('git', ['add', 'leak.txt'], { cwd: root });
    const clean = spawnSync('bash', ['-c', `set -euo pipefail\n${boundary}`], { cwd: root, encoding: 'utf8' });
    assert.equal(clean.status, 0, clean.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
