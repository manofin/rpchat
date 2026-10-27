import { partyOutputMutationBlocked } from '../prompt/partyOutput.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { config } from '../config.js';
import { many, nowIso, one, parseJson, run, uid } from '../db/index.js';
import { isSideModeMessage } from '../db/sideMode.js';
import { getPath } from '../db/tree.js';
import { isOocMessage, loadProfile, resolvePersona } from '../prompt/builder.js';
import { renderSummaryPrompt, renderEpisodePrompt, stateToBullets } from '../prompt/templates.js';
import { estimateTokens, getCalibration, truncateToTokens } from '../prompt/tokens.js';
import { classify } from '../memory/conflict.js';
import { evidenceIdsForSlice, isSummarizeBlocked, sceneCoverRange } from './summarizeContract.js';
import type { CharacterRow, MemoryRow, SummaryRow, MessageRow } from '../types.js';
import { loadConversation } from './conversations.js';
import { dialogKnowledgeRoutes } from './dialogKnowledge.js';
import { encodeProvenance, provenanceAfterEdit, provenanceReader, type ProvenanceSource } from '../memory/provenance.js';
import { audienceAllowsOutput, type Audience } from '../prompt/observation.js';
import { parseMessageMeta } from '../db/messageMeta.js';

const EDITOR_AUDIENCE: Audience = { visibility: 'private', recipient_ids: ['user'], observer_ids: [] };
function generationAccess(db: Ctx['db'], row: MemoryRow | SummaryRow, kind: 'memory' | 'summary', reader = provenanceReader(db)) {
  const audience = reader.audience(row, kind);
  return audience ? { status: 'verified' as const, visibility: audience.visibility, can_summarize: audienceAllowsOutput(audience, EDITOR_AUDIENCE) }
    : { status: 'withheld' as const, reason: '출처를 확인할 수 없어 새 답변에 사용하지 않아요. 원문에서 다시 요약해 주세요.' };
}

function memoryOut(m: MemoryRow, db: Ctx['db'], reader = provenanceReader(db)) {
  return { ...m, evidence_message_ids: parseJson<string[]>(m.evidence_message_ids_json, []), generation_access: generationAccess(db, m, 'memory', reader) };
}

const memoryCreate = z.object({
  conversationId: z.string().nullable().optional(),
  characterId: z.string().nullable().optional(),
  content: z.string().min(1).max(1000),
  scope: z.enum(['conversation', 'character']).default('conversation'),
  importance: z.number().int().min(1).max(5).default(3),
  status: z.enum(['candidate', 'pinned']).default('pinned'),
  evidenceMessageIds: z.array(z.string()).max(20).default([]),
});
const memoryPatch = z.object({
  content: z.string().min(1).max(1000).optional(),
  scope: z.enum(['conversation', 'character']).optional(),
  importance: z.number().int().min(1).max(5).optional(),
  status: z.enum(['candidate', 'pinned', 'rejected', 'superseded']).optional(),
});
const summaryPatch = z.object({ content: z.string().min(1).max(6000).optional(), status: z.enum(['draft', 'approved']).optional() });


/** Shared warn body for PATCH-pin and POST when Jaccard duplicate needs confirm. HTTP 200, never 409. */
export type MemoryDupWarn = {
  pinned: false;
  warn: 'duplicate';
  conflict: { kind: 'duplicate'; withMemoryId: string | null; reason: string };
};

function wantsConfirm(req: { query?: unknown }): boolean {
  const q = (req.query ?? {}) as Record<string, unknown>;
  const v = q.confirm;
  return v === '1' || v === 1 || v === true || v === 'true';
}

