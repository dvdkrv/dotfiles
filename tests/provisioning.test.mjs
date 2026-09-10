import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

function moshAgentHarness() {
  const directory = mkdtempSync(join(tmpdir(), 'dotfiles-mosh-agent-'));
  const fakeMosh = join(directory, 'mosh');
  const fakeSsh = join(directory, 'ssh');
  const moshArgs = join(directory, 'mosh-args');
  const sshArgs = join(directory, 'ssh-args');
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
if [[ "\${FAKE_SSH_MODE:-ready}" == fail ]]; then
  exit 42
fi
printf '%s\\n' '__MOSH_AGENT_READY__'
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
    sidecarStopped,
    env: {
      ...process.env,
      MOSH_AGENT_MOSH_BIN: fakeMosh,
      MOSH_AGENT_SSH_BIN: fakeSsh,
      MOSH_AGENT_READY_TIMEOUT: '1',
      SSH_AUTH_SOCK: join(directory, 'agent.sock'),
      FAKE_MOSH_ARGS: moshArgs,
      FAKE_SSH_ARGS: sshArgs,
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

async function waitForFile(path, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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
  assert.match(ignore, /^pi-\*\/$/m);
  for (const file of ['README.md', 'package.json', 'package-lock.json', 'tsconfig.json']) {
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

  const result = runMoshAgent(harness, args);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(harness.moshArgs, 'utf8').trim().split('\n'), args);
  const sshArgs = readFileSync(harness.sshArgs, 'utf8');
  assert.match(sshArgs, /(^|\n)-A(\n|$)/);
  assert.match(sshArgs, /(^|\n)-T(\n|$)/);
  assert.match(sshArgs, /(^|\n)user@workspace-dkirov(\n|$)/);
  assert.equal(readFileSync(harness.sidecarStopped, 'utf8').trim(), 'stopped');
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
