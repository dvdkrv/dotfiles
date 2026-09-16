import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

function pkg(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const PI_TOOLS_SOURCE = 'git:git@github.com:dvdkrv/pi-tools.git@v0.1.1';
const SUPERPOWERS_SOURCE = 'git:github.com/obra/superpowers@v6.2.0';

test('extracted Pi implementation and TypeScript workspace are absent', () => {
  const extracted = [
    'pi-superpowers-package',
    'pi-claude-bridge',
    'pi-loop-package',
    'pi-messaging',
    'pi-task',
    'pi-theme-sync',
    'pi-worktree-core',
    'pi-worktree-manager',
  ];
  for (const path of extracted) assert.equal(existsSync(path), false, `${path} should be extracted`);
  assert.equal(existsSync('tsconfig.json'), false, 'root TypeScript configuration should be extracted');
});

test('pi settings load the signed Pi tools release and pinned Superpowers exactly once', () => {
  const settings = pkg('dot_pi/agent/settings.json.tmpl');

  assert.equal(
    settings.theme,
    'light/dark',
    'Pi should track terminal appearance using the built-in automatic theme pair',
  );
  assert.equal(settings.packages.filter((source) => source === PI_TOOLS_SOURCE).length, 1);
  assert.equal(settings.packages.filter((source) => source === SUPERPOWERS_SOURCE).length, 1);
  assert.equal(
    settings.packages.some((source) => /pi-(worktree|task|loop|claude|messaging|theme)(?:\/|$)/.test(source)),
    false,
    'settings should not load local Pi implementation packages',
  );
});

test('pi package installer reconciles only signed git packages', () => {
  const script = readFileSync('run_onchange_after_06-install-pi-packages.sh.tmpl', 'utf8');

  assert.match(script, /PI_TOOLS_PACKAGE="git:git@github\.com:dvdkrv\/pi-tools\.git@v0\.1\.1"/);
  assert.match(script, /SUPERPOWERS_PACKAGE="git:github\.com\/obra\/superpowers@v6\.2\.0"/);
  assert.match(script, /pi install "\$PI_TOOLS_PACKAGE"/);
  assert.match(script, /pi install "\$SUPERPOWERS_PACKAGE"/);
  assert.doesNotMatch(script, /LOCAL_PACKAGES|npm install --omit=dev|--prefix "\$pkg"/);
});

test('shell environment disables optional Superpowers visual telemetry', () => {
  const shell = readFileSync('.chezmoitemplates/zshrc', 'utf8');

  assert.match(shell, /^export SUPERPOWERS_DISABLE_TELEMETRY=1$/m);
});

test('root package is configuration-only and reproducible', () => {
  assert.equal(existsSync('package-lock.json'), true, 'root package lock should be committed');
  const root = pkg('package.json');

  assert.equal(root.workspaces, undefined);
  assert.equal(root.overrides, undefined);
  assert.equal(root.scripts?.test, 'node --test tests/*.test.mjs');
  assert.equal(root.scripts?.typecheck, undefined);
  for (const dependency of [
    '@earendil-works/pi-ai',
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-tui',
    '@types/node',
    'jiti',
    'typebox',
    'typescript',
  ]) {
    assert.equal(root.devDependencies?.[dependency], undefined, `${dependency} should not remain in dotfiles`);
  }
  for (const script of ['test', 'lint:shell', 'check']) {
    assert.equal(typeof root.scripts?.[script], 'string', `root should define npm run ${script}`);
  }
});

test('CI validates configuration without Pi package infrastructure', () => {
  const workflow = readFileSync('.github/workflows/check.yml', 'utf8');

  assert.match(workflow, /actions\/checkout@v5/);
  assert.match(workflow, /actions\/setup-node@v5/);
  for (const command of ['npm ci --ignore-scripts', 'npm test', 'npm run lint:shell', 'npm run check']) {
    assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(workflow, /nats-server|PI_MESSAGING_REQUIRE_BROKER|messaging-minimum-runtime|npm run typecheck/);
});

test('README documents canonical installation and delegation safety', () => {
  const readme = readFileSync('README.md', 'utf8');

  assert.match(readme, /\.\/install\.sh/);
  assert.match(readme, /headless Pi/i);
  assert.match(readme, /never force-removes/i);
  assert.doesNotMatch(readme, /local Pi packages/i);
  assert.doesNotMatch(readme, /npm run typecheck/);
  assert.doesNotMatch(readme, /`pi-\*`|`docs\/superpowers\/`/);
  assert.match(readme, /signed .*pi-tools.*v0\.1\.1/i);
});

test('nvim-pack-lock is the sole Neovim plugin lockfile', () => {
  assert.equal(existsSync('dot_config/nvim/nvim-pack-lock.json'), true);
  assert.equal(existsSync('dot_config/nvim/lazy-lock.json'), false);
});
