import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { config, PROMPT_VERSION } from '../config.js';
import { getSetting, nowIso, one, parseJson, run, uid } from '../db/index.js';
import { readSceneSnapshot } from '../db/sceneBase.js';
import { getPath, insertMessage, messageOut, parseMessageMeta, resolveTurnStart, setHead, updateMessage } from '../db/tree.js';
import type { ChatMessage, ConversationRow, MessageMeta, MessageRow, Scene } from '../types.js';
import { createChatEventStream, sanitizeGeneratedContent } from '../contracts/chatEventAdapter.js';
import { buildPrompt, loadProfile, resolvePersona } from '../prompt/builder.js';
import { dialogPlanInput, loadStoryRoster } from '../prompt/dialogContext.js';
import { buildDialogPrompt } from '../prompt/dialogPrompt.js';
import { finishDialogBeat, planDialogBeat } from '../prompt/composeDialog.js';
import { storyCastForGenerate } from '../prompt/composeBeat.js';
import { previewDraftMessage } from '../prompt/promptHistory.js';
import { attachInjectToIcPass } from '../prompt/injectContext.js';
import { profileInstructionText } from '../prompt/promptPolicy.js';
import { renderPassF, renderPassN } from '../prompt/passes.js';
import { renderProfileInstruction, renderScene } from '../prompt/templates.js';
import { responseLengthHint, responseMaxTokens } from '../prompt/responseLength.js';
import { estimateMessageTokens, getCalibration } from '../prompt/tokens.js';
import { audienceOf, GM, inheritedAudience, observationText, project, PUBLIC, speechObservation, successfulObservationRows } from '../prompt/observation.js';
import { loadConversation } from './conversations.js';

const CONTINUE = '직전 응답의 마지막 부분에서 이어 쓴다. 이미 쓴 내용을 반복하거나 처음부터 다시 쓰지 않는다. 새 사용자 입력·행동을 만들지 않는다. 장면·시간·턴·관계·엔딩을 진행하거나 바꾸지 않는다. 선택지·상태·시스템 로그는 출력하지 않는다.';

