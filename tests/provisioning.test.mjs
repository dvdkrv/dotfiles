import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

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

const moshAgentScript = new URL('../dot_local/bin/mosh-with-agent.sh', import.meta.url).pathname;

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

function moshAgentHarness() {
  const directory = mkdtempSync(join(tmpdir(), 'dotfiles-mosh-agent-'));
  const fakeMosh = join(directory, 'mosh');
  const fakeSsh = join(directory, 'ssh');
  const moshArgs = join(directory, 'mosh-args');
  const sshArgs = join(directory, 'ssh-args');
  const sshAttempts = join(directory, 'ssh-attempts');
  const sidecarStopped = join(directory, 'sidecar-stopped');

  writeExecutable(fakeMosh, `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$FAKE_MOSH_ARGS"
if [[ "\${FAKE_MOSH_WAIT:-0}" == 1 ]]; then
  trap 'exit 143' TERM INT HUP
  while :; do sleep 0.05; done
fi
exit "\${FAKE_MOSH_STATUS:-0}"
`);
  writeExecutable(fakeSsh, `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$FAKE_SSH_ARGS"
if [[ -f "$FAKE_SSH_ATTEMPTS" ]]; then
  attempt=$(( $(wc -l < "$FAKE_SSH_ATTEMPTS") + 1 ))
else
  attempt=1
fi
printf '%s\\n' "$attempt" >> "$FAKE_SSH_ATTEMPTS"
mode="\${FAKE_SSH_MODE:-ready}"
if [[ "$mode" == fail || ( "$mode" == drop-then-fail-once && "$attempt" == 2 ) ]]; then
  exit 42
fi
printf '%s\\n' '__MOSH_AGENT_READY__'
if [[ ( "$mode" == drop-once || "$mode" == drop-then-fail-once ) && "$attempt" == 1 ]]; then
  sleep "\${FAKE_SSH_DROP_DELAY:-0.1}"
  exit 255
fi
stopped() {
  printf '%s\\n' stopped > "$FAKE_SIDECAR_STOPPED"
  exit 0
}
trap stopped TERM INT HUP
while :; do sleep 0.05; done
`);

  return {
    moshArgs,
    sshArgs,
    sshAttempts,
    sidecarStopped,
    env: {
      ...process.env,
      MOSH_AGENT_MOSH_BIN: fakeMosh,
      MOSH_AGENT_SSH_BIN: fakeSsh,
      MOSH_AGENT_READY_TIMEOUT: '1',
      SSH_AUTH_SOCK: join(directory, 'agent.sock'),
      FAKE_MOSH_ARGS: moshArgs,
      FAKE_SSH_ARGS: sshArgs,
      FAKE_SSH_ATTEMPTS: sshAttempts,
      FAKE_SIDECAR_STOPPED: sidecarStopped,
    },
  };
}

function runMoshAgent(harness, args, env = {}) {
  return spawnSync('bash', [moshAgentScript, ...args], {
    env: { ...harness.env, ...env },
    encoding: 'utf8',
    timeout: 5000,
  });
}

async function waitForCondition(condition, description, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForFile(path, timeout = 2000) {
  await waitForCondition(() => existsSync(path), path, timeout);
}

function sshAttemptCount(harness) {
  if (!existsSync(harness.sshAttempts)) return 0;
  return readFileSync(harness.sshAttempts, 'utf8').trim().split('\n').filter(Boolean).length;
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
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

test('cross-platform package bundle provisions mosh', () => {
  const packages = repositoryFile('dot_Brewfile');

  assert.match(packages, /^brew "mosh"$/m);
});

test('cross-platform package bundle provisions the Pi messaging broker', () => {
  const packages = repositoryFile('dot_Brewfile');
  assert.equal(
    packages.split(/\r?\n/).filter(line => line === 'brew "nats-server"').length,
    1,
    'nats-server should be installed exactly once through Homebrew',
  );
});

test('mosh agent helper bypasses ordinary hosts and preserves arguments', () => {
  const harness = moshAgentHarness();
  const args = ['example.com', '--', 'tmux', 'new', '-A', '-s', 'dev'];

  const result = runMoshAgent(harness, args);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(harness.moshArgs, 'utf8').trim().split('\n'), args);
  assert.equal(existsSync(harness.sshArgs), false, 'ordinary hosts must not start a sidecar');
});

test('mosh agent helper forwards workspace agents and stops its sidecar', () => {
  const harness = moshAgentHarness();
  const args = ['-p', '60001', 'user@workspace-dkirov', '--', 'tmux', 'new', '-s', 'dev'];
  const remoteServer = '--server=PATH=/home/linuxbrew/.linuxbrew/bin:/opt/homebrew/bin:/usr/local/bin:$PATH mosh-server';

  const result = runMoshAgent(harness, args);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    readFileSync(harness.moshArgs, 'utf8').trim().split('\n'),
    [remoteServer, ...args],
  );
  const sshArgs = readFileSync(harness.sshArgs, 'utf8');
  assert.match(sshArgs, /(^|\n)-A(\n|$)/);
  assert.match(sshArgs, /(^|\n)-T(\n|$)/);
  assert.match(sshArgs, /(^|\n)ConnectTimeout=10(\n|$)/);
  assert.match(sshArgs, /(^|\n)ServerAliveInterval=15(\n|$)/);
  assert.match(sshArgs, /(^|\n)ServerAliveCountMax=3(\n|$)/);
  assert.match(sshArgs, /(^|\n)user@workspace-dkirov(\n|$)/);
  assert.equal(readFileSync(harness.sidecarStopped, 'utf8').trim(), 'stopped');
});

