import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// The SSH agent block of the shared zshrc template, run on its own in zsh.
const template = readFileSync(new URL('../.chezmoitemplates/zshrc', import.meta.url), 'utf8');
const start = template.indexOf('# Stable SSH agent socket');
const end = template.indexOf('unfunction _agent_alive');
assert.ok(start >= 0 && end > start, 'the zshrc template has the SSH agent block');
const block = template.slice(start, template.indexOf('\n', end) + 1);

function harness(t) {
  // Under /tmp/ssh-*, like sockets that sshd forwards.
  const root = mkdtempSync('/tmp/ssh-dotfiles-test-');
  const home = join(root, 'home');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  const agents = [];
  t.after(() => {
    for (const pid of agents) try { process.kill(pid); } catch { /* already gone */ }
    rmSync(root, { recursive: true, force: true });
  });
  const live = (name) => {
    const sock = join(root, `agent.${name}`);
    const out = spawnSync('ssh-agent', ['-a', sock], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    agents.push(Number(out.stdout.match(/SSH_AGENT_PID=(\d+)/)[1]));
    return sock;
  };
  const dead = (name) => join(root, `agent.${name}`); // never created: its login has ended
  const link = join(home, '.ssh', 'ssh_auth_sock');
  const run = (inherited) => {
    const env = { HOME: home, PATH: process.env.PATH, ...(inherited ? { SSH_AUTH_SOCK: inherited } : {}) };
    const out = spawnSync('zsh', ['-f', '-c', `${block}\nprint -r -- "$SSH_AUTH_SOCK"`], { env, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  };
  return { live, dead, link, run };
}

test('a new login with a live agent takes over a missing or dead link', (t) => {
  const h = harness(t);
  const agent = h.live('login');
  assert.equal(h.run(agent), h.link);
  assert.equal(readlinkSync(h.link), agent);
  rmSync(h.link);
  symlinkSync(h.dead('ended'), h.link);
  const next = h.live('next');
  assert.equal(h.run(next), h.link);
  assert.equal(readlinkSync(h.link), next);
});

test('a live link is kept when a new login arrives (e.g. a long-lived tunnel session)', (t) => {
  const h = harness(t);
  const tunnel = h.live('tunnel');
  symlinkSync(tunnel, h.link);
  assert.equal(h.run(h.live('login')), h.link);
  assert.equal(readlinkSync(h.link), tunnel);
});

test('symlinked sockets are never linked, so the link cannot loop', (t) => {
  const h = harness(t);
  const agent = h.live('real');
  const alias = h.dead('alias');
  symlinkSync(agent, alias);
  assert.equal(h.run(alias), h.link);
  assert.equal(readlinkSync(h.link), agent, 'the fallback picks the real socket, not the symlink');
});

test('a shell that inherited a dead agent keeps the live link', (t) => {
  const h = harness(t);
  const current = h.live('current');
  symlinkSync(current, h.link);
  assert.equal(h.run(h.dead('ended')), h.link);
  assert.equal(readlinkSync(h.link), current);
});

test('a dead link moves to another live forwarded agent', (t) => {
  const h = harness(t);
  symlinkSync(h.dead('ended'), h.link);
  h.live('other');
  assert.equal(h.run(h.link), h.link);
  const target = readlinkSync(h.link);
  assert.match(target, /^\/tmp\/ssh-[^/]+\/agent\.[^/]+$/);
  const probe = spawnSync('ssh-add', ['-l'], { env: { ...process.env, SSH_AUTH_SOCK: target } });
  assert.notEqual(probe.status, 2, 'the link points at an agent that answers');
});
