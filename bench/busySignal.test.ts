/** Local-only fake callbacks; no DB, credentials or model requests. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { openMigratedDb } from '../apps/server/src/db/index.ts';
import type { AddressInfo } from 'node:net';
import { GenerationQueue } from '../apps/server/src/model/queue.ts';
import { startBusySignal } from '../apps/server/src/model/busySignal.ts';
import { config, validateConfig } from '../apps/server/src/config.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void>) {
  await fn(); console.log(`ok ${++passed} ${name}`);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

async function main() {
await t('unregistered work, queued abort, handoff and idle use actual lifetime', async () => {
  const q = new GenerationQueue(1);
  const server = await startBusySignal(q, 0);
  const address = server.address() as AddressInfo;
  assert.equal(address.address, '127.0.0.1');
  const url = `http://127.0.0.1:${address.port}/busy`;
  const read = async () => { const r = await fetch(url); assert.equal(r.status, 200); return r.json(); };
  try {
    assert.deepEqual(await read(), { schema_version: 1, busy: false, running: 0, queued: 0, pending: 0 });
    const first = deferred();
    const a = q.run(() => first.promise);
    const abort = new AbortController();
    const b = q.run(async () => { throw new Error('must not run'); }, abort.signal);
    const rejected = assert.rejects(b, /aborted while queued/);
    assert.equal(q.activeList.length, 0);
    assert.deepEqual(await read(), { schema_version: 1, busy: true, running: 1, queued: 1, pending: 2 });
    abort.abort(); await rejected;
    assert.equal(q.load.pending, 1);
    const second = deferred();
    const c = q.run(() => second.promise);
    first.resolve(); await a;
    assert.equal((await read()).busy, true);
    second.resolve(); await c;
    assert.equal((await read()).busy, false);
    await assert.rejects(q.run(async () => { throw new Error('model error'); }), /model error/);
    assert.equal((await read()).busy, false);
    const already = new AbortController(); already.abort();
    await assert.rejects(q.run(async () => {}, already.signal), /aborted before start/);
    assert.equal(q.load.pending, 0);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

await t('force release does not report idle while underlying callback hangs', async () => {
  const q = new GenerationQueue(1); const wait = deferred();
  q.register({ id: 'test', conversationId: 'private', messageId: 'private', startedAt: 'private', controller: new AbortController() });
  const running = q.runGeneration('test', () => wait.promise);
  q.forceRelease('test');
  assert.equal(q.activeList.length, 0);
  assert.deepEqual(q.load, { busy: true, running: 0, queued: 0, pending: 1 });
  wait.resolve(); await running;
  assert.deepEqual(q.load, { busy: false, running: 0, queued: 0, pending: 0 });
});

await t('endpoint has no private details, denies proxy/browser headers, binds only loopback', async () => {
  const q = new GenerationQueue(1); const server = await startBusySignal(q, 0);
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const r = await fetch(`${base}/busy`);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    assert.deepEqual(Object.keys(await r.json()).sort(), ['busy','pending','queued','running','schema_version']);
    for (const headers of [{origin:'https://example.invalid'}, {'x-forwarded-for':'127.0.0.1'},
                           {forwarded:'for=127.0.0.1'}, {'tailscale-user-login':'synthetic-fixture'}]) {
      assert.equal((await fetch(`${base}/busy`, {headers})).status, 403);
    }
    assert.equal((await fetch(`${base}/busy`, {method:'POST'})).status,405);
    assert.equal((await fetch(`${base}/api/generations/active`)).status,404);
    assert.equal((await fetch(`${base}/busy?extra=1`)).status,404);
    await assert.rejects(startBusySignal(q, address.port), /EADDRINUSE/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

await t('busy config defaults disabled and rejects invalid or colliding ports', async () => {
  const old = config.busySignalPort;
  const appPort = config.port; config.port = 8787;
  try {
    assert.equal(old,0);
    for (const value of [-1, 65536, 1.5, config.port]) {
      config.busySignalPort = value;
      assert.ok(validateConfig().some(s => s.includes('BUSY_SIGNAL_PORT')));
    }
    config.busySignalPort = 0;
    assert.ok(!validateConfig().some(s => s.includes('BUSY_SIGNAL_PORT')));
  } finally { config.busySignalPort = old; config.port = appPort; }
});
await t('main startup serves a separate busy listener while normal API remains authenticated; shutdown closes it', async () => {
  async function freePort() {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>(resolve => server.close(() => resolve()));
    return port;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'busy-startup-'));
  const db = openMigratedDb(dir, path.resolve('apps/server/migrations')); db.close();
  const port = await freePort(); const busyPort = await freePort();
  assert.notEqual(port, busyPort);
  const child = spawn(process.execPath, ['--import','tsx','apps/server/src/index.ts'], {
    env: { PATH: process.env.PATH, DATA_DIR: dir, AUTH_MODE: 'tailscale', ALLOWED_LOGIN: 'fixture@example.invalid',
      PORT: String(port), HOST: '127.0.0.1', BUSY_SIGNAL_PORT: String(busyPort),
      MODEL_BASE_URL: 'http://127.0.0.1:1/v1', MODEL_NAME: 'offline', MODEL_API_KEY: '',
      RPCHAT_PROMPT_DUMP: '0', RPCHAT_REQUEST_DUMP: '0', LOG_LEVEL: 'silent' },
    stdio: ['ignore','pipe','pipe'],
  });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  try {
    let ready = false;
    for (let i=0; i<100; i++) {
      assert.equal(child.exitCode, null, output);
      try { ready = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, output);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/generations/active`)).status, 401);
    const response = await fetch(`http://127.0.0.1:${busyPort}/busy`);
    assert.equal(response.status,200);
    assert.equal((await response.json()).busy,false);
    child.kill('SIGTERM');
    assert.equal(await exited,0,output);
    await assert.rejects(fetch(`http://127.0.0.1:${busyPort}/busy`));
  } finally {
    if (child.exitCode===null) { child.kill('SIGKILL'); await exited; }
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
console.log(`1..${passed}`);
}
main().catch(err => { console.error(err); process.exitCode = 1; });
