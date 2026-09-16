import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function repositoryFile(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

const sshScript = new URL('../run_after_05-manage-ssh-config-block.sh.tmpl', import.meta.url).pathname;

function temporaryHome(config) {
  const home = mkdtempSync(join(tmpdir(), 'dotfiles-provisioning-'));
  mkdirSync(join(home, '.ssh'));
  writeFileSync(join(home, '.ssh', 'config'), config, 'utf8');
  return home;
}

function runSshManager(home) {
  return spawnSync('bash', [sshScript], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
}

function writeExecutable(path, content) {
  writeFileSync(path, content, { mode: 0o755 });
}

const toggleThemeScript = new URL('../dot_local/bin/executable_toggle-theme.sh', import.meta.url).pathname;
const syncTerminalThemeScript = new URL('../dot_local/bin/executable_sync-terminal-theme.sh', import.meta.url).pathname;

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
  writeExecutable(join(localBin, 'toggle-theme.sh'), repositoryFile('dot_local/bin/executable_toggle-theme.sh'));
  writeExecutable(join(bin, 'tmux'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TMUX_LOG"
if [[ "$1" == "show-environment" ]]; then
  printf 'LC_TERMINAL_THEME=%s\\n' "$TMUX_THEME"
fi
if [[ -n "\${TMUX_FAIL_MATCH:-}" && "$*" == *"$TMUX_FAIL_MATCH"* ]]; then
  exit 71
fi
`);
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: stateHome,
    PATH: `${bin}:/usr/bin:/bin`,
    TMUX_LOG: tmuxLog,
    TMUX_THEME: clientTheme,
    TMUX_FAIL_MATCH: '',
  };
  return { root, stateHome, env, stateFile: join(stateHome, 'theme'), tmuxLog };
}

function tmuxThemeHarness() {
  const root = mkdtempSync(join(tmpdir(), 'dotfiles-tmux-theme-'));
  const home = join(root, 'home');
  const stateHome = join(root, 'state');
  const localBin = join(home, '.local', 'bin');
  const socket = `dotfiles-theme-${process.pid}-${Date.now()}-${Math.random()}`;
  mkdirSync(localBin, { recursive: true });
  mkdirSync(stateHome, { recursive: true });
  writeExecutable(join(localBin, 'toggle-theme.sh'), repositoryFile('dot_local/bin/executable_toggle-theme.sh'));
  writeExecutable(join(localBin, 'sync-terminal-theme.sh'), repositoryFile('dot_local/bin/executable_sync-terminal-theme.sh'));
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: stateHome };
  const run = (...args) => spawnSync('tmux', ['-L', socket, ...args], { env, encoding: 'utf8' });
  return { root, home, stateHome, stateFile: join(stateHome, 'theme'), socket, run };
}

test('chezmoi excludes repository-only roots from the home target state', () => {
  const ignore = readFileSync(new URL('../.chezmoiignore', import.meta.url), 'utf8');

  assert.match(ignore, /^docs\/$/m);
  assert.match(ignore, /^tests\/$/m);
  assert.match(ignore, /^scripts\/$/m);
  assert.doesNotMatch(ignore, /^pi-\*\/$/m);
  assert.doesNotMatch(ignore, /^tsconfig\.json$/m);
  for (const file of ['README.md', 'package.json', 'package-lock.json']) {
    assert.match(ignore, new RegExp(`^${file.replace('.', '\\.')}$`, 'm'));
  }
  assert.match(ignore, /\{\{ if \(index \. "work"\) -\}\}/);
  assert.doesNotMatch(ignore, /default false \.work/);
});

test('ssh config manager rejects an unmatched marker without changing the file', () => {
  const original = [
    'Host github.com',
    '  User git',
    '## BEGIN -- chezmoi',
    'Include old',
    'Host critical.example',
    '  IdentityFile ~/.ssh/critical',
    '',
  ].join('\n');
  const home = temporaryHome(original);

  const result = runSshManager(home);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unbalanced chezmoi markers/i);
  assert.equal(readFileSync(join(home, '.ssh', 'config'), 'utf8'), original);
});

test('ssh config manager atomically replaces one valid managed block', () => {
  const home = temporaryHome([
    'Host github.com',
    '  User git',
    '',
    '## BEGIN -- chezmoi',
    'Include old',
    '## END -- chezmoi',
    '',
    'Host critical.example',
    '  IdentityFile ~/.ssh/critical',
    '',
  ].join('\n'));

  const result = runSshManager(home);

  assert.equal(result.status, 0, result.stderr);
  const updated = readFileSync(join(home, '.ssh', 'config'), 'utf8');
  assert.match(updated, /Host github\.com[\s\S]*Host critical\.example/);
  assert.equal((updated.match(/## BEGIN -- chezmoi/g) ?? []).length, 1);
  assert.equal((updated.match(/## END -- chezmoi/g) ?? []).length, 1);
  assert.match(updated, /Include ~\/\.ssh\/config_chezmoi/);
  assert.doesNotMatch(updated, /Include old/);
});

test('install.sh is canonical and bootstrap.sh delegates to it', () => {
  const bootstrap = repositoryFile('bootstrap.sh');
  const install = repositoryFile('install.sh');

  assert.match(bootstrap, /exec .*install\.sh/);
  assert.match(install, /chezmoi init --source "\$DOTFILES_DIR" --apply/);
  assert.doesNotMatch(bootstrap, /Homebrew\/install/);
});

test('future provisioning omits the retired roaming-shell transport', () => {
  const removed = ['mo', 'sh'].join('');
  const packages = repositoryFile('dot_Brewfile');
  const zsh = repositoryFile('.chezmoitemplates/zshrc');
  assert.doesNotMatch(packages, new RegExp(`^brew "${removed}"$`, 'm'));
  assert.doesNotMatch(zsh, new RegExp(removed, 'i'));
  assert.equal(existsSync(new URL(`../dot_local/bin/${removed}-with-agent.sh`, import.meta.url)), false);
});

test('cross-platform package bundle provisions the Pi messaging broker', () => {
  const packages = repositoryFile('dot_Brewfile');
  assert.equal(
    packages.split(/\r?\n/).filter(line => line === 'brew "nats-server"').length,
    1,
    'nats-server should be installed exactly once through Homebrew',
  );
});

test('Pi and package installers are pinned and do not hide required failures', () => {
  const piInstaller = repositoryFile('run_onchange_after_05-install-pi.sh.tmpl');
  const packageInstaller = repositoryFile('run_onchange_after_06-install-pi-packages.sh.tmpl');
  const claudeInstaller = repositoryFile('run_onchange_after_04-install-claude-plugins.sh.tmpl');

  assert.match(piInstaller, /^PI_VERSION="0\.84\.1"$/m);
  assert.match(piInstaller, /@earendil-works\/pi-coding-agent@"\$PI_VERSION"/);
  assert.doesNotMatch(packageInstaller, /pi install .*\|\| true/);
  assert.doesNotMatch(packageInstaller, /command -v (?:pi|npm).*\|\| exit 0/);
  assert.doesNotMatch(claudeInstaller, /plugin (?:marketplace add|install).*\|\| true/);
});

test('Claude settings do not reference missing UI or bypass safety prompts', () => {
  const settings = JSON.parse(repositoryFile('dot_claude/settings.json.tmpl'));

  assert.equal(settings.statusLine, undefined);
  assert.equal(settings.sandbox.autoAllowBashIfSandboxed, false);
  assert.equal(settings.skipAutoPermissionPrompt, false);
  for (const permission of [
    'Bash(find:*)',
    'Bash(git add:*)',
    'Bash(git commit:*)',
    'Bash(git merge:*)',
    'Bash(git pull:*)',
    'Bash(git restore:*)',
  ]) {
    assert.equal(settings.permissions.allow.includes(permission), false, `${permission} should require confirmation`);
  }
});

test('zsh and tmux integrations are guarded and portable', () => {
  const zsh = repositoryFile('.chezmoitemplates/zshrc');
  const tmux = repositoryFile('dot_tmux.conf');

  assert.doesNotMatch(zsh, /export SHELL="\/usr\/bin\/zsh"/);
  for (const command of ['fzf', 'starship', 'zoxide']) {
    assert.match(zsh, new RegExp(`if command -v ${command}`));
  }
  assert.match(tmux, /set -g set-clipboard on/);
  assert.match(tmux, /copy-to-clipboard\.sh/);
  assert.doesNotMatch(tmux, /"pbcopy"/);
});

test('toggle-theme creates canonical state even when explicit dark matches the default', () => {
  const harness = themeScriptHarness('dark');
  const result = spawnSync('/bin/bash', [toggleThemeScript, 'dark'], {
    env: harness.env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(harness.stateFile, 'utf8'), 'dark\n');
  assert.match(repositoryFile('dot_local/bin/executable_toggle-theme.sh'), /mktemp/);
  assert.match(repositoryFile('dot_local/bin/executable_toggle-theme.sh'), /mv .*"\$STATE"/);
});

test('explicit theme reapplies the complete palette when canonical state already matches', () => {
  const harness = themeScriptHarness('light');
  writeFileSync(harness.stateFile, 'light\n');
  const result = spawnSync('/bin/bash', [toggleThemeScript, 'light'], {
    env: harness.env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const commands = readFileSync(harness.tmuxLog, 'utf8');
  for (const option of ['status-style', 'status-left', 'status-right', 'window-status-format', 'window-status-current-format', 'pane-border-style', 'pane-active-border-style']) {
    assert.match(commands, new RegExp(`set -g ${option}`));
  }
  assert.equal(readFileSync(harness.stateFile, 'utf8'), 'light\n');
});

test('invalid explicit theme changes neither canonical state nor tmux', () => {
  const harness = themeScriptHarness('dark');
  writeFileSync(harness.stateFile, 'dark\n');
  const result = spawnSync('/bin/bash', [toggleThemeScript, 'sepia'], {
    env: harness.env,
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(harness.stateFile, 'utf8'), 'dark\n');
  assert.equal(existsSync(harness.tmuxLog), false);
});

test('failed tmux palette does not publish a new canonical theme', () => {
  const harness = themeScriptHarness('dark');
  writeFileSync(harness.stateFile, 'dark\n');
  const result = spawnSync('/bin/bash', [toggleThemeScript, 'light'], {
    env: { ...harness.env, TMUX_FAIL_MATCH: 'status-right' },
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(harness.stateFile, 'utf8'), 'dark\n');
  assert.deepEqual(readdirSync(harness.stateHome).sort(), ['theme']);
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

test('chezmoi installs terminal theme helpers as executable files', () => {
  const root = mkdtempSync(join(tmpdir(), 'dotfiles-theme-install-'));
  const destination = join(root, 'home');
  const config = join(root, 'chezmoi.toml');
  const persistentState = join(root, 'chezmoi.boltdb');
  const repository = new URL('../', import.meta.url).pathname;
  const targets = [
    join(destination, '.local', 'bin', 'toggle-theme.sh'),
    join(destination, '.local', 'bin', 'sync-terminal-theme.sh'),
  ];
  mkdirSync(join(destination, '.local', 'bin'), { recursive: true });
  writeFileSync(config, '');

  const result = spawnSync('chezmoi', [
    '--config', config,
    '--source', repository,
    '--destination', destination,
    '--persistent-state', persistentState,
    'apply', '--force', ...targets,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  for (const target of targets) {
    assert.equal(statSync(target).mode & 0o777, 0o755, `${target} should be mode 0755`);
  }
});

test('tmux native client theme hooks publish light and dark canonical state', () => {
  const harness = tmuxThemeHarness();
  try {
    let result = harness.run('-f', '/dev/null', 'new-session', '-d', '-s', 'theme');
    assert.equal(result.status, 0, result.stderr);
    result = harness.run('source-file', new URL('../dot_tmux.conf', import.meta.url).pathname);
    assert.equal(result.status, 0, result.stderr);

    result = harness.run('set-hook', '-gR', 'client-light-theme');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(harness.stateFile, 'utf8'), 'light\n');
    assert.match(harness.run('show-options', '-gv', 'status-style').stdout, /#eff1f5/);

    result = harness.run('set-hook', '-gR', 'client-dark-theme');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(harness.stateFile, 'utf8'), 'dark\n');
    assert.match(harness.run('show-options', '-gv', 'status-style').stdout, /#1e1e2e/);
  } finally {
    harness.run('kill-server');
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test('clipboard helper uses the first supported backend', () => {
  const home = mkdtempSync(join(tmpdir(), 'dotfiles-clipboard-'));
  const bin = join(home, 'bin');
  const output = join(home, 'copied.txt');
  mkdirSync(bin);
  const backend = join(bin, 'pbcopy');
  writeFileSync(backend, '#!/usr/bin/env bash\ncat > "$OUTPUT"\n', { mode: 0o755 });
  const helper = new URL('../dot_local/bin/copy-to-clipboard.sh', import.meta.url).pathname;

  const result = spawnSync('/bin/bash', [helper], {
    input: 'portable clipboard',
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, OUTPUT: output },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, 'utf8'), 'portable clipboard');
});