/** Additional prose belongs to the existing turn; planning here never commits a scene delta. */
export function buildContinuation(ctx: Ctx, conv: ConversationRow, history: MessageRow[]) {
  const { db } = ctx;
  const scene = parseJson<Scene>(conv.scene_json, {});
  const target = [...history].reverse().find(row => row.role === 'assistant' && ['complete', 'interrupted'].includes(row.status)
    && [undefined, 'line', 'narration'].includes(parseMessageMeta(row.meta_json).block_kind));
  if (!target?.content.trim()) throw new Error('이어 쓸 응답이 없습니다.');
  const profile = loadProfile(db, conv.profile_name);
  const roster = loadStoryRoster(db, conv);
  const cast = storyCastForGenerate(conv, roster);
  // Only the beat runtime has a per-speaker observation boundary. A format switch
  // must not turn an existing whisper into a narrator/ordinary prompt.
  if ((!cast?.length || scene.format === 'dialog') && history.some(row => audienceOf(row)?.visibility === 'private')) {
    throw new Error('비공개 대화가 있는 분기는 비트 형식에서만 이어 쓸 수 있습니다.');
  }
  const sourceMeta = parseMessageMeta(target.meta_json);
  const headMeta = parseMessageMeta(history.at(-1)!.meta_json);
  if (headMeta.generation_id && sourceMeta.generation_id !== headMeta.generation_id) throw new Error('현재 턴에 이어 쓸 본문이 없습니다.');
  let continuationInput = `${CONTINUE}\n\n## 이어 쓸 직전 응답 (이미 표시한 본문)\n${sanitizeGeneratedContent(target.content)}`;
  const virtualHistory = [...history, previewDraftMessage(conv.id, conv.head_message_id, continuationInput)];
  if (!cast?.length) {
    let built = buildPrompt(db, conv, virtualHistory, config.model.contextTokens, ctx.resolvedModel());
    const cal = getCalibration(db);
    const available = config.model.contextTokens - built.profile.max_tokens - 64;
    const cost = () => built.messages.reduce((sum, m) => sum + estimateMessageTokens(m.content, cal), 0);
    while (cost() > available && virtualHistory.length > 1) {
      virtualHistory.shift();
      built = buildPrompt(db, conv, virtualHistory, config.model.contextTokens, ctx.resolvedModel());
    }
    built.budget.est_total = cost();
    built.budget.available = available;
    if (cost() > available) built.budget.instruction_overflow = { profile: profile.name, instruction_tokens: 0, required: cost(), available };
    return { messages: built.messages, budget: built.budget, model: built.model, maxTokens: built.profile.max_tokens,
      temperature: built.profile.temperature, topP: built.profile.top_p, stop: built.stop,
      meta: {} as MessageMeta, finish: (raw: string) => [{ text: sanitizeGeneratedContent(raw), meta: {} as MessageMeta }] };
  }
  if (scene.format === 'dialog') {
    const userText = [...history].reverse().find(row => row.role === 'user')?.content ?? '';
    const input = dialogPlanInput(db, conv, scene, userText, target.id)!;
    const plan = planDialogBeat(input);
    const built = buildDialogPrompt(db, conv, virtualHistory, `${plan.pass_s}\n\n${CONTINUE}`, continuationInput,
      config.model.contextTokens, ctx.resolvedModel(), undefined, scene);
    return { messages: built.messages, budget: built.budget, model: built.model, maxTokens: built.maxTokens,
      temperature: 0.9, topP: 0.95, stop: [],
      meta: { chat_event_script: true, chat_event_actors: plan.speakers.map(({ id, name, aliases }) => ({ id, name, aliases })) } as MessageMeta,
      finish: (raw: string) => finishDialogBeat(input, plan, raw).blocks.filter(b => b.kind !== 'info' && b.kind !== 'header' && b.kind !== 'ui').map(b => ({
        text: b.text, meta: { block_kind: b.kind, speaker_character_id: b.speaker_character_id ?? undefined,
          speaker_name: b.speaker_name ?? undefined, image_url: b.asset_path ?? undefined } as MessageMeta,
      })) };
  }
  const actor = sourceMeta.block_kind === 'line' ? sourceMeta.speaker_character_id : undefined;
  const speaker = actor ? cast.find(c => c.id === actor) : undefined;
  if (actor && !speaker) throw new Error('직전 화자를 복원할 수 없습니다.');
  const card = speaker ? one<import('../types.js').CharacterRow>(db, 'SELECT * FROM characters WHERE id = ?', speaker.id) : undefined;
  if (speaker && !card) throw new Error('직전 화자 카드를 복원할 수 없습니다.');
  const enabled = scene.observation_filter === true || history.some(row => audienceOf(row)?.visibility === 'private');
  const observer = actor ?? GM;
  const scope = audienceOf(target);
  // Unknown/private provenance must not become a public continuation.
  const targetText = project(observationText(target, enabled, observer), scope, observer, enabled);
  if (!targetText.trim()) throw new Error('직전 응답의 공개 범위를 복원할 수 없습니다.');
  continuationInput = `${CONTINUE}\n\n## 이어 쓸 직전 응답 (이미 표시한 본문)\n${targetText}`;
  const cal = getCalibration(db);
  const maxTokens = responseMaxTokens(scene, 500);
  const available = config.model.contextTokens - maxTokens - 64;
  const eligible = enabled ? successfulObservationRows(history) : history;
  const candidates = eligible.filter(row => row.id !== target.id).map(row => ({ row,
    text: project(observationText(row, enabled, observer), audienceOf(row), observer, enabled),
  })).filter(item => item.text.trim());
  const selected = [...candidates];
  const rawInstruction = profileInstructionText(profile);
  const userName = resolvePersona(db, conv)?.name || '나';
  const instruction = rawInstruction ? renderProfileInstruction(rawInstruction, '## 서술 지침', speaker?.name ?? '', userName) : null;
  const render = (): string => {
    const context = [renderScene(scene), ...selected.map(item => item.text)].filter(Boolean).join('\n\n');
    const core = card ? renderPassF({ focusCard: card, userName, userText: continuationInput, scene, header: null,
      narration: context, cast, contentPolicy: getSetting(db, 'content_policy', '') })
      : renderPassN({ focusCard: null, cast, scene, header: null, userText: continuationInput, ambientNames: [], recentNarrations: [context] });
    return attachInjectToIcPass(core + responseLengthHint(scene) + `\n\n${CONTINUE}`, null, {
      promptTokenBudget: Number.MAX_SAFE_INTEGER, calibration: cal, profileInstruction: instruction,
    }).prompt;
  };
  let prompt = render();
  while (estimateMessageTokens(prompt, cal) > available && selected.length) { selected.shift(); prompt = render(); }
  const est = estimateMessageTokens(prompt, cal);
  const audience = enabled ? inheritedAudience([scope, ...selected.map(item => audienceOf(item.row))], observer) : PUBLIC;
  const meta: MessageMeta = { block_kind: speaker ? 'line' : 'narration', speaker_character_id: speaker?.id,
    speaker_name: speaker?.name, observation: audience };
  return { messages: [{ role: 'user', content: prompt }] as ChatMessage[], model: ctx.resolvedModel(), maxTokens, temperature: 0.9, topP: 0.95, stop: [],
    budget: { est_total: est, available, dropped_messages: candidates.length - selected.length, included_messages: selected.length + 1,
      ...(est > available ? { instruction_overflow: { required: est, available } } : {}) }, meta,
    finish: (raw: string) => [{ text: sanitizeGeneratedContent(raw), meta: { ...meta,
      observation_text: speechObservation(raw, audience, enabled) } }] };
}

