import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const doctorScript = new URL('../doctor.sh', import.meta.url).pathname;

function writeExecutable(path, content) {
  writeFileSync(path, content, { mode: 0o755 });
}

function doctorHarness(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dotfiles-doctor-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const stateHome = join(root, 'state');
  const agentDir = join(root, 'agent');
  const sshDir = join(home, '.ssh');
  const claudeHooks = join(home, '.claude', 'hooks');
  mkdirSync(bin, { recursive: true });
  mkdirSync(stateHome, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  mkdirSync(claudeHooks, { recursive: true });
  writeExecutable(join(claudeHooks, 'ssh-agent-check.sh'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(
    join(sshDir, 'config'),
    'Host example\n  User git\n\n## BEGIN -- chezmoi\nInclude ~/.ssh/config_chezmoi\n## END -- chezmoi\n',
    { mode: 0o600 },
  );
  writeFileSync(join(sshDir, 'config_chezmoi'), 'Host github.com\n  User git\n', { mode: 0o600 });
  chmodSync(sshDir, 0o700);

  for (const command of ['brew', 'starship', 'zoxide', 'fzf', 'nvim', 'npm', 'git']) {
    writeExecutable(join(bin, command), '#!/usr/bin/env bash\nexit 0\n');
  }
  writeExecutable(join(bin, 'tmux'), `#!/usr/bin/env bash
case "\${1:-}" in
  -V)
    printf 'tmux %s\\n' "\${FAKE_TMUX_VERSION:-3.7c}"
    ;;
  list-clients)
    case "\${FAKE_TMUX_CLIENTS:-no-server}" in
      no-server) exit 1 ;;
      unknown) printf 'unknown\\n' ;;
      mixed) printf 'dark\\nunknown\\n' ;;
      light) printf 'light\\n' ;;
      dark) printf 'dark\\n' ;;
    esac
    ;;
  *) exit 0 ;;
esac
`);
  writeExecutable(join(bin, 'node'), `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf '%s\\n' "\${FAKE_NODE_VERSION:-v22.19.0}"
  exit 0
fi
exit 0
`);
  writeExecutable(join(bin, 'nats-server'), `#!/usr/bin/env bash
printf 'nats-server: v%s\\n' "\${FAKE_NATS_VERSION:-2.14.6}"
`);
  writeExecutable(join(bin, 'pi'), `#!/usr/bin/env bash
case "\${1:-}" in
  --version)
    printf '%s\\n' "\${FAKE_PI_VERSION:-0.84.1}"
    ;;
  list)
    case "\${FAKE_PI_LIST_MODE:-complete}" in
      missing-pi-tools)
        printf '%s\\n' '  git:github.com/obra/superpowers@v6.2.0'
        ;;
      missing-superpowers)
        printf '%s\\n' '  git:git@github.com:dvdkrv/pi-tools.git@v0.1.1'
        ;;
      duplicate-pi-tools)
        printf '%s\\n' \\
          '  git:git@github.com:dvdkrv/pi-tools.git@v0.1.1' \\
          '  git:git@github.com:dvdkrv/pi-tools.git@v0.1.1' \\
          '  git:github.com/obra/superpowers@v6.2.0'
        ;;
      *)
        printf '%s\\n' \\
          '  git:git@github.com:dvdkrv/pi-tools.git@v0.1.1' \\
          '  git:github.com/obra/superpowers@v6.2.0'
        ;;
    esac
    ;;
  *) exit 2 ;;
esac
`);
  writeExecutable(join(bin, 'chezmoi'), `#!/usr/bin/env bash
case "\${1:-}" in
  doctor) exit 0 ;;
  execute-template) cat ;;
  *) exit 0 ;;
esac
`);

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    XDG_STATE_HOME: stateHome,
    PI_CODING_AGENT_DIR: agentDir,
    FAKE_NODE_VERSION: 'v22.19.0',
    FAKE_NATS_VERSION: '2.14.6',
    FAKE_PI_VERSION: '0.84.1',
    FAKE_PI_LIST_MODE: 'complete',
    FAKE_TMUX_VERSION: '3.7c',
    FAKE_TMUX_CLIENTS: 'no-server',
    ...overrides,
  };
  return { root, home, stateHome, agentDir, env };
}

function runDoctor({ overrides = {}, setup } = {}) {
  const harness = doctorHarness(overrides);
  try {
    setup?.(harness);
    return spawnSync('bash', [doctorScript], { env: harness.env, encoding: 'utf8' });
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}

function outputOf(result) {
  return `${result.stdout}\n${result.stderr}`;
}

test('doctor accepts reviewed versions and warns for uninitialized optional state', () => {
  const result = runDoctor();
  const output = outputOf(result);

  assert.equal(result.status, 0, output);
  assert.match(output, /Pi.*0\.84\.1/i);
  assert.match(output, /Node.*22\.19\.0/i);
  assert.match(output, /NATS.*2\.14\.6/i);
  assert.match(output, /pi-tools.*v0\.1\.1/i);
  assert.match(output, /Superpowers.*v6\.2\.0/i);
  assert.match(output, /theme.*(?:absent|not initialized)/i);
  assert.match(output, /broker.*(?:absent|not initialized)/i);
  assert.match(output, /0 failed/);
});

for (const [name, overrides, message] of [
  ['old Pi', { FAKE_PI_VERSION: '0.82.0' }, /Pi.*0\.84\.1/i],
  ['old Node', { FAKE_NODE_VERSION: 'v22.18.0' }, /Node.*22\.19\.0/i],
  ['old NATS', { FAKE_NATS_VERSION: '2.14.5' }, /NATS.*2\.14\.6/i],
  ['wrong NATS major', { FAKE_NATS_VERSION: '3.0.0' }, /NATS.*major.*2/i],
  ['missing Pi tools', { FAKE_PI_LIST_MODE: 'missing-pi-tools' }, /pi-tools.*v0\.1\.1/i],
  ['missing Superpowers', { FAKE_PI_LIST_MODE: 'missing-superpowers' }, /Superpowers.*v6\.2\.0/i],
  ['duplicate Pi tools', { FAKE_PI_LIST_MODE: 'duplicate-pi-tools' }, /pi-tools.*exactly once/i],
]) {
  test(`doctor rejects ${name}`, () => {
    const result = runDoctor({ overrides });
    assert.notEqual(result.status, 0, outputOf(result));
    assert.match(outputOf(result), message);
  });
}

test('doctor rejects tmux older than 3.7', () => {
  const result = runDoctor({ overrides: { FAKE_TMUX_VERSION: '3.6a' } });
  assert.notEqual(result.status, 0, outputOf(result));
  assert.match(outputOf(result), /tmux.*3\.7/i);
});

test('doctor warns when an attached tmux client has not reported a theme', () => {
  const result = runDoctor({ overrides: { FAKE_TMUX_CLIENTS: 'mixed' } });
  assert.equal(result.status, 0, outputOf(result));
  assert.match(outputOf(result), /tmux.*client.*theme.*unknown/i);
});

test('doctor accepts a reported tmux client theme', () => {
  const result = runDoctor({ overrides: { FAKE_TMUX_CLIENTS: 'dark' } });
  assert.equal(result.status, 0, outputOf(result));
  assert.match(outputOf(result), /tmux.*client.*theme.*dark/i);
  assert.doesNotMatch(outputOf(result), /theme.*unknown/i);
});

test('doctor accepts a valid theme and warns for a stopped recorded broker', () => {
  const result = runDoctor({
    setup({ stateHome, agentDir }) {
      writeFileSync(join(stateHome, 'theme'), 'light\n');
      const messaging = join(agentDir, 'messaging');
      mkdirSync(join(messaging, 'data'), { recursive: true, mode: 0o700 });
      writeFileSync(join(messaging, 'broker-process.json'), '{"pid":99999999}\n', { mode: 0o600 });
      chmodSync(messaging, 0o700);
    },
  });

  assert.equal(result.status, 0, outputOf(result));
  assert.match(outputOf(result), /broker.*not running/i);
});

test('doctor rejects an invalid present theme', () => {
  const result = runDoctor({
    setup({ stateHome }) {
      writeFileSync(join(stateHome, 'theme'), 'sepia\n');
    },
  });

  assert.notEqual(result.status, 0, outputOf(result));
  assert.match(outputOf(result), /theme.*light.*dark/i);
});

test('doctor rejects malformed broker metadata without exposing private configuration', () => {
  const sentinel = 'DO_NOT_PRINT_PRIVATE_TOKEN';
  const result = runDoctor({
    setup({ agentDir }) {
      const messaging = join(agentDir, 'messaging');
      mkdirSync(join(messaging, 'data'), { recursive: true, mode: 0o700 });
      writeFileSync(join(messaging, 'config.json'), `{"token":"${sentinel}"}\n`, { mode: 0o600 });
      writeFileSync(join(messaging, 'broker-process.json'), '{"pid":"wrong"}\n', { mode: 0o600 });
      chmodSync(messaging, 0o700);
    },
  });
  const output = outputOf(result);

  assert.notEqual(result.status, 0, output);
  assert.match(output, /broker.*metadata/i);
  assert.doesNotMatch(output, new RegExp(sentinel));
});

test('doctor rejects unsafe messaging permissions', () => {
  const result = runDoctor({
    setup({ agentDir }) {
      const messaging = join(agentDir, 'messaging');
      mkdirSync(messaging, { recursive: true, mode: 0o700 });
      writeFileSync(join(messaging, 'config.json'), '{}\n', { mode: 0o644 });
      chmodSync(messaging, 0o700);
    },
  });

  assert.notEqual(result.status, 0, outputOf(result));
  assert.match(outputOf(result), /config\.json.*0600/i);
});

test('doctor rejects malformed SSH management boundaries', () => {
  const result = runDoctor({
    setup({ home }) {
      writeFileSync(join(home, '.ssh', 'config'), '## BEGIN -- chezmoi\n', { mode: 0o600 });
    },
  });

  assert.notEqual(result.status, 0, outputOf(result));
  assert.match(outputOf(result), /SSH.*marker/i);
});

test('doctor rejects unsafe SSH configuration permissions', () => {
  const result = runDoctor({
    setup({ home }) {
      chmodSync(join(home, '.ssh', 'config'), 0o644);
    },
  });

  assert.notEqual(result.status, 0, outputOf(result));
  assert.match(outputOf(result), /SSH.*config.*0600/i);
});
