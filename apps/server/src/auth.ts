import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { type DB, nowIso, one, run, uid } from './db/index.js';

export const SESSION_COOKIE = 'rp_session';

interface SessionRow {
  id: string;
  expires_at: string;
  revoked: number;
}

export interface AuthState {
  mode: typeof config.auth.mode;
  authenticated: boolean;
  login?: string;
}

/** 요청의 인증 상태 판정 (권한 거부는 하지 않음) */
export function authState(req: FastifyRequest, db: DB): AuthState {
  const mode = config.auth.mode;
  if (mode === 'none') return { mode, authenticated: true, login: 'local' };
  if (mode === 'tailscale') {
    const login = req.headers['tailscale-user-login'];
    const ok = typeof login === 'string' && login.toLowerCase() === config.auth.allowedLogin.toLowerCase();
    return { mode, authenticated: ok, login: typeof login === 'string' ? login : undefined };
  }
  const raw = req.cookies?.[SESSION_COOKIE];
  if (!raw) return { mode, authenticated: false };
  const u = req.unsignCookie(raw);
  if (!u.valid || !u.value) return { mode, authenticated: false };
  const s = one<SessionRow>(db, 'SELECT id, expires_at, revoked FROM sessions WHERE id = ?', u.value);
  if (!s || s.revoked === 1 || s.expires_at < nowIso()) return { mode, authenticated: false };
  return { mode, authenticated: true, login: 'token-session' };
}

export function registerAuthHook(app: FastifyInstance, db: DB): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return; // 정적 파일은 통과 (번들에 비밀 없음)
    if (req.url.startsWith('/api/health') || req.url.startsWith('/api/auth/')) return;
    const st = authState(req, db);
    if (st.authenticated) return;
    const hint =
      st.mode === 'tailscale'
        ? 'Tailscale Serve 를 경유해 접속했는지, ALLOWED_LOGIN 이 Tailscale 계정과 일치하는지 확인'
        : '로그인 필요';
    return reply.code(401).send({ error: 'unauthorized', mode: st.mode, hint });
  });
}

export function tokenMatches(candidate: string): boolean {
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(config.auth.appToken).digest();
  return crypto.timingSafeEqual(a, b);
}

export function createSession(db: DB, userAgent: string | undefined): { id: string; expiresAt: string } {
  const id = uid();
  const expiresAt = new Date(Date.now() + config.auth.sessionTtlHours * 3600_000).toISOString();
  run(db, 'INSERT INTO sessions (id, created_at, expires_at, revoked, user_agent) VALUES (?, ?, ?, 0, ?)', id, nowIso(), expiresAt, userAgent ?? null);
  run(db, 'DELETE FROM sessions WHERE expires_at < ?', new Date(Date.now() - 7 * 86400_000).toISOString());
  return { id, expiresAt };
}

export function setSessionCookie(reply: FastifyReply, id: string, expiresAt: string): void {
  reply.setCookie(SESSION_COOKIE, id, {
    path: '/',
    httpOnly: true,
    secure: true, // Tailscale Serve(HTTPS) 경유 전제. 로컬 http 개발 시 브라우저가 거부하므로 AUTH_MODE=none 사용
    sameSite: 'strict',
    signed: true,
    expires: new Date(expiresAt),
  });
}

export function revokeSession(db: DB, id: string): void {
  run(db, 'UPDATE sessions SET revoked = 1 WHERE id = ?', id);
}
export function revokeAllSessions(db: DB): number {
  return run(db, 'UPDATE sessions SET revoked = 1 WHERE revoked = 0').changes;
}

export function currentSessionId(req: FastifyRequest): string | null {
  const raw = req.cookies?.[SESSION_COOKIE];
  if (!raw) return null;
  const u = req.unsignCookie(raw);
  return u.valid && u.value ? u.value : null;
}