test('mosh agent helper preserves an explicit workspace server command', () => {
  const harness = moshAgentHarness();
  const args = ['--server', '/custom/mosh-server', 'workspace-dkirov'];

  const result = runMoshAgent(harness, args);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(harness.moshArgs, 'utf8').trim().split('\n'), args);
});

test('mosh agent helper preserves mosh failure status after cleanup', () => {
  const harness = moshAgentHarness();

  const result = runMoshAgent(harness, ['workspace-dkirov'], { FAKE_MOSH_STATUS: '23' });

  assert.equal(result.status, 23, result.stderr);
  assert.equal(readFileSync(harness.sidecarStopped, 'utf8').trim(), 'stopped');
});

test('mosh agent helper refuses to start mosh when the sidecar fails', () => {
  const harness = moshAgentHarness();

  const result = runMoshAgent(harness, ['workspace-dkirov'], { FAKE_SSH_MODE: 'fail' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SSH agent sidecar failed/i);
  assert.equal(existsSync(harness.moshArgs), false, 'mosh must not run before sidecar readiness');
});

test('mosh agent helper stops the sidecar when interrupted', async () => {
  const harness = moshAgentHarness();
  const child = spawn('bash', [moshAgentScript, 'workspace-dkirov'], {
    env: { ...harness.env, FAKE_MOSH_WAIT: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = waitForExit(child);

  await waitForFile(harness.moshArgs);
  child.kill('SIGTERM');
  const result = await exited;

  assert.notEqual(result.code, 0);
  await waitForFile(harness.sidecarStopped);
  assert.equal(readFileSync(harness.sidecarStopped, 'utf8').trim(), 'stopped');
});

test('mosh agent helper reconnects a dropped sidecar without ending mosh', async () => {
  const harness = moshAgentHarness();
  const child = spawn('bash', [moshAgentScript, 'workspace-dkirov'], {
    env: {
      ...harness.env,
      FAKE_MOSH_WAIT: '1',
      FAKE_SSH_MODE: 'drop-once',
      MOSH_AGENT_RETRY_INITIAL: '0',
      MOSH_AGENT_RETRY_MAX: '0',
      MOSH_AGENT_POLL_INTERVAL: '0.02',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = waitForExit(child);

  try {
    await waitForFile(harness.moshArgs);
    await waitForCondition(() => sshAttemptCount(harness) >= 2, 'replacement SSH sidecar');
    assert.equal(child.exitCode, null, 'mosh wrapper must remain alive during reconnection');
  } finally {
    child.kill('SIGTERM');
  }
  const result = await exited;

  assert.notEqual(result.code, 0);
  await waitForFile(harness.sidecarStopped);
});

test('mosh agent helper retries a failed replacement until it recovers', async () => {
  const harness = moshAgentHarness();
  const child = spawn('bash', [moshAgentScript, 'workspace-dkirov'], {
    env: {
      ...harness.env,
      FAKE_MOSH_WAIT: '1',
      FAKE_SSH_MODE: 'drop-then-fail-once',
      MOSH_AGENT_RETRY_INITIAL: '0',
      MOSH_AGENT_RETRY_MAX: '0',
      MOSH_AGENT_POLL_INTERVAL: '0.02',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = waitForExit(child);

  try {
    await waitForFile(harness.moshArgs);
    await waitForCondition(() => sshAttemptCount(harness) >= 3, 'recovered SSH sidecar');
    assert.equal(child.exitCode, null, 'mosh wrapper must survive failed replacement attempts');
  } finally {
    child.kill('SIGTERM');
  }
  const result = await exited;

  assert.notEqual(result.code, 0);
  await waitForFile(harness.sidecarStopped);
});

test('Pi and package installers are pinned and do not hide required failures', () => {
  const piInstaller = repositoryFile('run_onchange_after_05-install-pi.sh.tmpl');
  const packageInstaller = repositoryFile('run_onchange_after_06-install-pi-packages.sh.tmpl');
  const claudeInstaller = repositoryFile('run_onchange_after_04-install-claude-plugins.sh.tmpl');

  assert.match(piInstaller, /^PI_VERSION="0\.82\.0"$/m);
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

test('zsh routes mosh through the agent sidecar when available', () => {
  const zsh = repositoryFile('.chezmoitemplates/zshrc');

  assert.ok(zsh.includes(`if whence -p mosh >/dev/null 2>&1 && [[ -x "$HOME/.local/bin/mosh-with-agent.sh" ]]; then
  mosh() {
    "$HOME/.local/bin/mosh-with-agent.sh" "$@"
  }
fi`), 'zsh should define the guarded mosh sidecar wrapper');
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

test('tmux loads a Mosh-compatible OSC 52 clipboard capability', () => {
  const socket = `dotfiles-osc52-${process.pid}-${Date.now()}`;
  const tmuxConfig = new URL('../dot_tmux.conf', import.meta.url).pathname;
  const result = spawnSync('tmux', [
    '-L', socket,
    '-f', '/dev/null',
    'start-server', ';',
    'source-file', tmuxConfig, ';',
    'show-options', '-sv', 'terminal-overrides', ';',
    'kill-server',
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /xterm-256color:Ms=.*52;.*%p1.*%ec.*%p2/);
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
