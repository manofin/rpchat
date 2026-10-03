import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { many, nowIso, parseJson, run } from '../db/index.js';
import { getPath } from '../db/tree.js';
import { buildActorContext, dialogContextSchema, invalidAssignmentAnchor } from '../prompt/dialogActorContext.js';
import { loadStoryRoster } from '../prompt/dialogContext.js';
import { resolvePersona } from '../prompt/builder.js';
import { getCalibration } from '../prompt/tokens.js';
import type { MemoryRow, Scene } from '../types.js';
import { loadConversation } from './conversations.js';

const saveSchema = z.object({ headMessageId: z.string().min(1).nullable(), entry: z.unknown() }).strict();

export function dialogKnowledgeRoutes(ctx: Ctx) {
  return async function plugin(app: FastifyInstance) {
    app.get<{ Params: { id: string } }>('/api/conversations/:id/knowledge', async (req, reply) => {
      const conv = loadConversation(ctx, req.params.id);
      if (!conv) return reply.code(404).send({ error: '대화를 찾을 수 없습니다.' });
      const scene = parseJson<Scene>(conv.scene_json, {});
      const actors = loadStoryRoster(ctx.db, conv).map(({ id, name }) => ({ id, name }));
      const parsed = dialogContextSchema.safeParse(scene.dialog_context ?? { version: 1, entries: [] });
      const assigned = buildActorContext(ctx.db, conv, new Set(getPath(ctx.db, conv).map(m => m.id)), scene.dialog_context, actors, Infinity, getCalibration(ctx.db));
      const ids = actors.map(a => a.id);
      const memories = many<MemoryRow>(ctx.db,
        `SELECT * FROM memories WHERE status = 'pinned' AND (conversation_id = ?${ids.length ? ` OR (scope = 'character' AND character_id IN (${ids.map(() => '?').join(',')}))` : ''}) ORDER BY importance DESC, created_at`,
        conv.id, ...ids);
      return {
        enabled: scene.format === 'dialog' && actors.length > 0,
        headMessageId: conv.head_message_id,
        userName: resolvePersona(ctx.db, conv)?.name || '사용자',
        actors, memories, entries: parsed.success ? parsed.data.entries : [],
        excluded: assigned.packet.excluded,
        invalidContract: !parsed.success,
      };
    });

    app.put<{ Params: { id: string; memoryId: string } }>('/api/conversations/:id/knowledge/:memoryId', async (req, reply) => {
      const conv = loadConversation(ctx, req.params.id);
      if (!conv) return reply.code(404).send({ error: '대화를 찾을 수 없습니다.' });
      const scene = parseJson<Scene>(conv.scene_json, {});
      if (scene.format !== 'dialog') return reply.code(400).send({ error: '인물별 기억은 대본 형식에서 지정합니다.' });
      const p = saveSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: p.error.flatten() });
      if (ctx.queue.activeList.some(g => g.conversationId === conv.id)) return reply.code(409).send({ error: '생성 중에는 기억 범위를 수정할 수 없습니다.' });
      if (p.data.headMessageId !== conv.head_message_id) return reply.code(409).send({ error: '대화 분기가 바뀌었습니다. 다시 열어 확인해 주세요.' });
      const existing = dialogContextSchema.safeParse(scene.dialog_context ?? { version: 1, entries: [] });
      if (!existing.success) return reply.code(409).send({ error: '기존 기억 지정 정보를 읽을 수 없어 저장하지 않았습니다.' });
      const entries = existing.data.entries.filter(e => e.memory_id !== req.params.memoryId);
      if (p.data.entry !== null) {
        const spec = dialogContextSchema.safeParse({ version: 1, entries: [{ ...(p.data.entry as object), memory_id: req.params.memoryId }] });
        if (!spec.success) return reply.code(400).send({ error: spec.error.flatten() });
        const pathIds = new Set(getPath(ctx.db, conv).map(m => m.id));
        if (invalidAssignmentAnchor(ctx.db, conv.id, pathIds, spec.data)) return reply.code(400).send({ error: '기억은 현재 분기의 저장된 대화에서 확인해 주세요.' });
        // Validate an active copy so resolved entries cannot hide an invalid source or recipient.
        const checked = buildActorContext(ctx.db, conv, pathIds,
          { version: 1, entries: [{ ...spec.data.entries[0], status: 'active' }] },
          loadStoryRoster(ctx.db, conv), Infinity, getCalibration(ctx.db));
        if (checked.packet.excluded.length) return reply.code(400).send({ error: '채택된 현재 분기의 기억과 등장인물만 지정할 수 있습니다.', reason: checked.packet.excluded[0].reason });
        entries.push(spec.data.entries[0]);
      }
      const next = dialogContextSchema.safeParse({ version: 1, entries });
      if (!next.success) return reply.code(400).send({ error: next.error.flatten() });
      const updated: Scene = { ...scene, dialog_context: next.data, pending_edit: { head_message_id: conv.head_message_id } };
      run(ctx.db, 'UPDATE conversations SET scene_json = ?, updated_at = ? WHERE id = ?', JSON.stringify(updated), nowIso(), conv.id);
      return { headMessageId: conv.head_message_id, entries: next.data.entries };
    });
  };
}