/** Same peer set as GET /memories: pinned+candidate in conversation OR character-scoped. */
function memoryPeers(
  db: Ctx['db'],
  conversationId: string | null,
  characterId: string | null,
  excludeId?: string | null,
): MemoryRow[] {
  if (!conversationId && !characterId) return [];
  let rows: MemoryRow[];
  if (conversationId) {
    const charId =
      characterId ??
      one<{ character_id: string }>(db, 'SELECT character_id FROM conversations WHERE id = ?', conversationId)?.character_id ??
      null;
    if (!charId) {
      rows = many<MemoryRow>(db, `SELECT * FROM memories WHERE status IN ('pinned', 'candidate') AND conversation_id = ?`, conversationId);
    } else {
      rows = many<MemoryRow>(
        db,
        `SELECT * FROM memories WHERE status IN ('pinned', 'candidate') AND (conversation_id = ? OR (scope = 'character' AND character_id = ?))`,
        conversationId,
        charId,
      );
    }
  } else {
    rows = many<MemoryRow>(
      db,
      `SELECT * FROM memories WHERE status IN ('pinned', 'candidate') AND scope = 'character' AND character_id = ?`,
      characterId,
    );
  }
  return excludeId ? rows.filter((r) => r.id !== excludeId) : rows;
}

function duplicateWarn(v: { kind: string; withMemoryId: string | null; reason: string }): MemoryDupWarn {
  return {
    pinned: false,
    warn: 'duplicate',
    conflict: { kind: 'duplicate', withMemoryId: v.withMemoryId, reason: v.reason },
  };
}

