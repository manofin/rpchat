import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { PROMPT_VERSION, config } from '../config.js';
import { getSetting, many, nowIso, one, parseJson, run, uid } from '../db/index.js';
import { interruptOrphanStreaming } from '../db/generation.js';
import { getPath, insertMessage, messageOut, resolveTurnStart, setHead, updateMessage } from '../db/tree.js';
import { buildSceneSnapshot, resolveSceneBase } from '../db/sceneBase.js';
import { ModelError } from '../model/adapter.js';
import {
  finishBeat, passCWith, passFWith, planBeat, planPassE, partyCastForGenerate,
  type BeatPlanInput,
} from '../prompt/composeBeat.js';
import {
  finishDialogBeat, planDialogBeat, type DialogPlanInput,
} from '../prompt/composeDialog.js';
import {
  finishHunterBeat, planHunterBeat, type HunterPlanInput,
} from '../prompt/composeHunter.js';
import type { PartyTagRow } from '../prompt/tagsCatalog.js';
import { catalogFromStory } from '../prompt/sceneCatalog.js';
import { currentSceneVersion, parseSceneDelta, renderSceneDeltaPrompt } from '../prompt/sceneDeltaPrompt.js';
import { PASS_E_MAX_SENTENCES, PASS_N_RECENT_NARRATIONS } from '../prompt/passes.js';
import { parseChoicesPass } from '../prompt/beatChoices.js';
import { resolvePersona } from '../prompt/builder.js';
import type { PassCard } from '../prompt/passes.js';
import type { CharacterRow } from '../types.js';
import { buildPrompt } from '../prompt/builder.js';
import { dumpGenerationPrompt } from '../prompt/dump.js';
import { extractChoices } from '../prompt/templates.js';
import { estimateTokens, updateCalibration } from '../prompt/tokens.js';
import type { ConversationRow, MessageRow, Scene } from '../types.js';
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
  // f9-swap-passes: every beat block except the streamed one arrives here. `aux`
  // is already append-only and id-deduped on the client, which is exactly the
  // semantics a header / narration / thought / extra / ui row needs.
  | { type: 'aux'; message: ReturnType<typeof messageOut> }
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
/** f9-live-scene-delta: the proposal is a one-line JSON verdict, not prose. */
const SCENE_DELTA_MAX_TOKENS = 200;
/** f9-swap-passes: a secondary interjects, it does not take the scene over. */
const AUX_MAX_TOKENS = 220;
/** Pass N is scene-setting, not a chapter. */
const PASS_N_MAX_TOKENS = 300;
/** Pass N failing must not cost the turn, so it gets a short leash. */
const PASS_N_TIMEOUT_MS = 20_000;
const PASS_E_TIMEOUT_MS = 15_000;
/**
 * optimize-beat-choices-latency: the beat's own short contract (별표 한 조각 +
 * 한 문장, 50자). n=50 interleaved vs the long form: completion p50 64 / p95 70
 * / max 71 (`bench/partyBench/results/choices-ab-2026-09-05T08-12-49-965Z.json`).
 * 160 is ~2.2× that max — enough that a well-formed tag is not truncated, tight
 * enough that a model ignoring the length rule cannot spend the 8s the long
 * form did. The 1:1 path keeps the profile budget.
 */
const PASS_C_MAX_TOKENS = 160;
/**
 * Measured, not guessed: at n=50 the shipped prompt runs p50 8.14s / p95 10.26s /
 * max 11.69s (`bench/partyBench/results/beat-choices-2026-09-05T07-32-23-602Z.json`).
 * A 12s leash — the first value written here — sat 0.3s above the worst observed
 * sample, which would have turned an ordinary long turn into a silent fail-open.
 * 20s is Pass N's leash and roughly 1.7x the observed max. Past that the chips are
 * not worth the wait, and the reader is already looking at a finished beat.
 */
const PASS_C_TIMEOUT_MS = 20_000;
/**
 * dialog-format: Pass S writes the whole turn — narration and every line — so it
 * needs the room the beat path splits across N + F + E. It is also the only call
 * that turn, which is why one budget this size still costs less than the mix.
 */
const PASS_S_MAX_TOKENS = 900;
/**
 * hunter-format: Pass H writes the whole turn (narration-dominant — Huntt.txt is
 * 83 『』 blocks vs 42 lines) plus a trailing state fence. Same "one call instead
 * of N+F+E" trade as Pass S; the budget is a little larger because a hunter turn
 * is mostly prose.
 */
const PASS_H_MAX_TOKENS = 1200;

/**
 * Per-pass deadline. The model client has one global timeout tuned for a full 1:1
 * turn, which is far too generous for a four-sentence narration — and §7's whole
 * defence against a five-call beat is that a stalled optional pass gets dropped
 * fast rather than adding a minute to the turn. Composing a signal here keeps that
 * local to the beat path instead of changing the shared client for 1:1 too.
 */
function withDeadline(ms: number, parent: AbortSignal): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('pass timeout')), ms);
  const onAbort = () => ctrl.abort(parent.reason);
  if (parent.aborted) ctrl.abort(parent.reason);
  else parent.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctrl.signal,
    done: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', onAbort);
    },
  };
}

