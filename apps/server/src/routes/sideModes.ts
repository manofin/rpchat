import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { config } from '../config.js';
import { many, nowIso, one, run, uid } from '../db/index.js';
import { getPath, messageOut, updateMessage } from '../db/tree.js';
import { isSideModeMessage, sideModeVisible } from '../db/sideMode.js';
import { createChatEventStream, sanitizeGeneratedContent } from '../contracts/chatEventAdapter.js';
import { buildSideModePrompt, SIDE_MODE_MAX_TOKENS } from '../prompt/sideModePrompt.js';
import { loadProfile } from '../prompt/builder.js';
import type { ConversationRow, MessageMeta, MessageRow } from '../types.js';

const schema = z.object({ mode: z.enum(['summary', 'community']), prompt: z.string().max(2000).default('') }).strict();

export function sideModeRoutes(ctx: Ctx) {
  const { db } = ctx;
  return async function plugin(app: FastifyInstance) {
    app.get<{ Params: { id: string } }>('/api/conversations/:id/side-mode', async (req, reply) => {
      const conv = one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id = ?', req.params.id);
      if (!conv) return reply.code(404).send({ error: 'not found' });
      const ids = new Set(getPath(db, conv).map(row => row.id));
      return many<MessageRow>(db, 'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, id', conv.id)
        .filter(row => isSideModeMessage(row) && sideModeVisible(row, ids, conv.head_message_id))
        .map(row => {
          if (row.status === 'streaming' && !ctx.queue.activeList.some(g => g.messageId === row.id)) {
            updateMessage(db, row.id, { status: 'interrupted', meta: { finish_reason: 'orphan-streaming' } });
            row = one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', row.id)!;
          }
          return messageOut(db, row);
        });
    });

    app.post<{ Params: { id: string } }>('/api/conversations/:id/side-mode', async (req, reply) => {
      const conv = one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id = ?', req.params.id);
      if (!conv) return reply.code(404).send({ error: 'not found' });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      if (ctx.queue.activeList.some(g => g.conversationId === conv.id)) return reply.code(409).send({ error: '이 대화에서 이미 생성 중' });
      const profile = loadProfile(db, conv.profile_name);
      const model = profile.model || ctx.resolvedModel();
      if (!model) return reply.code(503).send({ error: '사용할 모델을 찾을 수 없음' });
      const { mode, prompt } = parsed.data;
      const built = buildSideModePrompt(db, conv, mode, prompt, config.model.contextTokens);
      if (built.overflow) return reply.code(422).send({ error: '요청이 모델의 컨텍스트 한도를 초과했습니다. 요청을 줄여 주세요.' });
      const id = uid();
      const generationId = uid();
      const startedAt = nowIso();
      const controller = new AbortController();
      const meta: MessageMeta = { side_mode: { mode, prompt, anchor_message_id: conv.head_message_id }, generation_id: generationId,
        block_kind: 'system', ooc: true, profile: conv.profile_name,
        observation: mode === 'summary' ? { visibility: 'private', recipient_ids: ['user', 'gm'], observer_ids: [] } : { visibility: 'public' } };
      // A side result is attached for deletion/provenance only. insertMessage would
      // also reorder the main conversation; no conversation column changes here.
      run(db, `INSERT INTO messages (id, conversation_id, parent_id, role, content, status, meta_json, bookmarked, created_at)
        VALUES (?, ?, ?, 'assistant', '', 'streaming', ?, 0, ?)`, id, conv.id, conv.head_message_id, JSON.stringify(meta), startedAt);
      updateMessage(db, id, { content: '' });
      const row = () => one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', id)!;
      const started = row();
      ctx.queue.register({ id: generationId, kind: 'side-mode', conversationId: conv.id, messageId: id, startedAt, controller });
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      let open = true;
      reply.raw.on('close', () => { open = false; });
      const send = (event: object) => { if (open) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`); };
      const stream = createChatEventStream({ ...started, meta });
      let buffer = '';
      const t0 = Date.now();
      send({ type: 'start', generationId, messageId: id, eventVersion: 1, message: messageOut(db, started) });
      try {
        const result = await ctx.queue.run(() => ctx.model.stream({ model, messages: built.messages, max_tokens: SIDE_MODE_MAX_TOKENS,
          temperature: mode === 'summary' ? .3 : .8, top_p: profile.top_p, signal: controller.signal, generationId }, token => {
          if (controller.signal.aborted) return;
          buffer += token;
          updateMessage(db, id, { content: sanitizeGeneratedContent(buffer, { streaming: true }) });
          send({ type: 'token', ...stream(buffer) });
        }), controller.signal);
        if (controller.signal.aborted) throw new Error('aborted');
        buffer = result.text;
        updateMessage(db, id, { content: sanitizeGeneratedContent(buffer), status: 'complete', meta: { usage: result.usage, finish_reason: result.finishReason } });
        send({ type: 'done', message: messageOut(db, row()), usage: result.usage, ttftMs: result.ttftMs, totalMs: result.totalMs, budget: built.budget });
      } catch (err) {
        const aborted = controller.signal.aborted || (err as Error)?.name === 'AbortError';
        const message = '부가 모드를 생성하지 못했습니다. 다시 시도해 주세요.';
        updateMessage(db, id, { content: sanitizeGeneratedContent(buffer, { streaming: true }), status: aborted ? 'interrupted' : 'error',
          meta: aborted ? { finish_reason: 'aborted' } : { error: message } });
        if (aborted) send({ type: 'done', message: messageOut(db, row()), usage: null, ttftMs: null, totalMs: Date.now() - t0, budget: built.budget });
        else {
          ctx.log?.error({ err, generationId }, '부가 모드 생성 실패');
          send({ type: 'error', message, messageId: id });
        }
      } finally {
        ctx.queue.unregister(generationId);
        if (open) { open = false; reply.raw.end(); }
      }
    });
  };
}