export function memoryRoutes(ctx: Ctx) {
  const { db } = ctx;
  return async function plugin(app: FastifyInstance) {
    await app.register(dialogKnowledgeRoutes(ctx));
    app.addHook('preHandler', async (req, reply) => {
      if (!['POST','PATCH','DELETE'].includes(req.method)) return;
      const params=(req.params??{}) as {id?:string};
      const body=(req.body??{}) as {conversationId?:string;characterId?:string};
      const url=req.url.split('?')[0];
      let conversationId=body.conversationId, characterId=body.characterId;
      if(url.startsWith('/api/memories/') && params.id) {
        const row=one<MemoryRow>(db,'SELECT * FROM memories WHERE id=?',params.id);
        conversationId=row?.conversation_id??undefined;characterId=row?.character_id??undefined;
      } else if(url.startsWith('/api/summaries/') && params.id) {
        conversationId=one<SummaryRow>(db,'SELECT * FROM summaries WHERE id=?',params.id)?.conversation_id;
      } else if(url.startsWith('/api/conversations/')) conversationId=params.id;
      if(partyOutputMutationBlocked(ctx,conversationId,characterId)) return reply.code(409).send({error:'생성 중에는 기억과 요약을 수정할 수 없습니다.'});
    });
    app.get<{ Params: { id: string } }>('/api/conversations/:id/memories', async (req, reply) => {
      const conv = loadConversation(ctx, req.params.id);
      if (!conv) return reply.code(404).send({ error: 'not found' });
      const rows = many<MemoryRow>(
        db,
        `SELECT * FROM memories WHERE status IN ('pinned', 'candidate') AND (conversation_id = ? OR (scope = 'character' AND character_id = ?))
         ORDER BY status DESC, importance DESC, created_at`,
        conv.id, conv.character_id,
      );
      const reader = provenanceReader(db);
      const withVerdict = rows.map((m) => {
        const v = classify(m, rows.filter((o) => o.id !== m.id));
        return { ...memoryOut(m, db, reader), conflict: v.kind !== 'new' ? v : null };
      });
      return { pinned: withVerdict.filter((m) => m.status === 'pinned'), candidates: withVerdict.filter((m) => m.status === 'candidate') };
    });

    app.post('/api/memories', async (req, reply) => {
      const p = memoryCreate.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: p.error.flatten() });
      const d = p.data;
      if (d.evidenceMessageIds.some(id => { const row = one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', id); return row && isSideModeMessage(row); })) {
        return reply.code(400).send({ error: '부가 모드 결과는 본편 기억의 근거로 사용할 수 없음' });
      }
      let characterId = d.characterId ?? null;
      if (d.conversationId) {
        const conv = loadConversation(ctx, d.conversationId);
        if (!conv) return reply.code(404).send({ error: 'conversation not found' });
        characterId = characterId ?? conv.character_id;
      }
      if (!d.conversationId && !characterId) return reply.code(400).send({ error: 'conversationId 또는 characterId 필요' });
      const content = d.content.trim();
      const reader = provenanceReader(db);
      const sources: ProvenanceSource[] = [];
      for (const id of d.evidenceMessageIds) {
        const row = one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', id);
        const source = row && reader.messageSource(row, row.content, { includeOffBranch: true });
        if (!source || !audienceAllowsOutput(source.audience, EDITOR_AUDIENCE)) return reply.code(400).send({ error: '이 기억의 근거를 확인할 수 없습니다.' });
        sources.push(source);
      }
      // Pin path: warn on Jaccard duplicate unless ?confirm=1 (HTTP 200 warn schema — never 409).
      if (d.status === 'pinned' && !wantsConfirm(req)) {
        const peers = memoryPeers(db, d.conversationId ?? null, characterId, null);
        const v = classify({ id: '', content }, peers);
        if (v.kind === 'duplicate') {
          return reply.code(200).send(duplicateWarn(v));
        }
      }
      const id = uid();
      const t = nowIso();
      run(
        db,
        `INSERT INTO memories (id, conversation_id, character_id, content, source, status, importance, scope, evidence_message_ids_json, created_at, updated_at, input_provenance_json)
         VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, ?, ?, ?)`,
        id, d.conversationId ?? null, characterId, content, d.status, d.importance, d.scope, JSON.stringify(d.evidenceMessageIds), t, t, encodeProvenance(content, sources, 'user-declared'),
      );
      return reply.code(201).send(memoryOut(one<MemoryRow>(db, 'SELECT * FROM memories WHERE id = ?', id)!, db));
    });

    app.patch<{ Params: { id: string } }>('/api/memories/:id', async (req, reply) => {
      const m = one<MemoryRow>(db, 'SELECT * FROM memories WHERE id = ?', req.params.id);
      if (!m) return reply.code(404).send({ error: 'not found' });
      const p = memoryPatch.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: p.error.flatten() });
      const d = p.data;
      const pinning = d.status === 'pinned' && m.status !== 'pinned';
      if (pinning && !wantsConfirm(req)) {
        const content = (d.content?.trim() ?? m.content);
        const peers = memoryPeers(db, m.conversation_id, m.character_id, m.id);
        const v = classify({ id: m.id, content }, peers);
        if (v.kind === 'duplicate') {
          // DB unchanged — still candidate (or prior non-pinned status).
          return reply.code(200).send(duplicateWarn(v));
        }
      }
      run(
        db,
        'UPDATE memories SET content = COALESCE(?, content), scope = COALESCE(?, scope), importance = COALESCE(?, importance), status = COALESCE(?, status), updated_at = ?, input_provenance_json = ? WHERE id = ?',
        d.content?.trim() ?? null, d.scope ?? null, d.importance ?? null, d.status ?? null, nowIso(), provenanceAfterEdit(m, d.content?.trim() ?? m.content), m.id,
      );
      const out = memoryOut(one<MemoryRow>(db, 'SELECT * FROM memories WHERE id = ?', m.id)!, db);
      return out;
    });

    app.delete<{ Params: { id: string } }>('/api/memories/:id', async (req, reply) => {
      const r = run(db, 'DELETE FROM memories WHERE id = ?', req.params.id);
      if (r.changes === 0) return reply.code(404).send({ error: 'not found' });
      return { ok: true };
    });

    // ---- 요약 ----
    app.get<{ Params: { id: string } }>('/api/conversations/:id/summaries', async (req, reply) => {
      if (!loadConversation(ctx, req.params.id)) return reply.code(404).send({ error: 'not found' });
      const reader = provenanceReader(db);
      return many<SummaryRow>(db, 'SELECT * FROM summaries WHERE conversation_id = ? ORDER BY created_at DESC', req.params.id)
        .map(row => ({ ...row, generation_access: generationAccess(db, row, 'summary', reader) }));
    });

    app.patch<{ Params: { id: string } }>('/api/summaries/:id', async (req, reply) => {
      const s = one<SummaryRow>(db, 'SELECT * FROM summaries WHERE id = ?', req.params.id);
      if (!s) return reply.code(404).send({ error: 'not found' });
      const p = summaryPatch.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: p.error.flatten() });
      const bundleTiers = new Set(['whole', 'state', 'scene']);
      const shouldBundle = p.data.status === 'approved' && bundleTiers.has(s.tier);
      db.transaction(() => {
        if (shouldBundle) {
          run(
            db,
            `UPDATE summaries SET status = 'approved'
             WHERE conversation_id = ? AND created_at = ? AND status = 'draft' AND tier IN ('whole', 'state', 'scene')`,
            s.conversation_id, s.created_at,
          );
        }
        run(db, 'UPDATE summaries SET content = COALESCE(?, content), status = COALESCE(?, status), input_provenance_json = ? WHERE id = ?', p.data.content ?? null, p.data.status ?? null, provenanceAfterEdit(s, p.data.content ?? s.content), s.id);
      })();
      return one<SummaryRow>(db, 'SELECT * FROM summaries WHERE id = ?', s.id);
    });

    app.delete<{ Params: { id: string } }>('/api/summaries/:id', async (req, reply) => {
      const s = one<SummaryRow>(db, 'SELECT * FROM summaries WHERE id = ?', req.params.id);
      if (!s) return reply.code(404).send({ error: 'not found' });
      db.transaction(() => {
        if (s.tier === 'episode') run(db, 'UPDATE summaries SET rolled_up_into = NULL WHERE rolled_up_into = ?', s.id); // 접힌 장면 해제
        run(db, 'DELETE FROM summaries WHERE id = ?', s.id);
      })();
      return { ok: true };
    });

    /** 과거 체크포인트 복원: 기존 행은 그대로 두고(이력 보존), 그 내용으로 새 approved 행을 만든다(git revert와 동일 원리). */
    app.post<{ Params: { id: string } }>('/api/summaries/:id/restore', async (req, reply) => {
      const s = one<SummaryRow>(db, 'SELECT * FROM summaries WHERE id = ?', req.params.id);
      if (!s) return reply.code(404).send({ error: 'not found' });
      const id = uid();
      const t = nowIso();
      run(
        db,
        'INSERT INTO summaries (id, conversation_id, content, covers_until_message_id, covers_from_message_id, status, created_at, tier, input_provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, s.conversation_id, s.content, s.covers_until_message_id, s.covers_from_message_id, 'approved', t, s.tier, s.input_provenance_json ?? null,
      );
      return one<SummaryRow>(db, 'SELECT * FROM summaries WHERE id = ?', id);
    });

    /**
     * 모델로 요약 초안 + 후보 기억을 생성한다. 결과는 항상 draft/candidate 로 저장되고 사용자가 승인해야 프롬프트에 들어간다.
     * 마지막 승인 요약 이후의 메시지만 입력으로 쓴다(없으면 전체, 예산 내에서 최근순).
     */
    app.post<{ Params: { id: string } }>('/api/conversations/:id/summarize', async (req, reply) => {
      const conv = loadConversation(ctx, req.params.id);
      if (!conv) return reply.code(404).send({ error: 'not found' });
      if (isSummarizeBlocked(ctx.queue.activeList, conv.id)) return reply.code(409).send({ error: '생성 중에는 요약할 수 없음' });
      const character = one<CharacterRow>(db, 'SELECT * FROM characters WHERE id = ?', conv.character_id)!;
      const persona = resolvePersona(db, conv);
      const userName = persona?.name || '나';
      const profile = loadProfile(db, 'summary');
      const cal = getCalibration(db);
      const reader = provenanceReader(db);
      const path = getPath(db, conv).filter((m) => m.status === 'complete' && m.content.trim() && !isOocMessage(m));
      const pathIds = new Set(path.map(m => m.id));
      const prev = many<SummaryRow>(db, `SELECT * FROM summaries WHERE conversation_id = ? AND tier = 'whole' AND status = 'approved' ORDER BY created_at DESC`, conv.id)
        .find(s => (!s.covers_from_message_id || pathIds.has(s.covers_from_message_id)) && (!s.covers_until_message_id || pathIds.has(s.covers_until_message_id)) && reader.canUse(s, 'summary', EDITOR_AUDIENCE));
      let start = 0;
      if (prev?.covers_until_message_id) {
        const idx = path.findIndex((m) => m.id === prev.covers_until_message_id);
        if (idx >= 0) start = idx + 1;
      }
      const slice = path.slice(start);
      if (slice.length === 0) return reply.code(400).send({ error: '요약할 새 메시지가 없음' });

      const budget = Math.max(1024, config.model.contextTokens - profile.max_tokens - 1200);
      const lines: string[] = [];
      const selected: MessageRow[] = [];
      const sources: ProvenanceSource[] = [];
      let used = 0;
      for (let i = slice.length - 1; i >= 0; i--) {
        const m = slice[i];
        const meta = parseMessageMeta(m.meta_json);
        const speaker = meta.speaker_character_id ? one<CharacterRow>(db, 'SELECT * FROM characters WHERE id = ?', meta.speaker_character_id)?.name : undefined;
        const line = `${m.role === 'user' ? userName : speaker ?? meta.speaker_name ?? character.name}: ${m.content}`;
        const source = reader.messageSource(m, line);
        if (!source || !audienceAllowsOutput(source.audience, EDITOR_AUDIENCE)) continue;
        const t = estimateTokens(line, cal);
        if (used + t > budget) break;
        lines.unshift(line);
        selected.unshift(m); sources.unshift(source);
        used += t;
      }
      if (!selected.length) return reply.code(422).send({ error: '허용된 요약 원문이 없거나 입력 한도를 초과했습니다.' });
      const transcript = lines.join('\n');
      const previousText = prev ? truncateToTokens(prev.content, 600, cal) : null;
      if (prev && previousText) sources.unshift(reader.summarySource(prev, previousText)!);
      const prompt = renderSummaryPrompt(character.name, userName, previousText, transcript);
      const messages = profile.system_mode === 'merge'
        ? [{ role: 'user' as const, content: prompt }]
        : [{ role: 'system' as const, content: '당신은 역할극 기록을 정확하게 요약하는 편집자다. 요청된 JSON 만 출력한다.' }, { role: 'user' as const, content: prompt }];

      const controller = new AbortController();
      const genId = uid();
      ctx.queue.register({ id: genId, conversationId: conv.id, messageId: '', startedAt: nowIso(), controller });
      let text = '';
      try {
        const r = await ctx.queue.run(
          () => ctx.model.complete({ model: profile.model || ctx.resolvedModel(), messages, temperature: profile.temperature, top_p: profile.top_p, max_tokens: profile.max_tokens, signal: controller.signal }),
          controller.signal,
        );
        text = r.text;
      } catch (err) {
        return reply.code(502).send({ error: `요약 생성 실패: ${(err as Error).message}` });
      } finally {
        ctx.queue.unregister(genId);
      }

      const parsed = lenientJson(text) as { summary?: unknown; memories?: unknown; state?: unknown; scene?: unknown } | null;
      if (!parsed || typeof parsed.summary !== 'string') return reply.code(502).send({ error: '모델 출력을 JSON 으로 해석하지 못함', raw: text.slice(0, 2000) });
      if (loadConversation(ctx, conv.id)?.head_message_id !== conv.head_message_id || !provenanceReader(db).unchanged(sources)) {
        return reply.code(409).send({ error: '요약 도중 원문이나 분기가 바뀌었습니다. 다시 요약해 주세요.' });
      }

      const t = nowIso();
      const sumId = uid();
      const stateId = uid();
      const lastId = selected[selected.length - 1].id;
      const evidence = evidenceIdsForSlice(selected);
      const sceneText = typeof parsed.scene === 'string' ? parsed.scene.trim() : '';
      const sceneId = uid();
      const created: string[] = [];
      let stateDraft: SummaryRow | null = null;
      const rawState = parsed.state;
      const stateObj = rawState && typeof rawState === 'object' && !Array.isArray(rawState)
        ? Object.fromEntries(Object.entries(rawState as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')]))
        : null;
      const stateBullets = stateToBullets(stateObj);
      db.transaction(() => {
        run(db, 'INSERT INTO summaries (id, conversation_id, content, covers_until_message_id, covers_from_message_id, status, created_at, tier, input_provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', sumId, conv.id, String(parsed.summary).trim(), lastId, null, 'draft', t, 'whole', encodeProvenance(String(parsed.summary).trim(), sources));
        if (stateBullets) {
          run(db, 'INSERT INTO summaries (id, conversation_id, content, covers_until_message_id, covers_from_message_id, status, created_at, tier, input_provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', stateId, conv.id, stateBullets, lastId, null, 'draft', t, 'state', encodeProvenance(stateBullets, sources));
        }
        if (sceneText) {
          const cover = sceneCoverRange(selected);
          run(db, 'INSERT INTO summaries (id, conversation_id, content, covers_until_message_id, covers_from_message_id, status, created_at, tier, input_provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
              sceneId, conv.id, sceneText, cover.coversUntil, cover.coversFrom, 'draft', t, 'scene', encodeProvenance(sceneText, sources));
        }
        const mems = Array.isArray(parsed.memories) ? (parsed.memories as Array<Record<string, unknown>>) : [];
        for (const m of mems.slice(0, 8)) {
          const content = String(m?.content ?? '').trim();
          if (!content) continue;
          const imp = Math.min(5, Math.max(1, Number(m?.importance ?? 3) || 3));
          const id = uid();
          run(
            db,
            `INSERT INTO memories (id, conversation_id, character_id, content, source, status, importance, scope, evidence_message_ids_json, created_at, updated_at, input_provenance_json)
             VALUES (?, ?, ?, ?, 'model', 'candidate', ?, 'conversation', ?, ?, ?, ?)`,
            id, conv.id, conv.character_id, content, imp, JSON.stringify(evidence), t, t, encodeProvenance(content, sources),
          );
          created.push(id);
        }
      })();
      if (stateBullets) stateDraft = one<SummaryRow>(db, 'SELECT * FROM summaries WHERE id = ?', stateId) ?? null;
      return {
        summary: one<SummaryRow>(db, 'SELECT * FROM summaries WHERE id = ?', sumId),
        state: stateDraft,
        scene: sceneText ? one<SummaryRow>(db, 'SELECT * FROM summaries WHERE id = ?', sceneId) : null,
        candidates: created.map((id) => {
          const m = one<MemoryRow>(db, 'SELECT * FROM memories WHERE id = ?', id)!;
          const v = classify(m, many<MemoryRow>(db, `SELECT * FROM memories WHERE status IN ('pinned','candidate') AND id != ?`, id));
          return { ...memoryOut(m, db), conflict: v.kind !== 'new' ? v : null };
        }),
        inputMessages: lines.length,
      };
    });

    app.post<{ Params: { id: string }; Querystring: { force?: string } }>('/api/conversations/:id/rollup-episode', async (req, reply) => {
      const conv = loadConversation(ctx, req.params.id);
      if (!conv) return reply.code(404).send({ error: 'not found' });
      if (ctx.queue.activeList.some((g) => g.conversationId === conv.id)) return reply.code(409).send({ error: '생성 중에는 묶을 수 없음' });
      const THRESHOLD = 5;
      const force = req.query.force === '1';
      const scenes = many<SummaryRow>(db, `SELECT * FROM summaries WHERE conversation_id = ? AND tier = 'scene' AND status = 'approved' AND rolled_up_into IS NULL ORDER BY created_at ASC`, conv.id);
      const reader = provenanceReader(db);
      const targets = scenes.filter(s => reader.canUse(s, 'summary', EDITOR_AUDIENCE)).slice(0, THRESHOLD);
      const sources = targets.map(s => reader.summarySource(s, s.content)!);
      if (targets.length === 0) return reply.code(400).send({ error: '묶을 장면 없음' });
      if (targets.length < THRESHOLD && !force) return reply.code(400).send({ error: `묶을 장면이 부족 (${targets.length}/${THRESHOLD})` });

      const profile = loadProfile(db, 'summary');
      const prompt = renderEpisodePrompt(targets.map((s) => s.content));
      const messages = profile.system_mode === 'merge'
        ? [{ role: 'user' as const, content: prompt }]
        : [{ role: 'system' as const, content: '당신은 역할극 기록을 정확하게 요약하는 편집자다. 요청된 JSON 만 출력한다.' }, { role: 'user' as const, content: prompt }];
      const controller = new AbortController();
      const genId = uid();
      ctx.queue.register({ id: genId, conversationId: conv.id, messageId: '', startedAt: nowIso(), controller });
      let text = '';
      try {
        const r = await ctx.queue.run(() => ctx.model.complete({ model: profile.model || ctx.resolvedModel(), messages, temperature: profile.temperature, top_p: profile.top_p, max_tokens: profile.max_tokens, signal: controller.signal }), controller.signal);
        text = r.text;
      } catch (err) {
        return reply.code(502).send({ error: `에피소드 생성 실패: ${(err as Error).message}` });
      } finally {
        ctx.queue.unregister(genId);
      }
      const parsed = lenientJson(text) as { episode?: unknown } | null;
      const episodeText = parsed && typeof parsed.episode === 'string' ? parsed.episode.trim() : '';
      if (!episodeText) return reply.code(502).send({ error: '모델 출력을 JSON 으로 해석하지 못함', raw: text.slice(0, 2000) });
      if (loadConversation(ctx, conv.id)?.head_message_id !== conv.head_message_id || !provenanceReader(db).unchanged(sources)) {
        return reply.code(409).send({ error: '요약 도중 원문이나 분기가 바뀌었습니다. 다시 요약해 주세요.' });
      }

      const epId = uid();
      const t = nowIso();
      const coversFrom = targets[0].covers_from_message_id ?? targets[0].covers_until_message_id;
      const coversUntil = targets[targets.length - 1].covers_until_message_id;
      db.transaction(() => {
        run(db, 'INSERT INTO summaries (id, conversation_id, content, covers_until_message_id, covers_from_message_id, status, created_at, tier, rel_character_id, rel_persona_id, input_provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', epId, conv.id, episodeText, coversUntil, coversFrom, 'draft', t, 'episode', conv.character_id, conv.persona_id, encodeProvenance(episodeText, sources));
        run(db, `UPDATE summaries SET rolled_up_into = ? WHERE id IN (${targets.map(() => '?').join(',')})`, epId, ...targets.map((s) => s.id));
      })();
      return { episode: one<SummaryRow>(db, 'SELECT * FROM summaries WHERE id = ?', epId), rolledScenes: targets.map((s) => s.id) };
    });
  };
}

function lenientJson(text: string): unknown {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try {
    return JSON.parse(text.slice(s, e + 1));
  } catch {
    return null;
  }
}
