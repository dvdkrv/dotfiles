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
const RESEARCH_WEB_SOURCE = '../../dd/datadog-pi-packages/packages/research-web';
const RESEARCH_WEB_CHECKOUT = 'dd/datadog-pi-packages/packages/research-web';
const PI_TOOLS_SOURCE = 'git:git@github.com:dvdkrv/pi-tools.git@v0.1.1';
const SUPERPOWERS_SOURCE = 'git:github.com/obra/superpowers@v6.2.0';

function renderPiSettings({ withRefreshModels = false, withResearchWeb = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dotfiles-pi-settings-'));
  const home = join(root, 'home');
  const config = join(root, 'chezmoi.toml');
  const state = join(root, 'chezmoi.boltdb');
  mkdirSync(home, { recursive: true });
  if (withRefreshModels) {
    mkdirSync(join(home, REFRESH_MODELS_CHECKOUT), { recursive: true });
  }
  if (withResearchWeb) {
    mkdirSync(join(home, RESEARCH_WEB_CHECKOUT), { recursive: true });
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
  const settings = renderPiSettings();

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

const POWERLINE_SOURCE = 'npm:pi-powerline-footer@0.17.2';
const MARKDOWN_PREVIEW_SOURCE = 'npm:pi-markdown-preview@0.18.1';

test('pi settings load the pinned npm UI packages exactly once', () => {
  const settings = renderPiSettings();

  for (const [source, name] of [[POWERLINE_SOURCE, 'pi-powerline-footer'], [MARKDOWN_PREVIEW_SOURCE, 'pi-markdown-preview']]) {
    assert.equal(settings.packages.filter((entry) => entry === source).length, 1, source);
    assert.equal(settings.packages.filter((entry) => entry.includes(name)).length, 1, `${name} should be configured once`);
  }
});

test('powerline shows cache hit rate and messaging status as a segment after the built-ins', () => {
  const { powerline } = renderPiSettings();

  assert.equal(powerline.preset, 'default');
  assert.equal(powerline.cache_read.format, 'percent');
  const messages = powerline.customItems.filter((item) => item.statusKey === 'pi-messaging');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].position, 'right');
  assert.equal(messages[0].hideWhenMissing ?? true, true);
  assert.equal(powerline.layout, undefined, 'default preset order should stay intact');
});

test('pi settings load refresh-models only when its private checkout exists', () => {
  const absent = renderPiSettings();
  const present = renderPiSettings({ withRefreshModels: true });

  assert.equal(absent.packages.filter((source) => source === REFRESH_MODELS_SOURCE).length, 0);
  assert.equal(present.packages.filter((source) => source === REFRESH_MODELS_SOURCE).length, 1);
});

test('pi settings load research-web only when its private checkout exists', () => {
  const absent = renderPiSettings({ withRefreshModels: true });
  const present = renderPiSettings({ withResearchWeb: true });
  const both = renderPiSettings({ withRefreshModels: true, withResearchWeb: true });

  assert.equal(absent.packages.filter((source) => source === RESEARCH_WEB_SOURCE).length, 0);
  assert.equal(present.packages.filter((source) => source === RESEARCH_WEB_SOURCE).length, 1);
  assert.equal(present.packages.filter((source) => source === REFRESH_MODELS_SOURCE).length, 0);
  assert.deepEqual(both.packages.slice(-2), [REFRESH_MODELS_SOURCE, RESEARCH_WEB_SOURCE]);
});

test('pi package installer reconciles only signed git packages', () => {
  const script = readFileSync('run_onchange_after_06-install-pi-packages.sh.tmpl', 'utf8');

  assert.match(script, /PI_TOOLS_PACKAGE="git:git@github\.com:dvdkrv\/pi-tools\.git@v0\.1\.1"/);
  assert.match(script, /SUPERPOWERS_PACKAGE="git:github\.com\/obra\/superpowers@v6\.2\.0"/);
  assert.match(script, /pi install "\$PI_TOOLS_PACKAGE"/);
  assert.match(script, /pi install "\$SUPERPOWERS_PACKAGE"/);
  assert.match(script, /POWERLINE_PACKAGE="npm:pi-powerline-footer@0\.17\.2"/);
  assert.match(script, /pi install "\$POWERLINE_PACKAGE"/);
  assert.match(script, /MARKDOWN_PREVIEW_PACKAGE="npm:pi-markdown-preview@0\.18\.1"/);
  assert.match(script, /pi install "\$MARKDOWN_PREVIEW_PACKAGE"/);
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
  assert.match(readme, /datadog-pi-packages\/packages\/refresh-models/);
  assert.match(readme, /\/refresh-models/);
  assert.match(readme, /checkout.*not.*clone|does not clone.*checkout/i);
  assert.match(readme, /\/reload/);
});

test('nvim-pack-lock is the sole Neovim plugin lockfile', () => {
  assert.equal(existsSync('dot_config/nvim/nvim-pack-lock.json'), true);
  assert.equal(existsSync('dot_config/nvim/lazy-lock.json'), false);
});
