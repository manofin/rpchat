/**
 * npx tsx bench/tailscaleIngress.test.ts
 * TailscaleIngressContract — socket peer + login header; no X-Forwarded-*.
 * Isolated: temp DATA_DIR, no systemd, no live DB, no live model.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { config, validateConfig } from '../apps/server/src/config.ts';
import { openDb } from '../apps/server/src/db/index.ts';
import {
  SESSION_COOKIE,
  createSession,
  registerAuthHook,
  setSessionCookie,
} from '../apps/server/src/auth.ts';
import {
  isLoopbackHost,
  isTrustedIngressPeer,
  parseTrustedProxyIps,
} from '../apps/server/src/tailscalePeer.ts';

const LOGIN = 'you@github';
let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const orig = {
  mode: config.auth.mode,
  allowedLogin: config.auth.allowedLogin,
  trustedProxyIpsRaw: config.auth.trustedProxyIpsRaw,
  host: config.host,
  appToken: config.auth.appToken,
  sessionSecret: config.auth.sessionSecret,
};

function restoreAuth() {
  config.auth.mode = orig.mode;
  config.auth.allowedLogin = orig.allowedLogin;
  config.auth.trustedProxyIpsRaw = orig.trustedProxyIpsRaw;
  config.host = orig.host;
  config.auth.appToken = orig.appToken;
  config.auth.sessionSecret = orig.sessionSecret;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-tailscale-ingress-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));

  await t('parse: empty default is no extra peers', () => {
    const p = parseTrustedProxyIps('');
    assert.deepEqual(p.ips, []);
    assert.deepEqual(p.errors, []);
  });

  await t('parse: exact IPv4 and IPv6 kept; duplicates collapsed', () => {
    const p = parseTrustedProxyIps('172.18.0.1, 2001:db8::1, 172.18.0.1');
    assert.deepEqual(p.ips, ['172.18.0.1', '2001:db8::1']);
    assert.deepEqual(p.errors, []);
  });

  await t('parse: wildcard, CIDR, DNS, unspecified rejected', () => {
    const p = parseTrustedProxyIps('*, 10.0.0.0/8, 0.0.0.0/0, host.docker.internal, localhost, 0.0.0.0, ::');
    assert.deepEqual(p.ips, []);
    assert.ok(p.errors.some((e) => e.includes('와일드카드')));
    assert.ok(p.errors.some((e) => e.includes('네트워크/CIDR')));
    assert.ok(p.errors.some((e) => e.includes('DNS/비IP')));
    assert.ok(p.errors.some((e) => e.includes('전체 네트워크')));
  });

  await t('loopback host: 127.0.0.1 ::1 localhost; not 0.0.0.0', () => {
    assert.equal(isLoopbackHost('127.0.0.1'), true);
    assert.equal(isLoopbackHost('::1'), true);
    assert.equal(isLoopbackHost('localhost'), true);
    assert.equal(isLoopbackHost('0.0.0.0'), false);
    assert.equal(isLoopbackHost('::'), false);
    assert.equal(isLoopbackHost('192.168.1.9'), false);
  });

  await t('peer: loopback always trusted; mapped IPv4-mapped loopback too', () => {
    assert.equal(isTrustedIngressPeer('127.0.0.1', []), true);
    assert.equal(isTrustedIngressPeer('::1', []), true);
    assert.equal(isTrustedIngressPeer('::ffff:127.0.0.1', []), true);
    assert.equal(isTrustedIngressPeer('10.9.9.9', []), false);
    assert.equal(isTrustedIngressPeer('10.9.9.9', ['10.9.9.9']), true);
    assert.equal(isTrustedIngressPeer('10.9.9.9', ['172.18.0.1']), false);
  });

  await t('boot: loopback HOST + empty trusted list ok', () => {
    config.auth.mode = 'tailscale';
    config.auth.allowedLogin = LOGIN;
    config.auth.trustedProxyIpsRaw = '';
    config.host = '127.0.0.1';
    const problems = validateConfig().filter((p) => p.includes('TAILSCALE_TRUSTED_PROXY_IPS') || p.includes('비루프백'));
    assert.deepEqual(problems, []);
  });

  await t('boot: non-loopback HOST without trusted peer refused', () => {
    config.auth.mode = 'tailscale';
    config.auth.allowedLogin = LOGIN;
    config.auth.trustedProxyIpsRaw = '';
    config.host = '0.0.0.0';
    const problems = validateConfig();
    assert.ok(problems.some((p) => p.includes('비루프백 HOST') && p.includes('TAILSCALE_TRUSTED_PROXY_IPS')));
  });

  await t('boot: non-loopback HOST with exact trusted peer ok', () => {
    config.auth.mode = 'tailscale';
    config.auth.allowedLogin = LOGIN;
    config.auth.trustedProxyIpsRaw = '172.18.0.1';
    config.host = '0.0.0.0';
    const problems = validateConfig().filter((p) => p.includes('TAILSCALE_TRUSTED_PROXY_IPS') || p.includes('비루프백'));
    assert.deepEqual(problems, []);
  });

  await t('boot: docker exception missing still refused when list is wildcard', () => {
    config.auth.mode = 'tailscale';
    config.auth.allowedLogin = LOGIN;
    config.auth.trustedProxyIpsRaw = '*';
    config.host = '0.0.0.0';
    const problems = validateConfig();
    assert.ok(problems.some((p) => p.includes('와일드카드')));
    assert.ok(problems.some((p) => p.includes('비루프백 HOST')));
  });

  await t('boot: token mode does not require trusted peer list', () => {
    config.auth.mode = 'token';
    config.auth.appToken = 't'.repeat(16);
    config.auth.sessionSecret = 's'.repeat(32);
    config.auth.trustedProxyIpsRaw = '';
    config.host = '0.0.0.0';
    const problems = validateConfig();
    assert.equal(
      problems.some((p) => p.includes('TAILSCALE_TRUSTED_PROXY_IPS') || p.includes('비루프백')),
      false,
    );
  });

  config.auth.mode = 'tailscale';
  config.auth.allowedLogin = LOGIN;
  config.auth.trustedProxyIpsRaw = '172.18.0.1';
  config.host = '127.0.0.1';

  const app = Fastify({ logger: false, trustProxy: false });
  registerAuthHook(app, db);
  app.get('/api/probe', async () => ({ ok: true }));
  await app.ready();

  async function probe(opts: { remoteAddress: string; login?: string; extraHeaders?: Record<string, string> }) {
    const headers: Record<string, string> = { ...(opts.extraHeaders ?? {}) };
    if (opts.login !== undefined) headers['tailscale-user-login'] = opts.login;
    const res = await app.inject({
      method: 'GET',
      url: '/api/probe',
      remoteAddress: opts.remoteAddress,
      headers,
    });
    return { status: res.statusCode, body: res.json() as { error?: string; mode?: string } };
  }

  await t('trusted peer × correct header → 200', async () => {
    const r = await probe({ remoteAddress: '172.18.0.1', login: LOGIN });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
  });

  await t('trusted peer × wrong header → 401', async () => {
    const r = await probe({ remoteAddress: '172.18.0.1', login: 'other@github' });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'unauthorized');
    assert.equal(r.body.mode, 'tailscale');
  });

  await t('untrusted peer × correct header → 401', async () => {
    const r = await probe({ remoteAddress: '10.9.9.9', login: LOGIN });
    assert.equal(r.status, 401);
  });

  await t('untrusted peer × wrong header → 401', async () => {
    const r = await probe({ remoteAddress: '10.9.9.9', login: 'other@github' });
    assert.equal(r.status, 401);
  });

  await t('IPv4 loopback peer × correct header → 200', async () => {
    const r = await probe({ remoteAddress: '127.0.0.1', login: LOGIN });
    assert.equal(r.status, 200);
  });

  await t('IPv6 loopback peer × correct header → 200', async () => {
    const r = await probe({ remoteAddress: '::1', login: LOGIN });
    assert.equal(r.status, 200);
  });

  await t('X-Forwarded-For does not grant trust', async () => {
    const r = await probe({
      remoteAddress: '10.9.9.9',
      login: LOGIN,
      extraHeaders: { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' },
    });
    assert.equal(r.status, 401);
  });

  await t('observed untrusted peer is not auto-registered', async () => {
    assert.equal(config.auth.trustedProxyIpsRaw, '172.18.0.1');
    const first = await probe({ remoteAddress: '10.9.9.9', login: LOGIN });
    assert.equal(first.status, 401);
    assert.equal(config.auth.trustedProxyIpsRaw, '172.18.0.1');
    const second = await probe({ remoteAddress: '10.9.9.9', login: LOGIN });
    assert.equal(second.status, 401);
    assert.equal(parseTrustedProxyIps(config.auth.trustedProxyIpsRaw).ips.includes('10.9.9.9'), false);
  });

  await app.close();

  const live = Fastify({ logger: false, trustProxy: false });
  registerAuthHook(live, db);
  live.get('/api/probe', async () => ({ ok: true }));
  await live.listen({ host: '127.0.0.1', port: 0 });
  const addr = live.server.address();
  assert.ok(addr && typeof addr === 'object');
  const url = `http://127.0.0.1:${addr.port}/api/probe`;

  await t('real loopback socket × correct header → 200', async () => {
    const res = await fetch(url, { headers: { 'tailscale-user-login': LOGIN } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  await t('real loopback socket × wrong header → 401', async () => {
    const res = await fetch(url, { headers: { 'tailscale-user-login': 'nope@github' } });
    assert.equal(res.status, 401);
  });

  await live.close();

  let v6ok = false;
  const live6 = Fastify({ logger: false, trustProxy: false });
  registerAuthHook(live6, db);
  live6.get('/api/probe', async () => ({ ok: true }));
  try {
    await live6.listen({ host: '::1', port: 0, ipv6Only: true });
    v6ok = true;
  } catch (e) {
    await live6.close().catch(() => undefined);
    console.log(`# skip IPv6 listen: ${(e as Error).message}`);
  }
  if (v6ok) {
    const a6 = live6.server.address();
    assert.ok(a6 && typeof a6 === 'object');
    await t('real IPv6 loopback socket × correct header → 200', async () => {
      const res = await fetch(`http://[::1]:${a6.port}/api/probe`, {
        headers: { 'tailscale-user-login': LOGIN },
      });
      assert.equal(res.status, 200);
    });
    await live6.close();
  }

  config.auth.mode = 'token';
  config.auth.appToken = 'token-mode-app-tok';
  config.auth.sessionSecret = 's'.repeat(32);
  config.auth.trustedProxyIpsRaw = '';
  const tokenApp = Fastify({ logger: false, trustProxy: false });
  await tokenApp.register(fastifyCookie, { secret: config.auth.sessionSecret });
  registerAuthHook(tokenApp, db);
  tokenApp.get('/api/probe', async () => ({ ok: true }));
  tokenApp.get('/api/auth/login-setup', async (_req, reply) => {
    const s = createSession(db, 'bench');
    setSessionCookie(reply, s.id, s.expiresAt);
    return { ok: true };
  });
  await tokenApp.ready();

  await t('token mode: cookie auth still works from a non-loopback inject peer', async () => {
    const login = await tokenApp.inject({ method: 'GET', url: '/api/auth/login-setup', remoteAddress: '8.8.8.8' });
    assert.equal(login.statusCode, 200);
    const setCookie = login.headers['set-cookie'];
    assert.ok(setCookie, 'Set-Cookie present');
    const cookieHeader = (Array.isArray(setCookie) ? setCookie : [setCookie])
      .map((c) => String(c).split(';')[0])
      .join('; ');
    assert.ok(cookieHeader.includes(SESSION_COOKIE));
    const bare = await tokenApp.inject({
      method: 'GET',
      url: '/api/probe',
      remoteAddress: '8.8.8.8',
    });
    assert.equal(bare.statusCode, 401);
    const authed = await tokenApp.inject({
      method: 'GET',
      url: '/api/probe',
      remoteAddress: '8.8.8.8',
      headers: { cookie: cookieHeader },
    });
    assert.equal(authed.statusCode, 200);
  });

  await tokenApp.close();
  restoreAuth();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${passed} passed`);
}

main().catch((err) => {
  restoreAuth();
  console.error(err);
  process.exit(1);
});
