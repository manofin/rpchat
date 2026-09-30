/** npm run test:benches -- authHealthSurface
 * LOCK-AuthSurface Policy A: unauth /api/health is slim {ok,db}; auth keeps rich body.
 * Mutates config.auth for token/none cases; restores afterward. Temp DB + fake model only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { openMigratedDb } from '../apps/server/src/db/index.ts';
import { GenerationQueue } from '../apps/server/src/model/queue.ts';
import { healthRoutes } from '../apps/server/src/routes/health.ts';
import { config } from '../apps/server/src/config.ts';
import { SESSION_COOKIE } from '../apps/server/src/auth.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';

let checks = 0;
async function t(name: string, fn: () => Promise<void>) {
  await fn();
  console.log(`ok ${++checks} ${name}`);
}

const origAuth = {
  mode: config.auth.mode,
  appToken: config.auth.appToken,
  sessionSecret: config.auth.sessionSecret,
  host: config.host,
};

function restoreAuth() {
  config.auth.mode = origAuth.mode;
  config.auth.appToken = origAuth.appToken;
  config.auth.sessionSecret = origAuth.sessionSecret;
  config.host = origAuth.host;
}

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers['set-cookie'];
  assert.ok(setCookie, 'Set-Cookie present');
  return (Array.isArray(setCookie) ? setCookie : [setCookie])
    .map((c) => String(c).split(';')[0])
    .join('; ');
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-auth-health-'));
  const db = openMigratedDb(dir, path.resolve('apps/server/migrations'));
  const queue = new GenerationQueue(1);
  let healthCalls = 0;
  let healthImpl: () => Promise<{ ok: boolean; checkedAt: string; latencyMs: number; models: string[]; error?: string }> =
    async () => ({ ok: true, checkedAt: 'fixture', latencyMs: 0, models: ['fixture-model'] });

  const ctx = {
    db,
    queue,
    model: { complete: async () => ({ text: '', finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 }) },
    log: { error() {}, warn() {}, debug() {}, info() {} },
    resolvedModel: () => 'fixture-model',
    setResolvedModel() {},
    health: async () => {
      healthCalls++;
      return healthImpl();
    },
  } as unknown as Ctx;

  config.auth.mode = 'token';
  config.auth.appToken = 'token-mode-app-tok';
  config.auth.sessionSecret = 's'.repeat(32);
  config.host = '127.0.0.1';

  const app = Fastify({ logger: false });
  await app.register(fastifyCookie, { secret: config.auth.sessionSecret });
  await app.register(healthRoutes(ctx));
  await app.ready();

  const loginCookie = async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: 'token-mode-app-tok' },
    });
    assert.equal(login.statusCode, 200, login.body);
    const cookie = cookieFrom(login);
    assert.ok(cookie.includes(SESSION_COOKIE));
    return cookie;
  };

  try {
    await t('unauth token mode: slim keys only and health probe not called', async () => {
      healthCalls = 0;
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json() as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(), ['db', 'ok']);
      assert.equal(body.ok, true);
      assert.equal(body.db, 'ok');
      assert.equal(healthCalls, 0, 'ctx.health must not run for unauthenticated callers');
    });

    await t('unauth ok mirrors db only even when health stub would fail', async () => {
      healthImpl = async () => ({ ok: false, checkedAt: 'fail', latencyMs: 0, models: [], error: 'stub-fail' });
      healthCalls = 0;
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json() as Record<string, unknown>;
      assert.equal(body.ok, true);
      assert.equal(body.db, 'ok');
      assert.equal(healthCalls, 0);
      assert.equal('model' in body, false);
    });

    await t('authenticated token session: rich body + health probe + generation.active kind', async () => {
      healthImpl = async () => ({ ok: true, checkedAt: 'fixture', latencyMs: 1, models: ['fixture-model'] });
      healthCalls = 0;
      queue.register({
        id: 'gen-bench-1',
        kind: 'chat',
        conversationId: 'c1',
        messageId: 'm1',
        startedAt: new Date().toISOString(),
        controller: new AbortController(),
      });
      try {
        const cookie = await loginCookie();
        const res = await app.inject({
          method: 'GET',
          url: '/api/health',
          headers: { cookie },
        });
        assert.equal(res.statusCode, 200, res.body);
        const body = res.json() as Record<string, unknown>;
        for (const k of ['ok', 'time', 'db', 'model', 'generation', 'promptVersion', 'authMode']) {
          assert.ok(k in body, `missing rich key ${k}`);
        }
        assert.equal(body.authMode, 'token');
        assert.equal(body.db, 'ok');
        assert.equal(body.ok, true);
        assert.ok(healthCalls >= 1, 'ctx.health must run for authenticated callers');
        const generation = body.generation as { active: Array<{ id: string; kind?: string }>; queued: number };
        assert.ok(Array.isArray(generation.active));
        assert.equal(generation.active[0].id, 'gen-bench-1');
        assert.equal(generation.active[0].kind, 'chat');
      } finally {
        queue.unregister('gen-bench-1');
      }
    });

    await t('AUTH_MODE=none: always rich without cookie', async () => {
      config.auth.mode = 'none';
      healthCalls = 0;
      healthImpl = async () => ({ ok: true, checkedAt: 'fixture', latencyMs: 0, models: ['fixture-model'] });
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json() as Record<string, unknown>;
      for (const k of ['ok', 'time', 'db', 'model', 'generation', 'promptVersion', 'authMode']) {
        assert.ok(k in body, `missing rich key ${k}`);
      }
      assert.equal(body.authMode, 'none');
      assert.ok(healthCalls >= 1);
    });

    await t('auth path with failing health stub shows model fail; unauth stays ok', async () => {
      config.auth.mode = 'token';
      healthImpl = async () => ({ ok: false, checkedAt: 'fail', latencyMs: 0, models: [], error: 'stub-fail' });

      const unauth = (await app.inject({ method: 'GET', url: '/api/health' })).json() as Record<string, unknown>;
      assert.equal(unauth.ok, true);
      assert.equal(unauth.db, 'ok');
      assert.equal('model' in unauth, false);

      const cookie = await loginCookie();
      const authBody = (await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { cookie },
      })).json() as Record<string, unknown>;
      assert.equal(authBody.db, 'ok');
      assert.equal(authBody.ok, false, 'authenticated ok requires model.ok');
      assert.equal((authBody.model as { ok: boolean }).ok, false);
    });

    await t('auth routes smoke: me + login unchanged', async () => {
      config.auth.mode = 'token';
      const meUnauth = await app.inject({ method: 'GET', url: '/api/auth/me' });
      assert.equal(meUnauth.statusCode, 200);
      const meBody = meUnauth.json() as { authenticated: boolean; mode: string };
      assert.equal(meBody.mode, 'token');
      assert.equal(meBody.authenticated, false);

      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { token: 'token-mode-app-tok' },
      });
      assert.equal(login.statusCode, 200, login.body);
      const loginBody = login.json() as { ok: boolean; expiresAt: string };
      assert.equal(loginBody.ok, true);
      assert.ok(loginBody.expiresAt);

      const cookie = cookieFrom(login);
      const meAuth = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie },
      });
      assert.equal(meAuth.statusCode, 200);
      assert.equal((meAuth.json() as { authenticated: boolean }).authenticated, true);
    });
  } finally {
    await app.close();
    restoreAuth();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`${checks} passed`);
}

main().catch((err) => {
  restoreAuth();
  console.error(err);
  process.exit(1);
});
