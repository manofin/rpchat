import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { PROMPT_VERSION, config } from '../config.js';
import { one } from '../db/index.js';
import {
  SESSION_COOKIE, authState, createSession, currentSessionId, revokeAllSessions, revokeSession, setSessionCookie, tokenMatches,
} from '../auth.js';

export function healthRoutes(ctx: Ctx) {
  return async function plugin(app: FastifyInstance) {
    app.get('/api/health', async () => {
      const model = await ctx.health();
      const dbOk = (() => {
        try {
          one(ctx.db, 'SELECT 1');
          return true;
        } catch {
          return false;
        }
      })();
      const active = ctx.queue.activeList.map((g) => ({ id: g.id, conversationId: g.conversationId, messageId: g.messageId, startedAt: g.startedAt }));
      return {
        ok: dbOk && model.ok,
        time: new Date().toISOString(),
        db: dbOk ? 'ok' : 'error',
        model: { ...model, resolvedModel: ctx.resolvedModel(), contextTokens: config.model.contextTokens },
        generation: { active, queued: ctx.queue.queued },
        promptVersion: PROMPT_VERSION,
        authMode: config.auth.mode,
      };
    });

    app.get('/api/auth/me', async (req) => authState(req, ctx.db));

    const loginSchema = z.object({ token: z.string().min(1).max(512) });
    app.post('/api/auth/login', async (req, reply) => {
      if (config.auth.mode !== 'token') return reply.code(400).send({ error: `AUTH_MODE=${config.auth.mode} 에서는 로그인 엔드포인트를 쓰지 않음` });
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'token 필요' });
      // 단순 속도 제한: 실패 시 1초 지연 (단일 사용자 서비스 전제)
      if (!tokenMatches(parsed.data.token)) {
        await new Promise((r) => setTimeout(r, 1000));
        return reply.code(401).send({ error: '토큰 불일치' });
      }
      const s = createSession(ctx.db, req.headers['user-agent']);
      setSessionCookie(reply, s.id, s.expiresAt);
      return { ok: true, expiresAt: s.expiresAt };
    });

    app.post('/api/auth/logout', async (req, reply) => {
      const id = currentSessionId(req);
      if (id) revokeSession(ctx.db, id);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    });

    app.post('/api/auth/logout-all', async (req, reply) => {
      const st = authState(req, ctx.db);
      if (!st.authenticated) return reply.code(401).send({ error: 'unauthorized' });
      const n = revokeAllSessions(ctx.db);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true, revoked: n };
    });
  };
}
