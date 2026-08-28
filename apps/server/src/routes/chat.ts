import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { PROMPT_VERSION, config } from '../config.js';
import { nowIso, one, run, uid } from '../db/index.js';
import { interruptOrphanStreaming } from '../db/generation.js';
import { getPath, insertMessage, messageOut, setHead, updateMessage } from '../db/tree.js';
import { ModelError } from '../model/adapter.js';
import { buildPrompt } from '../prompt/builder.js';
import { dumpGenerationPrompt } from '../prompt/dump.js';
import { extractChoices } from '../prompt/templates.js';
import { estimateTokens, updateCalibration } from '../prompt/tokens.js';
import type { ConversationRow, MessageRow } from '../types.js';
import { loadConversation } from './conversations.js';

type SseBudget = {
  dropped_messages: number;
  included_messages: number;
  est_total: number;
  available: number;
};

type SseEvent =
  | { type: 'start'; generationId: string; messageId: string; userMessage?: ReturnType<typeof messageOut> }
  | { type: 'token'; text: string }
  | { type: 'done'; message: ReturnType<typeof messageOut>; usage: unknown; ttftMs: number | null; totalMs: number; budget?: SseBudget }
  | { type: 'error'; message: string; messageId?: string };

function sseBudget(b: { dropped_messages: number; included_messages: number; est_total: number; available: number }): SseBudget {
  return {
    dropped_messages: b.dropped_messages,
    included_messages: b.included_messages,
    est_total: b.est_total,
    available: b.available,
  };
}

const PERSIST_INTERVAL_MS = 800;