export function continuationRoutes(ctx: Ctx) {
  const { db } = ctx;
  return async function plugin(app: FastifyInstance) {
    app.post<{ Params: { id: string } }>('/api/conversations/:id/continue', async (req, reply) => {
      const conv = loadConversation(ctx, req.params.id);
      if (!conv) return reply.code(404).send({ error: 'not found' });
      const input = z.object({ messageId: z.string().min(1) }).strict().safeParse(req.body);
      if (!input.success) return reply.code(400).send({ error: '이어 쓸 메시지를 지정해 주세요.' });
      if (conv.ended_at) return reply.code(409).send({ error: '종료한 대화입니다.' });
      if (ctx.queue.activeList.some(g => g.conversationId === conv.id)) return reply.code(409).send({ error: '이 대화에서 이미 생성 중' });
      const history = getPath(db, conv);
      const head = history.at(-1);
      if (!head || head.id !== input.data.messageId || head.role !== 'assistant' || !['complete', 'interrupted'].includes(head.status)) {
        return reply.code(409).send({ error: '현재 마지막 응답에서만 이어 쓸 수 있습니다.' });
      }
      const headMeta = parseMessageMeta(head.meta_json);
      if (headMeta.beat_seq !== undefined || headMeta.chat_event_script) {
        const turn = resolveTurnStart(db, head);
        const start = turn.kind === 'multi' ? one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', turn.startId) : undefined;
        if (!start || start.status !== 'complete' || !readSceneSnapshot(parseMessageMeta(start.meta_json))) {
          return reply.code(409).send({ error: '중단된 새 턴은 재생성으로 복구해 주세요. 이어쓰기는 완료된 턴에만 덧붙일 수 있습니다.' });
        }
      }
      let built: ReturnType<typeof buildContinuation>;
      try { built = buildContinuation(ctx, conv, history); }
      catch (err) { req.log.warn({ err }, 'continuation preflight failed'); return reply.code(422).send({ error: '이어쓰기 맥락을 구성할 수 없습니다. 직전 응답과 공개 범위를 확인해 주세요.' }); }
      if (!built.model) return reply.code(503).send({ error: '모델 이름을 확인할 수 없습니다.' });
      if (built.budget.instruction_overflow) return reply.code(422).send({ error: '이어쓰기 맥락이 모델의 입력 한도를 넘습니다.' });
      const generationId = uid();
      const controller = new AbortController();
      const oldMeta = parseMessageMeta(head.meta_json);
      const multi = typeof oldMeta.beat_seq === 'number';
      const startSeq = multi ? oldMeta.beat_seq! + 1 : undefined;
      const rowMeta: MessageMeta = { ...built.meta, continuation_of: head.id, generation_id: multi ? oldMeta.generation_id : generationId,
        beat_seq: startSeq, profile: conv.profile_name, prompt_version: PROMPT_VERSION };
      const row = insertMessage(db, conv.id, head.id, 'assistant', '', 'streaming', rowMeta);
      setHead(db, conv.id, row.id);
      ctx.queue.register({ id: generationId, conversationId: conv.id, messageId: row.id, startedAt: nowIso(), controller });
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform' });
      const send = (event: unknown) => { if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`); };
      const out = (id: string) => messageOut(db, one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', id)!);
      send({ type: 'start', generationId, messageId: row.id, eventVersion: 1, message: out(row.id) });
      const streamEvents = createChatEventStream({ ...row, meta: parseMessageMeta(row.meta_json) });
      let buffer = '';
      let lastPersist = Date.now();
      const started = Date.now();
      const log = (status: string, finish: string | null, usage: {prompt_tokens?:number; completion_tokens?:number} | null, totalMs: number) => {
        run(db, `INSERT INTO generation_log (id,conversation_id,message_id,profile_name,prompt_version,est_prompt_tokens,actual_prompt_tokens,completion_tokens,total_ms,finish_reason,status,budget_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          generationId, conv.id, row.id, conv.profile_name, PROMPT_VERSION, built.budget.est_total, usage?.prompt_tokens ?? null, usage?.completion_tokens ?? null,
          totalMs, finish, status, JSON.stringify({ ...built.budget, continuation_of: head.id }), nowIso());
      };
      try {
        const result = await ctx.queue.run(() => ctx.model.stream({ model: built.model, messages: built.messages,
          max_tokens: built.maxTokens, temperature: built.temperature, top_p: built.topP, stop: built.stop, signal: controller.signal, generationId }, delta => {
          buffer += delta;
          send({ type: 'token', ...streamEvents(buffer) });
          if (Date.now() - lastPersist > 800) { updateMessage(db, row.id, { content: buffer }); lastPersist = Date.now(); }
        }), controller.signal);
        if (controller.signal.aborted) throw new Error('aborted');
        const blocks = built.finish(result.text).filter(b => b.text.trim());
        if (!blocks.length) throw new Error('empty continuation');
        db.transaction(() => {
          updateMessage(db, row.id, { content: blocks[0].text, status: 'complete', meta: { ...blocks[0].meta, finish_reason: result.finishReason, usage: result.usage } });
          let parent = row.id;
          for (const [i, block] of blocks.slice(1).entries()) {
            const extra = insertMessage(db, conv.id, parent, 'assistant', block.text, 'complete', { ...rowMeta, ...block.meta,
              beat_seq: startSeq === undefined ? undefined : startSeq + i + 1, finish_reason: result.finishReason });
            parent = extra.id;
          }
          setHead(db, conv.id, parent);
          log('complete', result.finishReason, result.usage, result.totalMs);
        })();
        const updatedPath = getPath(db, loadConversation(ctx, conv.id)!);
        const firstIndex = updatedPath.findIndex(m => m.id === row.id);
        for (const extra of updatedPath.slice(firstIndex + 1)) send({ type: 'aux', message: messageOut(db, extra) });
        send({ type: 'done', message: out(row.id), usage: result.usage, ttftMs: result.ttftMs, totalMs: result.totalMs, budget: built.budget });
      } catch (err) {
        const content = sanitizeGeneratedContent(buffer);
        updateMessage(db, row.id, { content, status: controller.signal.aborted ? 'interrupted' : 'error', meta: { finish_reason: controller.signal.aborted ? 'aborted' : 'error' } });
        if (!content.trim()) setHead(db, conv.id, head.id);
        log(controller.signal.aborted ? 'interrupted' : 'error', controller.signal.aborted ? 'aborted' : 'error', null, Date.now() - started);
        req.log.warn({ err }, 'continuation failed');
        send({ type: 'error', message: controller.signal.aborted ? '이어쓰기를 중단했습니다.' : '이어쓰기에 실패했습니다. 기존 응답은 보존되었습니다.', messageId: row.id });
      } finally {
        ctx.queue.unregister(generationId);
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      }
    });
  };
}
