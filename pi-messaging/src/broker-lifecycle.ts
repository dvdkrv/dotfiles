import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { BrokerConfig } from './contracts.ts';
import { defaultAgentDir, markInitialized, messagingDir, prepareConfig, privatePath, readConfig, validateConfig } from './config.ts';
import { connectBackend } from './nats-backend.ts';
import { fail, safeText } from './policy.ts';

export interface EnsureBrokerOptions {
  agentDir?: string;
  binary?: string;
  port?: number;
  probeTimeoutMs?: number;
  startupTimeoutMs?: number;
}
export type BrokerReadiness = 'ready' | 'unavailable';

const unavailablePattern = /ECONNREFUSED|connection refused|TIMEOUT|timed out|no servers available/i;

function writePrivate(path: string, value: string): void {
  if (existsSync(path)) privatePath(path, false);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, value); } finally { closeSync(fd); }
}

function writePrivateJson(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); } finally { closeSync(fd); }
  if (existsSync(path)) privatePath(path, false);
  renameSync(temp, path);
}

export function writeServerConfig(agentDir: string, config: BrokerConfig): string {
  validateConfig(config);
  const dir = messagingDir(agentDir); const data = join(dir, 'data');
  if (!existsSync(data)) mkdirSync(data, { mode: 0o700 });
  privatePath(data, true);
  const file = join(dir, 'server.json');
  writePrivate(file, JSON.stringify({
    host: '127.0.0.1',
    port: Number(new URL(config.server).port),
    authorization: { token: config.token },
    max_payload: 4 * 1024 * 1024,
    jetstream: { store_dir: data, max_file_store: 128 * 1024 * 1024, sync_interval: 'always' },
  }));
  return file;
}

function isUnavailable(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return unavailablePattern.test(text);
}

export async function probeBroker(config: BrokerConfig, timeoutMs = 500): Promise<BrokerReadiness> {
  validateConfig(config);
  try {
    const backend = await connectBackend(config, { timeoutMs });
    await backend.close();
    return 'ready';
  } catch (error) {
    if (isUnavailable(error)) return 'unavailable';
    throw error;
  }
}

async function probeAt(agentDir: string, config: BrokerConfig, timeoutMs: number): Promise<BrokerReadiness> {
  if (config.initialized) return probeBroker(config, timeoutMs);
  try {
    const backend = await connectBackend(config, { initialize: true, timeoutMs });
    await backend.close();
    markInitialized(agentDir, config);
    return 'ready';
  } catch (error) {
    if (isUnavailable(error)) return 'unavailable';
    throw error;
  }
}

function loadOrCreateConfig(agentDir: string, port: number | undefined): BrokerConfig {
  try {
    const config = readConfig(agentDir);
    if (port !== undefined && Number(new URL(config.server).port) !== port) fail('configuration', 'Existing broker uses a different port; use its configured port');
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const dir = join(agentDir, 'messaging');
    if (existsSync(join(dir, 'data')) || existsSync(join(dir, 'server.json'))) fail('configuration', 'Messaging configuration is missing while broker state exists; refusing replacement authority');
    return prepareConfig(agentDir, port ?? 4223);
  }
}

function lockAge(path: string): number {
  privatePath(path, false);
  return Date.now() - statSync(path).mtimeMs;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try { child.kill('SIGTERM'); } catch { return; }
  const graceful = await Promise.race([exited.then(() => true), delay(3000).then(() => false)]);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); } catch { return; }
    await exited;
  }
}

async function waitForReady(agentDir: string, child: ChildProcess, timeoutMs: number, probeTimeoutMs: number): Promise<BrokerConfig> {
  const failure = new Promise<never>((_, reject) => {
    child.once('error', error => reject(new Error(`Could not spawn nats-server: ${safeText(error.message)}`)));
    child.once('exit', code => reject(new Error(`nats-server exited (${code ?? 1}) before readiness`)));
  });
  const ready = (async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const config = readConfig(agentDir);
      if (await probeAt(agentDir, config, probeTimeoutMs) === 'ready') return readConfig(agentDir);
      await delay(50);
    }
    throw new Error('Messaging broker startup timed out');
  })();
  return Promise.race([ready, failure]);
}

export async function ensureBroker(options: EnsureBrokerOptions = {}): Promise<{ state: 'running' | 'started'; config: BrokerConfig }> {
  const agentDir = options.agentDir ?? defaultAgentDir();
  const binary = options.binary ?? process.env.NATS_SERVER ?? 'nats-server';
  const probeTimeoutMs = options.probeTimeoutMs ?? 500;
  const startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
  if (!Number.isFinite(probeTimeoutMs) || probeTimeoutMs < 50 || !Number.isFinite(startupTimeoutMs) || startupTimeoutMs < 250) fail('validation', 'Invalid broker startup timeout');
  let config = loadOrCreateConfig(agentDir, options.port);
  if (await probeAt(agentDir, config, probeTimeoutMs) === 'ready') return { state: 'running', config: readConfig(agentDir) };

  const dir = messagingDir(agentDir); const lock = join(dir, 'startup.lock');
  const deadline = Date.now() + startupTimeoutMs;
  let lockFd: number | undefined;
  while (lockFd === undefined) {
    try {
      lockFd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(lockFd, `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`);
      closeSync(lockFd); lockFd = -1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = readConfig(agentDir);
      if (await probeAt(agentDir, current, probeTimeoutMs) === 'ready') return { state: 'running', config: readConfig(agentDir) };
      if (lockAge(lock) > startupTimeoutMs) {
        try { unlinkSync(lock); } catch (unlinkError) { if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError; }
        continue;
      }
      if (Date.now() >= deadline) fail('busy', 'Messaging broker startup is already in progress');
      await delay(50);
    }
  }

  let child: ChildProcess | undefined;
  let logFd: number | undefined;
  try {
    config = readConfig(agentDir);
    if (await probeAt(agentDir, config, probeTimeoutMs) === 'ready') return { state: 'running', config: readConfig(agentDir) };
    const serverFile = writeServerConfig(agentDir, config);
    const log = join(dir, 'broker.log');
    if (existsSync(log)) privatePath(log, false);
    logFd = openSync(log, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    child = spawn(binary, ['-c', serverFile], { detached: true, stdio: ['ignore', logFd, logFd] });
    await new Promise<void>((resolve, reject) => {
      child!.once('spawn', resolve);
      child!.once('error', error => reject(new Error(`Could not spawn nats-server: ${safeText(error.message)}`)));
    });
    if (!Number.isSafeInteger(child.pid)) throw new Error('Could not spawn nats-server');
    writePrivateJson(join(dir, 'broker-process.json'), { pid: child.pid, startedAt: Date.now(), server: config.server });
    const ready = await waitForReady(agentDir, child, Math.max(250, deadline - Date.now()), probeTimeoutMs);
    child.unref();
    return { state: 'started', config: ready };
  } catch (error) {
    if (child) await stopChild(child);
    throw error;
  } finally {
    if (logFd !== undefined) closeSync(logFd);
    try { unlinkSync(lock); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