export function chatRoutes(ctx: Ctx) {
  const { db } = ctx;

  // scene-branch-snapshot: last_beat / turn_no are not known until finish, so the
  // start row is stamped here rather than at insert. One extra UPDATE per successful
  // multi-row turn; interrupted turns keep no snapshot and fall back.
  const stampTurnScene = (startId: string | undefined, before: Scene, after: Scene) => {
    if (!startId) return;
    updateMessage(db, startId, { meta: { scene_state: buildSceneSnapshot(before, after) } });
  };

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
  async function generate(
    req: FastifyRequest,
    reply: FastifyReply,
    conv: ConversationRow,
    parentId: string | null,
    userMessage?: MessageRow,
    /**
     * scene-branch-snapshot: set only by /regenerate, and only for a multi-row
     * turn — the start block of the turn being replaced. It cannot be derived from
     * `parentId`, because replacing a turn and continuing after one both arrive
     * here with the same user message as the parent.
     */
    regenTurnStartId?: string | null,
  ) {
    interruptOrphanStreaming(db, { keepMessageIds: ctx.queue.activeList.map((g) => g.messageId) });
    if (ctx.queue.activeList.some((g) => g.conversationId === conv.id)) return reply.code(409).send({ error: '이 대화에서 이미 생성 중' });

    setHead(db, conv.id, parentId);
    let convNow = loadConversation(ctx, conv.id)!;

    const generationId = uid();
    // f9-tags-catalog: a party roster only exists for story-hosted conversations.
    // story_id is null on every 1:1 row, so this costs a 1:1 turn zero queries.
    const partyRoster: PartyTagRow[] = convNow.story_id
      ? many<PartyTagRow>(
          db,
          `SELECT c.id, c.name, c.tags_json
             FROM story_characters sc
             JOIN characters c ON c.id = sc.character_id
            WHERE sc.story_id = ?
            ORDER BY sc.sort_order ASC, c.name ASC`,
          convNow.story_id,
        )
      : [];
    const partyCast = partyCastForGenerate(convNow, partyRoster);

    // f9-swap-passes: a party conversation does not build a 1:1 prompt at all.
    // It assembles one beat out of several narrow calls (§5), so it takes its own
    // path and `buildPrompt` is never reached below.
    if (partyCast && partyCast.length) {
      // dialog-format: same cast gate, different output shape. The switch is scene
      // state, so a conversation opts in without touching any other conversation.
      const fmt = (JSON.parse(convNow.scene_json || '{}') as Scene).format;
      if (fmt === 'dialog') {
        return generateDialog(req, reply, conv, parentId, convNow, partyCast, partyRoster, generationId, userMessage, regenTurnStartId ?? null);
      }
      if (fmt === 'hunter') {
        return generateHunter(req, reply, conv, parentId, convNow, partyCast, partyRoster, generationId, userMessage, regenTurnStartId ?? null);
      }
      return generateBeat(req, reply, conv, parentId, convNow, partyCast, partyRoster, generationId, userMessage, regenTurnStartId ?? null);
    }

    const history = getPath(db, convNow);

    let built;
    try {
      built = buildPrompt(db, convNow, history, config.model.contextTokens, ctx.resolvedModel());
    } catch (err) {
      return reply.code(500).send({ error: `프롬프트 조립 실패: ${(err as Error).message}` });
    }
    if (!built.model) return reply.code(503).send({ error: '모델 이름을 해석할 수 없음 (MODEL_NAME 설정 또는 모델 서버 확인)' });

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
            generationId,
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

  /**
   * f9-swap-passes — the party path. One user input, one assembled beat (§4, §6).
   *
   * Deliberately NOT `buildPrompt`: the 1:1 builder assembles a single system
   * prompt for one character, and a beat is several narrow calls whose cards do
   * not overlap. Keeping the two paths separate is also what makes the "1:1 system
   * block bytes unchanged" gate meaningful — this function cannot affect it.
   *
   * Failure policy (A-6 / §3): nothing here kills the turn except Pass F.
   *   delta   → scene unchanged, beat continues
   *   Pass N  → no narration block, beat continues
   *   Pass E  → that extra is dropped, beat continues
   *   Pass F  → status='error', same as the 1:1 path
   */
  async function generateBeat(
    req: FastifyRequest,
    reply: FastifyReply,
    conv: ConversationRow,
    parentId: string | null,
    convNow: ConversationRow,
    cast: NonNullable<ReturnType<typeof partyCastForGenerate>>,
    roster: PartyTagRow[],
    generationId: string,
    userMessage: MessageRow | undefined,
    regenTurnStartId: string | null,
  ) {
    const model = ctx.resolvedModel();
    if (!model) return reply.code(503).send({ error: '모델 이름을 해석할 수 없음 (MODEL_NAME 설정 또는 모델 서버 확인)' });

    // scene-branch-snapshot: plan against the branch this generation is on, not
    // against the conversation row. On a regenerate the conversation row already
    // holds the abandoned turn's delta, which is how repeats used to accumulate.
    const sceneBase = resolveSceneBase(db, {
      conversationScene: JSON.parse(convNow.scene_json || '{}') as Scene,
      parentId,
      regenTurnStartId,
    });
    const scene = sceneBase.scene;
    // f9-place-catalog: places/arcs/stages come from the Story layer, so the GM can
    // move the scene somewhere no cast member currently stands. Read live because
    // this is a server-side validation allow-list, not narrative text.
    const storyCatalogRow = one<{ scene_catalog: string }>(
      db, 'SELECT scene_catalog FROM stories WHERE id = ?', convNow.story_id,
    );
    const catalog = catalogFromStory(storyCatalogRow?.scene_catalog ?? '{}');
    const baseVersion = currentSceneVersion(scene);
    const userText = userMessage?.content ?? '';

    // Turn Pipeline step 2-4: propose → validate → apply. One short call; any
    // failure leaves the scene untouched and the beat continues.
    let patch: Record<string, unknown> | null = null;
    const passMs: { delta: number; n: number; f: number; e: number[]; c: number } = { delta: 0, n: 0, f: 0, e: [], c: 0 };
    const t0delta = Date.now();
    try {
      const proposal = await ctx.queue.run(() =>
        ctx.model.complete({
          model,
          messages: [{ role: 'user', content: renderSceneDeltaPrompt({ scene, catalog: { ...catalog, cast }, userText }) }],
          temperature: 0.2,
          top_p: 0.9,
          max_tokens: SCENE_DELTA_MAX_TOKENS,
          stop: [],
        }),
      );
      patch = parseSceneDelta(proposal.text);
    } catch (err) {
      req.log.warn({ err, conversationId: conv.id }, 'scene delta proposal failed; scene unchanged');
    }
    passMs.delta = Date.now() - t0delta;

    const cards: Record<string, PassCard> = {};
    for (const row of many<CharacterRow>(
      db,
      `SELECT * FROM characters WHERE id IN (${roster.map(() => '?').join(',')})`,
      ...roster.map((r) => r.id),
    )) {
      cards[row.id] = {
        name: row.name,
        tagline: row.tagline,
        description: row.description,
        personality: row.personality,
        speech_style: row.speech_style,
        taboos: row.taboos,
      };
    }

    const persona = resolvePersona(db, convNow);
    // narration-continuity: the last narrations already on screen, read off the
    // active branch. `getPath` is the tree reader the 1:1 prompt uses for the same
    // reason — after a regenerate or a swipe the abandoned sibling is still in the
    // table, and feeding Pass N a narration the user never saw would make it avoid
    // repeating something that is not there.
    const recentNarrations = getPath(db, convNow)
      .filter((m) => m.role === 'assistant' && parseJson<{ block_kind?: string }>(m.meta_json, {}).block_kind === 'narration')
      .slice(-PASS_N_RECENT_NARRATIONS)
      .map((m) => m.content.trim())
      .filter(Boolean);
    const planInput: BeatPlanInput = {
      conversation_id: conv.id,
      scene,
      patch: patch ?? undefined,
      catalog,
      current_version: baseVersion,
      user_text: userText,
      user_name: persona?.name || '나',
      cast,
      cards,
      main_character_id: convNow.character_id,
      message_id: userMessage?.id ?? null,
      content_policy: getSetting(db, 'content_policy', ''),
      recent_narrations: recentNarrations,
    };
    const plan = planBeat(planInput);

    // Persist the applied scene before generating, so the passes and any concurrent
    // reader see the same world the focus was resolved against.
    if (!plan.applied.discarded && plan.applied.applied.length > 0) {
      run(db, `UPDATE conversations SET scene_json = ?, updated_at = ? WHERE id = ?`,
        JSON.stringify(plan.applied.state), nowIso(), conv.id);
    }

    const profileName = convNow.profile_name;
    const sse = openSse(reply);
    const controller = new AbortController();

    let head = parentId;
    const emitted: MessageRow[] = [];
    /** Creates a beat block row, chained under the previous one. */
    const addBlock = (
      kind: 'header' | 'narration' | 'line' | 'thought' | 'ui',
      content: string,
      meta: Record<string, unknown> = {},
    ): MessageRow => {
      const row = insertMessage(db, conv.id, head, 'assistant', content, 'complete', {
        generation_id: generationId, profile: profileName, prompt_version: PROMPT_VERSION,
        block_kind: kind, beat_seq: emitted.length, ...meta,
      });
      setHead(db, conv.id, row.id);
      head = row.id;
      emitted.push(row);
      return row;
    };
    const send = (row: MessageRow) =>
      sse.send({ type: 'aux', message: messageOut(db, one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', row.id)!) });

    ctx.queue.register({ id: generationId, conversationId: conv.id, messageId: '', startedAt: nowIso(), controller });

    let focusRow: MessageRow | null = null;
    let focusSeq = 0;
    let started = false;
    let buffer = '';
    const tBeat = Date.now();

    try {
      // The user's own message goes out first. `start` also carries it (and the
      // client dedupes by id), but `start` does not fire until Pass F begins, and
      // by then the header and narration rows would already have been appended
      // ahead of it.
      if (userMessage) sse.send({ type: 'aux', message: messageOut(db, userMessage) });

      // HEADER — server template, no model wait at all.
      if (plan.header) send(addBlock('header', plan.header));

      // Pass N — narration, crowd, camera. Failure costs the block, not the turn.
      let narration = '';
      const tN = Date.now();
      const nDeadline = withDeadline(PASS_N_TIMEOUT_MS, controller.signal);
      try {
        const out = await ctx.queue.run(() => ctx.model.complete({
          model, messages: [{ role: 'user', content: plan.pass_n }],
          temperature: 0.8, top_p: 0.95, max_tokens: PASS_N_MAX_TOKENS, stop: [],
          signal: nDeadline.signal,
        }), controller.signal);
        narration = out.text.trim();
      } catch (err) {
        if (controller.signal.aborted) throw err;
        req.log.warn({ err, conversationId: conv.id }, 'pass N failed; beat continues without narration');
      } finally {
        nDeadline.done();
      }
      passMs.n = Date.now() - tN;
      if (narration) send(addBlock('narration', narration));

      // Pass F — the focus speaks. The only streamed pass, and the only one whose
      // failure is a turn failure.
      let focusText = '';
      const passF = passFWith(planInput, plan, narration);
      if (passF && plan.focus.focus_id) {
        const focusName = cast.find((c) => c.id === plan.focus.focus_id)?.name ?? '';
        focusSeq = emitted.length;
        focusRow = insertMessage(db, conv.id, head, 'assistant', '', 'streaming', {
          generation_id: generationId, profile: profileName, prompt_version: PROMPT_VERSION,
          block_kind: 'line', beat_seq: focusSeq,
          speaker_character_id: plan.focus.focus_id, speaker_name: focusName,
        });
        setHead(db, conv.id, focusRow.id);
        head = focusRow.id;
        // The focus row occupies a beat position like any other block, so it has to
        // count. Leaving it out made every later block's beat_seq one short, and the
        // final updateMessage below then reset the line's own seq to 0.
        emitted.push(focusRow);
        started = true;
        sse.send({ type: 'start', generationId, messageId: focusRow.id, userMessage: userMessage ? messageOut(db, userMessage) : undefined });

        const tF = Date.now();
        let lastPersist = Date.now();
        const result = await ctx.queue.run(() => ctx.model.stream(
          {
            model, messages: [{ role: 'user', content: passF }],
            temperature: 0.9, top_p: 0.95, max_tokens: 500, stop: [], signal: controller.signal,
          },
          (delta) => {
            buffer += delta;
            sse.send({ type: 'token', text: delta });
            if (Date.now() - lastPersist > PERSIST_INTERVAL_MS) {
              lastPersist = Date.now();
              updateMessage(db, focusRow!.id, { content: buffer });
            }
          },
        ), controller.signal);
        passMs.f = Date.now() - tF;
        focusText = result.text.trim();
      }

      // Pass E — each approved extra, serially (queue concurrency is 1 anyway).
      const extraTexts: Record<string, string> = {};
      for (const e of planPassE(planInput, plan, narration, focusText)) {
        const tE = Date.now();
        const eDeadline = withDeadline(PASS_E_TIMEOUT_MS, controller.signal);
        try {
          const out = await ctx.queue.run(() => ctx.model.complete({
            model, messages: [{ role: 'user', content: e.prompt }],
            temperature: 0.85, top_p: 0.95, max_tokens: AUX_MAX_TOKENS, stop: [],
            signal: eDeadline.signal,
          }), controller.signal);
          const text = out.text.trim();
          if (text) extraTexts[e.character_id] = text;
        } catch (err) {
          if (controller.signal.aborted) throw err;
          req.log.warn({ err, conversationId: conv.id, speaker: e.name }, 'pass E failed; that extra is dropped');
        } finally {
          eDeadline.done();
        }
        passMs.e.push(Date.now() - tE);
      }

      // Steps 8-9: serialize, persist the remaining blocks, commit the scene.
      const finished = finishBeat(planInput, plan, { narration, focus_text: focusText, extra_texts: extraTexts });
      const lineOf = (id: string) => finished.blocks.find((b) => b.kind === 'line' && b.speaker_character_id === id);

      if (focusRow) {
        const block = plan.focus.focus_id ? lineOf(plan.focus.focus_id) : undefined;
        updateMessage(db, focusRow.id, {
          content: block?.text ?? focusText,
          status: 'complete',
          meta: {
            block_kind: 'line', beat_seq: focusSeq,
            speaker_character_id: plan.focus.focus_id ?? undefined,
            speaker_name: cast.find((c) => c.id === plan.focus.focus_id)?.name ?? undefined,
            image_url: block?.asset_path ?? undefined,
          },
        });
      }

      const thought = finished.blocks.find((b) => b.kind === 'thought');
      if (thought) {
        send(addBlock('thought', thought.text, {
          speaker_character_id: thought.speaker_character_id ?? undefined,
          speaker_name: thought.speaker_name ?? undefined,
        }));
      }
      for (const extra of plan.approved_extras) {
        const block = lineOf(extra.character_id);
        if (!block) continue;
        send(addBlock('line', block.text, {
          speaker_character_id: extra.character_id, speaker_name: extra.name,
          image_url: block.asset_path ?? undefined,
        }));
      }
      // Pass C — the choices, after every voice in this turn has spoken. Running it
      // here rather than inside Pass F is the whole point of this slice: a draft
      // written before Pass E cannot answer what the extras just said. Fail-open —
      // a beat that reached this line is already a complete, persisted turn, so a
      // choices failure costs the chips, never the turn.
      let choices: string[] | null = null;
      const tC = Date.now();
      const cDeadline = withDeadline(PASS_C_TIMEOUT_MS, controller.signal);
      try {
        const out = await ctx.queue.run(() => ctx.model.complete({
          model,
          messages: [{ role: 'user', content: passCWith(planInput, finished) }],
          temperature: 0.9, top_p: 0.95, max_tokens: PASS_C_MAX_TOKENS, stop: [],
          signal: cDeadline.signal,
        }), controller.signal);
        choices = parseChoicesPass(out.text);
      } catch (err) {
        // Deliberately no `if (aborted) throw` here, unlike Pass N and Pass E. Those
        // run while the turn is still being written, so an abort there really is an
        // interrupted turn. By Pass C every block is persisted and on screen, and
        // the shared catch below would answer a stop by rewriting the focus row
        // back to Pass F's raw buffer — thought marker and all — and marking a
        // finished beat 'interrupted'. Stop costs the chips, not the beat.
        req.log.warn({ err, conversationId: conv.id }, 'pass C failed; beat keeps its blocks without choices');
      } finally {
        cDeadline.done();
      }
      passMs.c = Date.now() - tC;

      // The chips ride on the UI block because it is the turn's last assistant row,
      // which is exactly what the client already reads them off (`isLastAssistant`).
      // No web change: the existing ChoiceChips contract is met as-is.
      const uiRow = addBlock('ui', JSON.stringify(plan.ui), choices ? { choices } : {});

      run(db, `UPDATE conversations SET scene_json = ?, updated_at = ?, last_message_at = ? WHERE id = ?`,
        JSON.stringify(finished.scene), nowIso(), nowIso(), conv.id);
      stampTurnScene(emitted[0]?.id, scene, finished.scene);

      // f9-beat-metrics: one row per beat. `k_opened === 0` is the expected reading
      // of a quiet turn, so it is recorded rather than treated as a miss.
      run(
        db,
        `INSERT INTO generation_log (id, conversation_id, message_id, profile_name, prompt_version, est_prompt_tokens, actual_prompt_tokens, completion_tokens, ttft_ms, total_ms, finish_reason, status, budget_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        uid(), conv.id, focusRow?.id ?? uiRow.id, profileName, PROMPT_VERSION,
        estimateTokens(plan.pass_n, 1) + estimateTokens(passF ?? '', 1), null, null, null,
        Date.now() - tBeat, 'beat', 'complete',
        JSON.stringify({
          beat_log: {
            focus_id: plan.focus.focus_id,
            focus_reason: plan.focus.reason,
            extra_ids: finished.scene.last_beat?.extra_ids ?? [],
            extra_count: (finished.scene.last_beat?.extra_ids ?? []).length,
            eligible_ids: plan.eligible_ids,
            rejected: plan.rejected,
            ambient_ids: plan.ambient.map((a) => a.character_id),
            hard_events: plan.applied.appliedEvents,
            k_opened: plan.approved_extras.length,
            score_ran: false,
            ambient_as_speech: 0,
            asset_nulls: finished.blocks.filter((b) => b.kind === 'line' && !b.asset_path).length,
            unresolved: finished.scene.last_beat?.unresolved ?? [],
            // beat-post-extras-choices: `false` is the fail-open reading — the turn
            // shipped without chips. Counting it here is what makes the fail-open
            // rate measurable instead of invisible.
            choices_ok: choices !== null,
            choices_count: choices?.length ?? 0,
            pass_ms: passMs,
          },
        }),
        nowIso(),
      );

      // Exactly one start/done pair per turn. When the beat has no focus there is
      // nothing to stream, so the UI block closes it — the client needs the pair to
      // clear `generating`, not a particular block kind.
      const closing = focusRow ?? uiRow;
      if (!started) {
        sse.send({ type: 'start', generationId, messageId: closing.id, userMessage: userMessage ? messageOut(db, userMessage) : undefined });
      }
      if (focusRow) send(uiRow);
      sse.send({
        type: 'done',
        message: messageOut(db, one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', closing.id)!),
        usage: null, ttftMs: null, totalMs: Date.now() - tBeat,
      });
    } catch (err) {
      const aborted = controller.signal.aborted;
      const msg = err instanceof ModelError ? err.message : (err as Error)?.name === 'TimeoutError' ? '모델 응답 시간 초과' : (err as Error).message;
      if (focusRow) {
        updateMessage(db, focusRow.id, {
          content: buffer.trim(),
          status: aborted ? 'interrupted' : 'error',
          meta: aborted ? { finish_reason: 'aborted' } : { error: msg },
        });
        if (aborted) {
          sse.send({ type: 'done', message: messageOut(db, one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', focusRow.id)!), usage: null, ttftMs: null, totalMs: Date.now() - tBeat });
        } else {
          ctx.log.error({ err, generationId }, '비트 생성 실패');
          sse.send({ type: 'error', message: msg, messageId: focusRow.id });
        }
      } else {
        ctx.log.error({ err, generationId }, '비트 생성 실패');
        sse.send({ type: 'error', message: msg });
      }
    } finally {
      ctx.queue.unregister(generationId);
      sse.close();
    }
  }

  /**
   * dialog-format — the Dialog.txt-class path. One user input, one script.
   *
   * Structurally the beat path with its generation half swapped: the same scene
   * apply, the same server-only focus, then a single streamed Pass S instead of
   * N + F + E. The reason it is one call is in `dialogScript.ts` — reproducing a
   * turn where two people trade four lines each would otherwise cost eight round
   * trips — and the price of that trade is paid by `parseScript`, which refuses
   * any speaker the server did not put on the allow-list.
   *
   * Failure policy, unchanged in spirit (A-6 / §3):
   *   delta   → scene unchanged, turn continues
   *   Pass S  → status='error', same as Pass F on the beat path
   */
  async function generateDialog(
    req: FastifyRequest,
    reply: FastifyReply,
    conv: ConversationRow,
    parentId: string | null,
    convNow: ConversationRow,
    cast: NonNullable<ReturnType<typeof partyCastForGenerate>>,
    roster: PartyTagRow[],
    generationId: string,
    userMessage: MessageRow | undefined,
    regenTurnStartId: string | null,
  ) {
    const model = ctx.resolvedModel();
    if (!model) return reply.code(503).send({ error: '모델 이름을 해석할 수 없음 (MODEL_NAME 설정 또는 모델 서버 확인)' });

    // scene-branch-snapshot: plan against the branch this generation is on, not
    // against the conversation row. On a regenerate the conversation row already
    // holds the abandoned turn's delta, which is how repeats used to accumulate.
    const sceneBase = resolveSceneBase(db, {
      conversationScene: JSON.parse(convNow.scene_json || '{}') as Scene,
      parentId,
      regenTurnStartId,
    });
    const scene: Scene = sceneBase.scene;
    const storyCatalogRow = one<{ scene_catalog: string }>(
      db, 'SELECT scene_catalog FROM stories WHERE id = ?', convNow.story_id,
    );
    const catalog = catalogFromStory(storyCatalogRow?.scene_catalog ?? '{}');
    const baseVersion = currentSceneVersion(scene);
    const userText = userMessage?.content ?? '';

    // Scene delta — identical contract to the beat path, including the allow-list.
    let patch: Record<string, unknown> | null = null;
    const passMs: { delta: number; s: number } = { delta: 0, s: 0 };
    const t0delta = Date.now();
    try {
      const proposal = await ctx.queue.run(() =>
        ctx.model.complete({
          model,
          messages: [{ role: 'user', content: renderSceneDeltaPrompt({ scene, catalog: { ...catalog, cast }, userText }) }],
          temperature: 0.2,
          top_p: 0.9,
          max_tokens: SCENE_DELTA_MAX_TOKENS,
          stop: [],
        }),
      );
      patch = parseSceneDelta(proposal.text);
    } catch (err) {
      req.log.warn({ err, conversationId: conv.id }, 'scene delta proposal failed; scene unchanged');
    }
    passMs.delta = Date.now() - t0delta;

    const cards: Record<string, PassCard> = {};
    for (const row of many<CharacterRow>(
      db,
      `SELECT * FROM characters WHERE id IN (${roster.map(() => '?').join(',')})`,
      ...roster.map((r) => r.id),
    )) {
      cards[row.id] = {
        name: row.name,
        tagline: row.tagline,
        description: row.description,
        personality: row.personality,
        speech_style: row.speech_style,
        taboos: row.taboos,
      };
    }

    const persona = resolvePersona(db, convNow);
    const planInput: DialogPlanInput = {
      conversation_id: conv.id,
      scene,
      patch: patch ?? undefined,
      catalog,
      current_version: baseVersion,
      user_text: userText,
      user_name: persona?.name || '나',
      cast,
      cards,
      main_character_id: convNow.character_id,
      message_id: userMessage?.id ?? null,
      content_policy: getSetting(db, 'content_policy', ''),
    };
    const plan = planDialogBeat(planInput);

    if (!plan.applied.discarded && plan.applied.applied.length > 0) {
      run(db, `UPDATE conversations SET scene_json = ?, updated_at = ? WHERE id = ?`,
        JSON.stringify(plan.applied.state), nowIso(), conv.id);
    }

    const profileName = convNow.profile_name;
    const sse = openSse(reply);
    const controller = new AbortController();

    let head = parentId;
    const emitted: MessageRow[] = [];
    const addBlock = (
      kind: 'info' | 'narration' | 'line',
      content: string,
      meta: Record<string, unknown> = {},
    ): MessageRow => {
      const row = insertMessage(db, conv.id, head, 'assistant', content, 'complete', {
        generation_id: generationId, profile: profileName, prompt_version: PROMPT_VERSION,
        block_kind: kind, beat_seq: emitted.length, ...meta,
      });
      setHead(db, conv.id, row.id);
      head = row.id;
      emitted.push(row);
      return row;
    };
    const send = (row: MessageRow) =>
      sse.send({ type: 'aux', message: messageOut(db, one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', row.id)!) });

    ctx.queue.register({ id: generationId, conversationId: conv.id, messageId: '', startedAt: nowIso(), controller });

    let scriptRow: MessageRow | null = null;
    let scriptSeq = 0;
    let buffer = '';
    const tBeat = Date.now();

    try {
      if (userMessage) sse.send({ type: 'aux', message: messageOut(db, userMessage) });

      // INFO sheet — server template, so it lands before the model is even called.
      // `finishDialogBeat` will serialize the same sheet as its first block; that
      // copy is dropped below rather than re-sent.
      const sheet = [plan.header, plan.info].filter(Boolean).join('\n');
      const sheetSent = Boolean(sheet);
      if (sheetSent) send(addBlock('info', sheet));

      // Pass S. The raw script streams into one row so the reader sees text
      // arriving; that row then becomes the script's first block, and the rest
      // chain after it. No insert and no reorder, so `beat_seq` stays the append
      // order the client relies on.
      scriptSeq = emitted.length;
      scriptRow = insertMessage(db, conv.id, head, 'assistant', '', 'streaming', {
        generation_id: generationId, profile: profileName, prompt_version: PROMPT_VERSION,
        beat_seq: scriptSeq,
      });
      setHead(db, conv.id, scriptRow.id);
      head = scriptRow.id;
      emitted.push(scriptRow);
      sse.send({ type: 'start', generationId, messageId: scriptRow.id, userMessage: userMessage ? messageOut(db, userMessage) : undefined });

      const tS = Date.now();
      let lastPersist = Date.now();
      const result = await ctx.queue.run(() => ctx.model.stream(
        {
          model, messages: [{ role: 'user', content: plan.pass_s }],
          temperature: 0.9, top_p: 0.95, max_tokens: PASS_S_MAX_TOKENS, stop: [], signal: controller.signal,
        },
        (delta) => {
          buffer += delta;
          sse.send({ type: 'token', text: delta });
          if (Date.now() - lastPersist > PERSIST_INTERVAL_MS) {
            lastPersist = Date.now();
            updateMessage(db, scriptRow!.id, { content: buffer });
          }
        },
      ), controller.signal);
      passMs.s = Date.now() - tS;

      const finished = finishDialogBeat(planInput, plan, result.text);
      const scriptBlocks = sheetSent
        ? finished.blocks.filter((b) => b.kind !== 'info')
        : finished.blocks;

      // A turn whose script parsed to nothing is a failed turn, exactly as an
      // empty Pass F is on the beat path. The sheet alone is not a turn.
      if (!scriptBlocks.length) throw new ModelError('대본을 만들지 못했습니다');

      const [first, ...rest] = scriptBlocks;
      // Choices ride on whichever block is actually last — same rule the 1:1 path
      // uses (they sit on the one assistant message, and `isLastAssistant` on the
      // client is positional, not kind-specific).
      const choices = finished.choices && finished.choices.length ? finished.choices : undefined;
      updateMessage(db, scriptRow.id, {
        content: first.text,
        status: 'complete',
        meta: {
          block_kind: first.kind, beat_seq: scriptSeq,
          speaker_character_id: first.speaker_character_id ?? undefined,
          speaker_name: first.speaker_name ?? undefined,
          image_url: first.asset_path ?? undefined,
          ...(rest.length === 0 ? { choices } : {}),
        },
      });
      rest.forEach((block, i) => {
        send(addBlock(block.kind as 'info' | 'narration' | 'line', block.text, {
          speaker_character_id: block.speaker_character_id ?? undefined,
          speaker_name: block.speaker_name ?? undefined,
          image_url: block.asset_path ?? undefined,
          ...(i === rest.length - 1 ? { choices } : {}),
        }));
      });

      run(db, `UPDATE conversations SET scene_json = ?, updated_at = ?, last_message_at = ? WHERE id = ?`,
        JSON.stringify(finished.scene), nowIso(), nowIso(), conv.id);
      stampTurnScene(emitted[0]?.id, scene, finished.scene);

      run(
        db,
        `INSERT INTO generation_log (id, conversation_id, message_id, profile_name, prompt_version, est_prompt_tokens, actual_prompt_tokens, completion_tokens, ttft_ms, total_ms, finish_reason, status, budget_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        uid(), conv.id, scriptRow.id, profileName, PROMPT_VERSION,
        estimateTokens(plan.pass_s, 1), null, null, null,
        Date.now() - tBeat, 'dialog', 'complete',
        JSON.stringify({
          dialog_log: {
            focus_id: plan.focus.focus_id,
            focus_reason: plan.focus.reason,
            allowed_ids: plan.speakers.map((sp) => sp.id),
            spoke_ids: finished.parsed.spoke_ids,
            // A name the model tried to give a voice to and the server refused.
            // Non-zero here is the signal that the allow-list is doing work.
            rejected_names: finished.parsed.rejected_names,
            dropped_lines: finished.parsed.dropped_lines,
            ambient_ids: plan.ambient.map((a) => a.character_id),
            turn_no: finished.scene.turn_no ?? null,
            blocks: scriptBlocks.length,
            choices_count: choices?.length ?? 0,
            pass_ms: passMs,
          },
        }),
        nowIso(),
      );

      sse.send({
        type: 'done',
        message: messageOut(db, one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', scriptRow.id)!),
        usage: null, ttftMs: null, totalMs: Date.now() - tBeat,
      });
    } catch (err) {
      const aborted = controller.signal.aborted;
      const msg = err instanceof ModelError ? err.message : (err as Error)?.name === 'TimeoutError' ? '모델 응답 시간 초과' : (err as Error).message;
      if (scriptRow) {
        updateMessage(db, scriptRow.id, {
          content: buffer.trim(),
          status: aborted ? 'interrupted' : 'error',
          meta: aborted ? { finish_reason: 'aborted' } : { error: msg },
        });
        if (aborted) {
          sse.send({ type: 'done', message: messageOut(db, one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', scriptRow.id)!), usage: null, ttftMs: null, totalMs: Date.now() - tBeat });
        } else {
          ctx.log.error({ err, generationId }, '대본 생성 실패');
          sse.send({ type: 'error', message: msg, messageId: scriptRow.id });
        }
      } else {
        ctx.log.error({ err, generationId }, '대본 생성 실패');
        sse.send({ type: 'error', message: msg });
      }
    } finally {
      ctx.queue.unregister(generationId);
      sse.close();
    }
  }

  /**
   * hunter-format — the Huntt.txt-class path. One user input, one script, panel last.
   *
   * Same skeleton as `generateDialog`: scene apply, server-only focus, one streamed
   * pass. The two differences that matter at this layer are:
   *   - The panel is not sent up front. `📖상황` describes the turn that just
   *     happened, so the stored copy is serialized last by `finishHunterBeat`.
   *   - Blocks include `system` (bracketed machine voice) and `panel` (INFO sheet).
   *
   * `generateBeat` is not entered. Failure policy matches dialog / A-6:
   *   delta   → scene unchanged, turn continues
   *   Pass H  → status='error', same as an empty Pass F
   */
  async function generateHunter(
    req: FastifyRequest,
    reply: FastifyReply,
    conv: ConversationRow,
    parentId: string | null,
    convNow: ConversationRow,
    cast: NonNullable<ReturnType<typeof partyCastForGenerate>>,
    roster: PartyTagRow[],
    generationId: string,
    userMessage: MessageRow | undefined,
    regenTurnStartId: string | null,
  ) {
    const model = ctx.resolvedModel();
    if (!model) return reply.code(503).send({ error: '모델 이름을 해석할 수 없음 (MODEL_NAME 설정 또는 모델 서버 확인)' });

    // scene-branch-snapshot: plan against the branch this generation is on, not
    // against the conversation row. On a regenerate the conversation row already
    // holds the abandoned turn's delta, which is how repeats used to accumulate.
    const sceneBase = resolveSceneBase(db, {
      conversationScene: JSON.parse(convNow.scene_json || '{}') as Scene,
      parentId,
      regenTurnStartId,
    });
    const scene: Scene = sceneBase.scene;
    const storyCatalogRow = one<{ scene_catalog: string }>(
      db, 'SELECT scene_catalog FROM stories WHERE id = ?', convNow.story_id,
    );
    const catalog = catalogFromStory(storyCatalogRow?.scene_catalog ?? '{}');
    const baseVersion = currentSceneVersion(scene);
    const userText = userMessage?.content ?? '';

    let patch: Record<string, unknown> | null = null;
    const passMs: { delta: number; h: number } = { delta: 0, h: 0 };
    const t0delta = Date.now();
    try {
      const proposal = await ctx.queue.run(() =>
        ctx.model.complete({
          model,
          messages: [{ role: 'user', content: renderSceneDeltaPrompt({ scene, catalog: { ...catalog, cast }, userText }) }],
          temperature: 0.2,
          top_p: 0.9,
          max_tokens: SCENE_DELTA_MAX_TOKENS,
          stop: [],
        }),
      );
      patch = parseSceneDelta(proposal.text);
    } catch (err) {
      req.log.warn({ err, conversationId: conv.id }, 'scene delta proposal failed; scene unchanged');
    }
    passMs.delta = Date.now() - t0delta;

    const cards: Record<string, PassCard> = {};
    for (const row of many<CharacterRow>(
      db,
      `SELECT * FROM characters WHERE id IN (${roster.map(() => '?').join(',')})`,
      ...roster.map((r) => r.id),
    )) {
      cards[row.id] = {
        name: row.name,
        tagline: row.tagline,
        description: row.description,
        personality: row.personality,
        speech_style: row.speech_style,
        taboos: row.taboos,
      };
    }

    const persona = resolvePersona(db, convNow);
    const planInput: HunterPlanInput = {
      conversation_id: conv.id,
      scene,
      patch: patch ?? undefined,
      catalog,
      current_version: baseVersion,
      user_text: userText,
      user_name: persona?.name || '나',
      cast,
      cards,
      main_character_id: convNow.character_id,
      message_id: userMessage?.id ?? null,
      content_policy: getSetting(db, 'content_policy', ''),
    };
    const plan = planHunterBeat(planInput);

    if (!plan.applied.discarded && plan.applied.applied.length > 0) {
      run(db, `UPDATE conversations SET scene_json = ?, updated_at = ? WHERE id = ?`,
        JSON.stringify(plan.applied.state), nowIso(), conv.id);
    }

    const profileName = convNow.profile_name;
    const sse = openSse(reply);
    const controller = new AbortController();

    let head = parentId;
    const emitted: MessageRow[] = [];
    const addBlock = (
      kind: 'panel' | 'narration' | 'line' | 'system',
      content: string,
      meta: Record<string, unknown> = {},
    ): MessageRow => {
      const row = insertMessage(db, conv.id, head, 'assistant', content, 'complete', {
        generation_id: generationId, profile: profileName, prompt_version: PROMPT_VERSION,
        block_kind: kind, beat_seq: emitted.length, ...meta,
      });
      setHead(db, conv.id, row.id);
      head = row.id;
      emitted.push(row);
      return row;
    };
    const send = (row: MessageRow) =>
      sse.send({ type: 'aux', message: messageOut(db, one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', row.id)!) });

    ctx.queue.register({ id: generationId, conversationId: conv.id, messageId: '', startedAt: nowIso(), controller });

    let scriptRow: MessageRow | null = null;
    let scriptSeq = 0;
    let buffer = '';
    const tBeat = Date.now();

    try {
      if (userMessage) sse.send({ type: 'aux', message: messageOut(db, userMessage) });

      // Pass H streams into one row so the reader sees text arriving; that row
      // then becomes the script's first block, and the rest (including the panel)
      // chain after it. No insert and no reorder.
      scriptSeq = emitted.length;
      scriptRow = insertMessage(db, conv.id, head, 'assistant', '', 'streaming', {
        generation_id: generationId, profile: profileName, prompt_version: PROMPT_VERSION,
        beat_seq: scriptSeq,
      });
      setHead(db, conv.id, scriptRow.id);
      head = scriptRow.id;
      emitted.push(scriptRow);
      sse.send({ type: 'start', generationId, messageId: scriptRow.id, userMessage: userMessage ? messageOut(db, userMessage) : undefined });

      const tH = Date.now();
      let lastPersist = Date.now();
      const result = await ctx.queue.run(() => ctx.model.stream(
        {
          model, messages: [{ role: 'user', content: plan.pass_h }],
          temperature: 0.9, top_p: 0.95, max_tokens: PASS_H_MAX_TOKENS, stop: [], signal: controller.signal,
        },
        (delta) => {
          buffer += delta;
          sse.send({ type: 'token', text: delta });
          if (Date.now() - lastPersist > PERSIST_INTERVAL_MS) {
            lastPersist = Date.now();
            updateMessage(db, scriptRow!.id, { content: buffer });
          }
        },
      ), controller.signal);
      passMs.h = Date.now() - tH;

      const finished = finishHunterBeat(planInput, plan, result.text);

      // A turn whose script parsed to nothing is a failed turn. The panel alone
      // is not a turn — it would otherwise commit an empty ⏳️ increment.
      if (!finished.parsed.items.length) throw new ModelError('대본을 만들지 못했습니다');

      const [first, ...rest] = finished.blocks;
      const choices = finished.choices && finished.choices.length ? finished.choices : undefined;
      updateMessage(db, scriptRow.id, {
        content: first.text,
        status: 'complete',
        meta: {
          block_kind: first.kind, beat_seq: scriptSeq,
          speaker_character_id: first.speaker_character_id ?? undefined,
          speaker_name: first.speaker_name ?? undefined,
          image_url: first.asset_path ?? undefined,
          ...(rest.length === 0 ? { choices } : {}),
        },
      });
      rest.forEach((block, i) => {
        send(addBlock(block.kind as 'panel' | 'narration' | 'line' | 'system', block.text, {
          speaker_character_id: block.speaker_character_id ?? undefined,
          speaker_name: block.speaker_name ?? undefined,
          image_url: block.asset_path ?? undefined,
          ...(i === rest.length - 1 ? { choices } : {}),
        }));
      });

      run(db, `UPDATE conversations SET scene_json = ?, updated_at = ?, last_message_at = ? WHERE id = ?`,
        JSON.stringify(finished.scene), nowIso(), nowIso(), conv.id);
      stampTurnScene(emitted[0]?.id, scene, finished.scene);

      run(
        db,
        `INSERT INTO generation_log (id, conversation_id, message_id, profile_name, prompt_version, est_prompt_tokens, actual_prompt_tokens, completion_tokens, ttft_ms, total_ms, finish_reason, status, budget_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        uid(), conv.id, scriptRow.id, profileName, PROMPT_VERSION,
        estimateTokens(plan.pass_h, 1), null, null, null,
        Date.now() - tBeat, 'hunter', 'complete',
        JSON.stringify({
          hunter_log: {
            focus_id: plan.focus.focus_id,
            focus_reason: plan.focus.reason,
            allowed_ids: plan.speakers.map((sp) => sp.id),
            spoke_ids: finished.parsed.spoke_ids,
            rejected_names: finished.parsed.rejected_names,
            dropped_lines: finished.parsed.dropped_lines,
            dropped_panel_rows: finished.parsed.dropped_panel_rows,
            state_rejected: finished.state_rejected,
            ambient_ids: plan.ambient.map((a) => a.character_id),
            turn_no: finished.scene.turn_no ?? null,
            blocks: finished.blocks.length,
            choices_count: choices?.length ?? 0,
            pass_ms: passMs,
          },
        }),
        nowIso(),
      );

      sse.send({
        type: 'done',
        message: messageOut(db, one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', scriptRow.id)!),
        usage: null, ttftMs: null, totalMs: Date.now() - tBeat,
      });
    } catch (err) {
      const aborted = controller.signal.aborted;
      const msg = err instanceof ModelError ? err.message : (err as Error)?.name === 'TimeoutError' ? '모델 응답 시간 초과' : (err as Error).message;
      if (scriptRow) {
        updateMessage(db, scriptRow.id, {
          content: buffer.trim(),
          status: aborted ? 'interrupted' : 'error',
          meta: aborted ? { finish_reason: 'aborted' } : { error: msg },
        });
        if (aborted) {
          sse.send({ type: 'done', message: messageOut(db, one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', scriptRow.id)!), usage: null, ttftMs: null, totalMs: Date.now() - tBeat });
        } else {
          ctx.log.error({ err, generationId }, '헌터 대본 생성 실패');
          sse.send({ type: 'error', message: msg, messageId: scriptRow.id });
        }
      } else {
        ctx.log.error({ err, generationId }, '헌터 대본 생성 실패');
        sse.send({ type: 'error', message: msg });
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
      // assistant 메시지 재생성 = 그 **턴** 전체가 부모 아래 새 형제가 된다.
      // user 메시지(응답 없이 끝난 경우) = 그 아래로 이어서 생성.
      //
      // regenerate-turn-boundary: 1:1은 턴이 한 행이라 예전처럼 그 행의 부모를 쓰지만,
      // beat/dialog/hunter는 턴이 5~6행이라 대상 행의 부모가 자기 턴 한가운데다.
      // 그대로 쓰면 옛 턴 앞부분이 활성 경로에 남은 채 새 턴이 뒤에 붙는다. 어느 블록을
      // 지정하든 턴 시작 블록으로 정규화한다. 클라이언트가 보내는 것은 여전히 메시지 id
      // 하나이고, 경계 해석은 서버가 한다.
      let parentId: string | null;
      let regenTurnStartId: string | null = null;
      if (m.role === 'assistant') {
        const turn = resolveTurnStart(db, m);
        // 경계를 확정할 수 없으면 부분 재생성으로 경로를 오염시키느니 거절한다.
        if (turn.kind === 'unresolved') {
          return reply.code(409).send({ error: `턴 경계를 확정할 수 없음 (${turn.reason})` });
        }
        parentId = turn.parentId;
        regenTurnStartId = turn.kind === 'multi' ? turn.startId : null;
      } else {
        parentId = m.id;
      }
      return generate(req, reply, conv, parentId, undefined, regenTurnStartId);
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
