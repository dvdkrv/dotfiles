import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

function pkg(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const SUPERPOWERS_SOURCE = 'git:github.com/obra/superpowers@v6.2.0';

test('local pi extension packages declare runtime peer dependencies they import', () => {
  const expected = {
    'pi-worktree-core/package.json': ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui'],
    'pi-worktree-manager/package.json': ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui'],
    'pi-task/package.json': ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox'],
    'pi-loop-package/package.json': ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', 'typebox'],
    'pi-claude-bridge/package.json': ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui'],
    'pi-messaging/package.json': ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox'],
  };

  for (const [path, deps] of Object.entries(expected)) {
    const peers = pkg(path).peerDependencies ?? {};
    for (const dep of deps) {
      assert.equal(peers[dep], '*', `${path} should declare ${dep} as a peerDependency`);
    }
  }
});

test('Pi worktree consumers declare the shared core package explicitly', () => {
  for (const path of [
    'pi-worktree-manager/package.json',
    'pi-task/package.json',
    'pi-claude-bridge/package.json',
  ]) {
    assert.equal(pkg(path).dependencies?.['pi-worktree-core'], 'file:../pi-worktree-core');
  }
});

test('packages with TypeScript-importing tests pin jiti as a dev dependency', () => {
  for (const path of [
    'pi-worktree-core/package.json',
    'pi-worktree-manager/package.json',
    'pi-task/package.json',
    'pi-loop-package/package.json',
    'pi-claude-bridge/package.json',
    'pi-messaging/package.json',
  ]) {
    const devDeps = pkg(path).devDependencies ?? {};
    assert.equal(devDeps.jiti, '2.7.0', `${path} should pin jiti for tests that import TypeScript`);
  }
});

test('package-local node_modules directories are ignored', () => {
  const gitignore = readFileSync('.gitignore', 'utf8');

  assert.match(gitignore, /^node_modules\/$/m, 'package dependency installs should not dirty git with node_modules');
});

test('pi settings load the pinned native Superpowers package exactly once', () => {
  const settings = pkg('dot_pi/agent/settings.json.tmpl');

  assert.equal(
    settings.packages.filter((source) => source === SUPERPOWERS_SOURCE).length,
    1,
    'settings should contain the pinned upstream package exactly once',
  );
  assert.equal(
    settings.packages.some((source) => source.includes('pi-superpowers-package')),
    false,
    'settings should not load the removed local port',
  );
});

test('pi package installer separates local npm packages from managed git packages', () => {
  const script = readFileSync('run_onchange_after_06-install-pi-packages.sh.tmpl', 'utf8');

  assert.match(script, /LOCAL_PACKAGES=\(/, 'installer should declare local packages separately');
  assert.match(
    script,
    /SUPERPOWERS_PACKAGE="git:github\.com\/obra\/superpowers@v6\.2\.0"/,
    'installer should declare pinned upstream Superpowers separately',
  );
  assert.match(script, /npm install --omit=dev/, 'installer should install local package dependencies');
  assert.match(script, /--package-lock=false/, 'installer should avoid package-lock files');
  assert.match(script, /--legacy-peer-deps/, 'installer should use Pi-bundled peer dependencies');
  assert.match(script, /for pkg in "\$\{LOCAL_PACKAGES\[@\]\}"/, 'local loops should only receive local package paths');
  assert.match(
    script,
    /pi install "\$SUPERPOWERS_PACKAGE"/,
    'installer should reconcile the configured git package even when pi list already reports it',
  );

  const npmLoop = script.match(/for pkg in "\$\{LOCAL_PACKAGES\[@\]\}"; do([\s\S]*?)done/)?.[1] ?? '';
  assert.doesNotMatch(npmLoop, /superpowers/, 'upstream git source must not be passed to npm --prefix');
});

test('shell environment disables optional Superpowers visual telemetry', () => {
  const shell = readFileSync('.chezmoitemplates/zshrc', 'utf8');

  assert.match(shell, /^export SUPERPOWERS_DISABLE_TELEMETRY=1$/m);
});

test('root workspace defines reproducible aggregate validation', () => {
  assert.equal(existsSync('package-lock.json'), true, 'root package lock should be committed');
  const root = pkg('package.json');

  assert.deepEqual(root.workspaces, [
    'pi-worktree-core',
    'pi-worktree-manager',
    'pi-task',
    'pi-loop-package',
    'pi-claude-bridge',
    'pi-messaging',
  ]);
  for (const script of ['test', 'typecheck', 'lint:shell', 'check']) {
    assert.equal(typeof root.scripts?.[script], 'string', `root should define npm run ${script}`);
  }
  assert.match(root.devDependencies?.jiti ?? '', /^\d+\.\d+\.\d+$/);
  assert.match(root.devDependencies?.typescript ?? '', /^\d+\.\d+\.\d+$/);
});

test('every local Pi package has a runnable test script', () => {
  for (const path of [
    'pi-worktree-core/package.json',
    'pi-worktree-manager/package.json',
    'pi-task/package.json',
    'pi-loop-package/package.json',
    'pi-claude-bridge/package.json',
    'pi-messaging/package.json',
  ]) {
    assert.equal(pkg(path).scripts?.test, 'node --test tests/*.test.mjs', `${path} should run Node tests`);
  }
});

test('CI runs clean-install tests typechecking and repository checks', () => {
  const workflow = readFileSync('.github/workflows/check.yml', 'utf8');

  assert.match(workflow, /actions\/checkout@v5/);
  assert.match(workflow, /actions\/setup-node@v5/);
  for (const command of ['npm ci', 'npm test', 'npm run typecheck', 'npm run lint:shell', 'npm run check']) {
    assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('README documents canonical installation and delegation safety', () => {
  const readme = readFileSync('README.md', 'utf8');

  assert.match(readme, /\.\/install\.sh/);
  assert.match(readme, /headless Pi/i);
  assert.match(readme, /never force-removes/i);
});

test('nvim-pack-lock is the sole Neovim plugin lockfile', () => {
  assert.equal(existsSync('dot_config/nvim/nvim-pack-lock.json'), true);
  assert.equal(existsSync('dot_config/nvim/lazy-lock.json'), false);
});
