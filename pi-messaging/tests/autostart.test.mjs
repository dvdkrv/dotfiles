import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';
import { freePort } from './helpers/broker.mjs';

const jiti = createJiti(import.meta.url);
const { ensureBroker, probeBroker } = await jiti.import('../src/broker-lifecycle.ts');
const { runBroker } = await jiti.import('../src/broker.ts');
const { prepareConfig, readConfig } = await jiti.import('../src/config.ts');

const binary = process.env.NATS_SERVER || 'nats-server';
function requireBroker(t) {
  if (spawnSync(binary, ['--version']).status === 0) return true;
  if (process.env.PI_MESSAGING_REQUIRE_BROKER) throw new Error('NATS_SERVER required');
  t.skip('nats-server unavailable'); return false;
}
async function until(check, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function stopPid(pid) {
  if (!alive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  await until(() => !alive(pid), `broker ${pid} exit`);
}
async function isolatedRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-messaging-autostart-'));
  const port = await freePort();
  t.after(async () => {
    try {
      const value = JSON.parse(await readFile(join(root, 'messaging', 'broker-process.json'), 'utf8'));
      if (Number.isSafeInteger(value.pid)) await stopPid(value.pid);
    } catch {}
    await rm(root, { recursive: true, force: true });
  });
  return { root, port };
}

async function startForeign(t, root, port) {
  const config = prepareConfig(root, port);
  const foreignRoot = await mkdtemp(join(tmpdir(), 'pi-messaging-foreign-'));
  const serverFile = join(foreignRoot, 'server.json');
  await writeFile(serverFile, JSON.stringify({
    host: '127.0.0.1', port,
    authorization: { token: 'f'.repeat(64) },
    jetstream: { store_dir: join(foreignRoot, 'data') },
  }), { mode: 0o600 });
  const child = spawn(binary, ['-c', serverFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await rm(foreignRoot, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error(output || 'foreign broker timeout')), 5000);
    child.stderr.on('data', chunk => { output += chunk; if (output.includes('Server is ready')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`foreign broker exited ${code}: ${output}`)); });
  });
  return config;
}

test('healthy authenticated broker is an autostart no-op', { timeout: 15000 }, async t => {
  if (!requireBroker(t)) return;
  const { root, port } = await isolatedRoot(t);
  const foreground = await runBroker(root, binary, port); t.after(() => foreground.stop());
  const serverFile = join(root, 'messaging', 'server.json');
  const before = await stat(serverFile);
  const result = await ensureBroker({ agentDir: root, binary, port });
  assert.equal(result.state, 'running');
  assert.equal((await stat(serverFile)).mtimeMs, before.mtimeMs);
  assert.equal(await probeBroker(result.config), 'ready');
});

test('ensureBroker starts one detached private broker and validates authoritative state', { timeout: 15000 }, async t => {
  if (!requireBroker(t)) return;
  const { root, port } = await isolatedRoot(t);
  const result = await ensureBroker({ agentDir: root, binary, port });
  assert.equal(result.state, 'started');
  assert.equal(readConfig(root).initialized, true);
  for (const name of ['config.json', 'server.json', 'broker.log', 'broker-process.json']) {
    assert.equal((await stat(join(root, 'messaging', name))).mode & 0o777, 0o600, name);
  }
  const log = await readFile(join(root, 'messaging', 'broker.log'), 'utf8');
  assert.equal(log.includes(result.config.token), false);
  const processInfo = JSON.parse(await readFile(join(root, 'messaging', 'broker-process.json'), 'utf8'));
  assert.deepEqual(Object.keys(processInfo).sort(), ['pid', 'server', 'startedAt']);
  assert.equal(processInfo.server, result.config.server);
  assert.equal(alive(processInfo.pid), true);
  assert.equal(await probeBroker(result.config), 'ready');
  assert.equal((await lstat(join(root, 'messaging'))).mode & 0o777, 0o700);
});

test('missing binary and foreign authentication fail closed without replacing authority', { timeout: 15000 }, async t => {
  if (!requireBroker(t)) return;
  const first = await isolatedRoot(t);
  await assert.rejects(
    ensureBroker({ agentDir: first.root, binary: join(first.root, 'missing-nats'), port: first.port, startupTimeoutMs: 1000 }),
    /spawn|ENOENT|nats-server|binary/i,
  );
  const authority = readConfig(first.root).authorityId;
  assert.equal(readConfig(first.root).authorityId, authority);

  const second = await isolatedRoot(t);
  const config = await startForeign(t, second.root, second.port);
  await assert.rejects(
    ensureBroker({ agentDir: second.root, binary, port: second.port, startupTimeoutMs: 1000 }),
    /authentication|authorization|permissions/i,
  );
  assert.equal(readConfig(second.root).authorityId, config.authorityId);
});

test('concurrent starter processes create one broker that outlives every caller', { timeout: 30000 }, async t => {
  if (!requireBroker(t)) return;
  const { root, port } = await isolatedRoot(t);
  async function contend() {
    const child = fork(new URL('./helpers/autostart-contender.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const exit = once(child, 'exit');
    const message = new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`autostart contender exited ${code} before reporting`)));
    });
    child.send({ agentDir: root, binary, port });
    const result = await message;
    await exit;
    if (result.error) throw new Error(result.error);
    return result;
  }
  const results = await Promise.all(Array.from({ length: 8 }, () => contend()));
  assert.equal(results.filter(result => result.state === 'started').length, 1);
  assert.equal(new Set(results.map(result => result.authorityId)).size, 1);
  assert.equal((await contend()).state, 'running');
  assert.equal(await probeBroker(readConfig(root)), 'ready');
  const processInfo = JSON.parse(await readFile(join(root, 'messaging', 'broker-process.json'), 'utf8'));
  assert.equal(alive(processInfo.pid), true);
});

test('unsafe and stale startup locks are handled conservatively', { timeout: 15000 }, async t => {
  if (!requireBroker(t)) return;
  const unsafe = await isolatedRoot(t); prepareConfig(unsafe.root, unsafe.port);
  const target = join(unsafe.root, 'target'); await writeFile(target, 'not a lock', { mode: 0o600 });
  await symlink(target, join(unsafe.root, 'messaging', 'startup.lock'));
  await assert.rejects(ensureBroker({ agentDir: unsafe.root, binary, port: unsafe.port, startupTimeoutMs: 500 }), /symlink|private|lock/i);

  const stale = await isolatedRoot(t); prepareConfig(stale.root, stale.port);
  const lock = join(stale.root, 'messaging', 'startup.lock');
  await writeFile(lock, JSON.stringify({ pid: 999999, createdAt: 1 }), { mode: 0o600 });
  await utimes(lock, new Date(0), new Date(0));
  const result = await ensureBroker({ agentDir: stale.root, binary, port: stale.port, startupTimeoutMs: 1000 });
  assert.equal(result.state, 'started');
  await assert.rejects(stat(lock), /ENOENT/);

  const badMode = await isolatedRoot(t); prepareConfig(badMode.root, badMode.port);
  const badLock = join(badMode.root, 'messaging', 'startup.lock');
  await writeFile(badLock, '{}', { mode: 0o600 }); await chmod(badLock, 0o644);
  await assert.rejects(ensureBroker({ agentDir: badMode.root, binary, port: badMode.port, startupTimeoutMs: 500 }), /private|permissions/i);
});