export function chatRoutes(ctx: Ctx) {
  const { db } = ctx;

  function openSse(reply: FastifyReply): { send: (e: SseEvent) => void; close: () => void; isOpen: () => boolean } {
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write(': ok\n\n');
    let open = true;
    reply.raw.on('close', () => {
      open = false;
    });
    return {
      send: (e) => {
        if (open) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
      },
      close: () => {
        if (open) {
          open = false;
          reply.raw.end();
        }
      },
      isOpen: () => open,
    };
  }

  /**
   * 공통 생성 경로. parentId 를 head 로 두고 그 아래에 assistant 메시지를 만들어 스트리밍한다.
   * 클라이언트가 끊겨도 생성은 계속되어 DB 에 저장된다(모바일 백그라운드 대응). 중단은 abort 엔드포인트로만.
   */
  async function generate(req: FastifyRequest, reply: FastifyReply, conv: ConversationRow, parentId: string | null, userMessage?: MessageRow) {
    interruptOrphanStreaming(db, { keepMessageIds: ctx.queue.activeList.map((g) => g.messageId) });
    if (ctx.queue.activeList.some((g) => g.conversationId === conv.id)) return reply.code(409).send({ error: '이 대화에서 이미 생성 중' });

    setHead(db, conv.id, parentId);
    const convNow = loadConversation(ctx, conv.id)!;
    const history = getPath(db, convNow);

    let built;
    try {
      built = buildPrompt(db, convNow, history, config.model.contextTokens, ctx.resolvedModel());
    } catch (err) {
      return reply.code(500).send({ error: `프롬프트 조립 실패: ${(err as Error).message}` });
    }
    if (!built.model) return reply.code(503).send({ error: '모델 이름을 해석할 수 없음 (MODEL_NAME 설정 또는 모델 서버 확인)' });

    const generationId = uid();
    const assistant = insertMessage(db, conv.id, parentId, 'assistant', '', 'streaming', {
      generation_id: generationId, profile: built.profile.name, prompt_version: PROMPT_VERSION, ooc: built.isOoc || undefined,
    });
    setHead(db, conv.id, assistant.id);

    const sse = openSse(reply);
    sse.send({ type: 'start', generationId, messageId: assistant.id, userMessage: userMessage ? messageOut(db, userMessage) : undefined });

    const controller = new AbortController();
    ctx.queue.register({ id: generationId, conversationId: conv.id, messageId: assistant.id, startedAt: nowIso(), controller });

    const estPrompt = built.messages.reduce((n, m) => n + estimateTokens(m.content, 1), 0); // 보정 전 원시 추정
    let buffer = '';
    let lastPersist = Date.now();
    const t0 = Date.now();

    const logRow = (status: string, extra: Partial<{ actual: number | null; completion: number | null; ttft: number | null; total: number; finish: string | null }>) => {
      run(
        db,
        `INSERT INTO generation_log (id, conversation_id, message_id, profile_name, prompt_version, est_prompt_tokens, actual_prompt_tokens, completion_tokens, ttft_ms, total_ms, finish_reason, status, budget_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        uid(), conv.id, assistant.id, built.profile.name, PROMPT_VERSION, estPrompt, extra.actual ?? null, extra.completion ?? null, extra.ttft ?? null,
        extra.total ?? Date.now() - t0, extra.finish ?? null, status, JSON.stringify(built.budget), nowIso(),
      );
    };

    try {
      await ctx.queue.run(async () => {
        dumpGenerationPrompt({
          dataDir: config.dataDir,
          generationId,
          conversationId: conv.id,
          messageId: assistant.id,
          createdAt: nowIso(),
          messages: built.messages,
        });
        const result = await ctx.model.stream(
          {
            model: built.model,
            messages: built.messages,
            temperature: built.profile.temperature,
            top_p: built.profile.top_p,
            max_tokens: built.profile.max_tokens,
            stop: built.stop,
            signal: controller.signal,
          },
          (delta) => {
            buffer += delta;
            sse.send({ type: 'token', text: delta });
            if (Date.now() - lastPersist > PERSIST_INTERVAL_MS) {
              lastPersist = Date.now();
              updateMessage(db, assistant.id, { content: buffer });
            }
          },
        );
        const parsed = !built.isOoc ? extractChoices(result.text) : { content: result.text, choices: null };
        updateMessage(db, assistant.id, {
          content: parsed.content.trim(),
          status: 'complete',
          meta: { usage: result.usage, finish_reason: result.finishReason, choices: parsed.choices ?? undefined },
        });
        if (result.usage?.prompt_tokens) updateCalibration(db, estPrompt, result.usage.prompt_tokens);
        logRow('complete', { actual: result.usage?.prompt_tokens ?? null, completion: result.usage?.completion_tokens ?? null, ttft: result.ttftMs, total: result.totalMs, finish: result.finishReason });
        sse.send({ type: 'done', message: messageOut(db, one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', assistant.id)!), usage: result.usage, ttftMs: result.ttftMs, totalMs: result.totalMs, budget: sseBudget(built.budget) });
      }, controller.signal);
    } catch (err) {
      const aborted = controller.signal.aborted;
      if (aborted) {
        updateMessage(db, assistant.id, { content: buffer.trim(), status: 'interrupted', meta: { finish_reason: 'aborted' } });
        logRow('interrupted', { finish: 'aborted' });
        sse.send({ type: 'done', message: messageOut(db, one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', assistant.id)!), usage: null, ttftMs: null, totalMs: Date.now() - t0 });
      } else {
        const msg = err instanceof ModelError ? err.message : (err as Error)?.name === 'TimeoutError' ? '모델 응답 시간 초과' : (err as Error).message;
        ctx.log.error({ err, generationId }, '생성 실패');
        updateMessage(db, assistant.id, { content: buffer.trim(), status: 'error', meta: { error: msg } });
        logRow('error', { finish: 'error' });
        sse.send({ type: 'error', message: msg, messageId: assistant.id });
      }
    } finally {
      ctx.queue.unregister(generationId);
      sse.close();
    }
  }

  return async function plugin(app: FastifyInstance) {
    const sendSchema = z.object({ content: z.string().min(1).max(8000) });
    app.post<{ Params: { id: string } }>('/api/conversations/:id/messages', async (req, reply) => {
      const conv = loadConversation(ctx, req.params.id);
      if (!conv) return reply.code(404).send({ error: 'not found' });
      const p = sendSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: p.error.flatten() });
      if (ctx.queue.activeList.some((g) => g.conversationId === conv.id)) return reply.code(409).send({ error: '이 대화에서 이미 생성 중' });
      const user = insertMessage(db, conv.id, conv.head_message_id, 'user', p.data.content.trim(), 'complete', {});
      return generate(req, reply, conv, user.id, user);
    });

    const regenSchema = z.object({ messageId: z.string().min(1) });
    app.post<{ Params: { id: string } }>('/api/conversations/:id/regenerate', async (req, reply) => {
      const conv = loadConversation(ctx, req.params.id);
      if (!conv) return reply.code(404).send({ error: 'not found' });
      const p = regenSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: p.error.flatten() });
      const m = one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ? AND conversation_id = ?', p.data.messageId, conv.id);
      if (!m) return reply.code(404).send({ error: 'message not found' });
      if (m.status === 'streaming') return reply.code(409).send({ error: '생성 중' });
      // assistant 메시지 재생성 = 그 부모 아래 새 형제. user 메시지(응답 없이 끝난 경우) = 그 아래로 이어서 생성.
      const parentId = m.role === 'assistant' ? m.parent_id : m.id;
      return generate(req, reply, conv, parentId);
    });

    // 사용자 메시지 수정 후 재생성 = 같은 부모 아래 새 user 분기 + 생성
    const branchSchema = z.object({ messageId: z.string().min(1), content: z.string().min(1).max(8000) });
    app.post<{ Params: { id: string } }>('/api/conversations/:id/branch', async (req, reply) => {
      const conv = loadConversation(ctx, req.params.id);
      if (!conv) return reply.code(404).send({ error: 'not found' });
      const p = branchSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: p.error.flatten() });
      const m = one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ? AND conversation_id = ?', p.data.messageId, conv.id);
      if (!m || m.role !== 'user') return reply.code(404).send({ error: 'user message not found' });
      if (ctx.queue.activeList.some((g) => g.conversationId === conv.id)) return reply.code(409).send({ error: '이 대화에서 이미 생성 중' });
      const user = insertMessage(db, conv.id, m.parent_id, 'user', p.data.content.trim(), 'complete', {});
      return generate(req, reply, conv, user.id, user);
    });

    app.post<{ Params: { id: string } }>('/api/generations/:id/abort', async (req, reply) => {
      const ok = ctx.queue.abort(req.params.id);
      if (!ok) return reply.code(404).send({ error: '활성 생성 없음' });
      return { ok: true };
    });

    app.get('/api/generations/active', async () => ({
      active: ctx.queue.activeList.map((g) => ({ id: g.id, conversationId: g.conversationId, messageId: g.messageId, startedAt: g.startedAt })),
      queued: ctx.queue.queued,
    }));
  };
}
