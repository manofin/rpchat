import { loadStoryRoster } from '../prompt/dialogContext.js';
import { storyCastForGenerate } from '../prompt/composeBeat.js';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../ctx.js';
import type { ConversationRow, MessageRow, Scene } from '../types.js';
import { one, parseJson, run, uid, nowIso } from '../db/index.js';
import { insertMessage, setHead, parseMessageMeta } from '../db/tree.js';
import { buildSceneSnapshot } from '../db/sceneBase.js';
import { currentSceneVersion } from '../prompt/sceneDeltaPrompt.js';
import { AdventureError, adventureStateIssue, applyAdventureAction, INVALID_ADVENTURE_MESSAGE, requestSchema } from '../adventure/state.js';

/** Visible human action + server receipt form an ordinary branch-local turn.
 * No hidden anchor, model call, new table, or change to another branch's snapshot. */
export function adventureRoutes(ctx: Ctx) {
  const { db } = ctx;
  return async function plugin(app: FastifyInstance) {
    app.post<{ Params: { id: string } }>('/api/conversations/:id/adventure-actions', async (req, reply) => {
      const p = requestSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: '확인할 항목과 수치를 다시 확인해 주세요.', code: 'invalid-action' });
      const body = p.data;
      const conv = one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id = ?', req.params.id);
      if (!conv) return reply.code(404).send({ error: '대화를 찾을 수 없습니다.' });
      const scene = parseJson<Scene>(conv.scene_json, {});
      if (adventureStateIssue(scene.adventure) === 'invalid') {
        req.log.warn({ code: 'invalid_adventure_state', conversationId: conv.id, headId: conv.head_message_id }, 'invalid adventure state refused');
        return reply.code(409).send({ error: INVALID_ADVENTURE_MESSAGE, code: 'invalid_adventure_state' });
      }
      if (!conv.story_id) return reply.code(409).send({ error: '스토리 대화에서만 사용할 수 있습니다.', code: 'story-required' });
      if (!storyCastForGenerate(conv, loadStoryRoster(db, conv))?.length) return reply.code(409).send({ error: '참여자가 두 명 이상인 스토리 대화에서 사용할 수 있습니다.', code: 'party-required' });
      const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
      const prior = one<MessageRow>(db, `SELECT * FROM messages WHERE conversation_id = ? AND json_extract(meta_json, '$.adventure_receipt.key') = ? AND role = 'assistant'`, conv.id, body.idempotency_key);
      if (prior) {
        const receipt = parseMessageMeta(prior.meta_json).adventure_receipt!;
        if (receipt.hash !== hash) return reply.code(409).send({ error: '같은 확인 요청의 내용이 달라졌습니다.', code: 'idempotency-conflict' });
        return { messageId: prior.id, replay: true }; // retry must not select the old branch
      }
      if (conv.ended_at || ctx.queue.activeList.some(g => g.conversationId === conv.id)) {
        return reply.code(409).send({ error: '생성 중이거나 종료된 대화는 변경할 수 없습니다.', code: 'busy-or-ended' });
      }
      if (conv.head_message_id !== body.expected_head_id || currentSceneVersion(scene) !== body.expected_scene_version) {
        return reply.code(409).send({ error: '대화 상태가 바뀌었습니다. 최신 상태를 확인해 주세요.', code: 'stale-state' });
      }
      const head = one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ? AND conversation_id = ?', conv.head_message_id, conv.id);
      if (head?.role !== 'assistant' || head.status !== 'complete') {
        return reply.code(409).send({ error: '완료된 응답 뒤에서만 상태를 확인할 수 있습니다.', code: 'turn-boundary' });
      }
      try {
        const result = applyAdventureAction(scene.adventure, body.action, uid());
        const next: Scene = { ...scene, adventure: result.state, scene_version: currentSceneVersion(scene) + 1 };
        delete next.pending_edit;
        const messageId = db.transaction(() => {
          const current = one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id = ?', conv.id);
          if (current?.head_message_id !== conv.head_message_id || current.scene_json !== conv.scene_json) throw new AdventureError('stale-state', '대화 상태가 바뀌었습니다. 다시 확인해 주세요.');
          const receipt = { key: body.idempotency_key, hash, action: body.action };
          const user = insertMessage(db, conv.id, head.id, 'user', `상태 확인: ${result.summary}`, 'complete', { adventure_receipt: receipt });
          // Keep the prior state on this turn as well, including legacy openings
          // that have no assistant scene snapshot.
          run(db, 'UPDATE messages SET meta_json = ? WHERE id = ?', JSON.stringify({ ...parseMessageMeta(user.meta_json), adventure_before: scene }), user.id);
          const response = insertMessage(db, conv.id, user.id, 'assistant', `확인 기록\n${result.summary}\n소지금: ${result.state.balance} ${result.state.currency}`, 'complete', {
            block_kind: 'info', beat_seq: 0, generation_id: uid(), adventure_receipt: receipt,
            scene_state: buildSceneSnapshot(scene, next),
          });
          setHead(db, conv.id, response.id);
          run(db, 'UPDATE conversations SET scene_json = ?, last_message_at = ? WHERE id = ?', JSON.stringify(next), nowIso(), conv.id);
          return response.id;
        }).immediate();
        return reply.code(201).send({ messageId, replay: false });
      } catch (error) {
        if (error instanceof AdventureError) return reply.code(409).send({ error: error.message, code: error.code });
        req.log.warn({ err: error }, 'adventure state rejected');
        return reply.code(422).send({ error: '상태 기록을 검증하지 못했습니다. 저장하지 않았습니다.', code: 'invalid-state' });
      }
    });
  };
}
