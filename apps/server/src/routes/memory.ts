import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { config } from '../config.js';
import { many, nowIso, one, parseJson, run, uid } from '../db/index.js';
import { getPath } from '../db/tree.js';
import { isOocMessage, loadProfile, resolvePersona } from '../prompt/builder.js';
import { renderSummaryPrompt, renderEpisodePrompt, stateToBullets } from '../prompt/templates.js';
import { estimateTokens, getCalibration, truncateToTokens } from '../prompt/tokens.js';
import { classify } from '../memory/conflict.js';
import type { CharacterRow, MemoryRow, SummaryRow } from '../types.js';
import { loadConversation } from './conversations.js';

function memoryOut(m: MemoryRow) {
  return { ...m, evidence_message_ids: parseJson<string[]>(m.evidence_message_ids_json, []) };
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

export function memoryRoutes(ctx: Ctx) {
  const { db } = ctx;
  return async function plugin(app: FastifyInstance) {
    app.get<{ Params: { id: string } }>('/api/conversations/:id/memories', async (req, reply) => {
      const conv = loadConversation(ctx, req.params.id);
      if (!conv) return reply.code(404).send({ error: 'not found' });
      const rows = many<MemoryRow>(
        db,
        `SELECT * FROM memories WHERE status IN ('pinned', 'candidate') AND (conversation_id = ? OR (scope = 'character' AND character_id = ?))
         ORDER BY status DESC, importance DESC, created_at`,
        conv.id, conv.character_id,
      ).map(memoryOut);
      const withVerdict = rows.map((m) => {
        const v = classify(m, rows.filter((o) => o.id !== m.id));
        return { ...memoryOut(m), conflict: v.kind !== 'new' ? v : null };
      });
      return { pinned: withVerdict.filter((m) => m.status === 'pinned'), candidates: withVerdict.filter((m) => m.status === 'candidate') };
    });

    app.post('/api/memories', async (req, reply) => {
      const p = memoryCreate.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: p.error.flatten() });
      const d = p.data;
      let characterId = d.characterId ?? null;
      if (d.conversationId) {
        const conv = loadConversation(ctx, d.conversationId);
        if (!conv) return reply.code(404).send({ error: 'conversation not found' });
        characterId = characterId ?? conv.character_id;
      }
      if (!d.conversationId && !characterId) return reply.code(400).send({ error: 'conversationId 또는 characterId 필요' });
      const id = uid();
      const t = nowIso();
      run(
        db,
        `INSERT INTO memories (id, conversation_id, character_id, content, source, status, importance, scope, evidence_message_ids_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, ?, ?)`,
        id, d.conversationId ?? null, characterId, d.content.trim(), d.status, d.importance, d.scope, JSON.stringify(d.evidenceMessageIds), t, t,
      );
      return reply.code(201).send(memoryOut(one<MemoryRow>(db, 'SELECT * FROM memories WHERE id = ?', id)!));
    });

    app.patch<{ Params: { id: string } }>('/api/memories/:id', async (req, reply) => {
      const m = one<MemoryRow>(db, 'SELECT * FROM memories WHERE id = ?', req.params.id);
      if (!m) return reply.code(404).send({ error: 'not found' });
      const p = memoryPatch.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: p.error.flatten() });
      const d = p.data;
      run(
        db,
        'UPDATE memories SET content = COALESCE(?, content), scope = COALESCE(?, scope), importance = COALESCE(?, importance), status = COALESCE(?, status), updated_at = ? WHERE id = ?',
        d.content?.trim() ?? null, d.scope ?? null, d.importance ?? null, d.status ?? null, nowIso(), m.id,
      );
      return memoryOut(one<MemoryRow>(db, 'SELECT * FROM memories WHERE id = ?', m.id)!);
    });

    app.delete<{ Params: { id: string } }>('/api/memories/:id', async (req, reply) => {
      const r = run(db, 'DELETE FROM memories WHERE id = ?', req.params.id);
      if (r.changes === 0) return reply.code(404).send({ error: 'not found' });
      return { ok: true };
    });

    // ---- 요약 ----
    app.get<{ Params: { id: string } }>('/api/conversations/:id/summaries', async (req, reply) => {
      if (!loadConversation(ctx, req.params.id)) return reply.code(404).send({ error: 'not found' });
      return many<SummaryRow>(db, 'SELECT * FROM summaries WHERE conversation_id = ? ORDER BY created_at DESC', req.params.id);
    });

    app.patch<{ Params: { id: string } }>('/api/summaries/:id', async (req, reply) => {
      const s = one<SummaryRow>(db, 'SELECT * FROM summaries WHERE id = ?', req.params.id);
      if (!s) return reply.code(404).send({ error: 'not found' });
      const p = summaryPatch.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: p.error.flatten() });
      run(db, 'UPDATE summaries SET content = COALESCE(?, content), status = COALESCE(?, status) WHERE id = ?', p.data.content ?? null, p.data.status ?? null, s.id);
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

    /**
     * 모델로 요약 초안 + 후보 기억을 생성한다. 결과는 항상 draft/candidate 로 저장되고 사용자가 승인해야 프롬프트에 들어간다.
     * 마지막 승인 요약 이후의 메시지만 입력으로 쓴다(없으면 전체, 예산 내에서 최근순).
     */
    app.post<{ Params: { id: string } }>('/api/conversations/:id/summarize', async (req, reply) => {
      const conv = loadConversation(ctx, req.params.id);
      if (!conv) return reply.code(404).send({ error: 'not found' });
      if (ctx.queue.activeList.some((g) => g.conversationId === conv.id)) return reply.code(409).send({ error: '생성 중에는 요약할 수 없음' });
      const character = one<CharacterRow>(db, 'SELECT * FROM characters WHERE id = ?', conv.character_id)!;
      const persona = resolvePersona(db, conv);
      const userName = persona?.name || '나';
      const profile = loadProfile(db, 'summary');
      const cal = getCalibration(db);
      const prev = one<SummaryRow>(db, `SELECT * FROM summaries WHERE conversation_id = ? AND tier = 'whole' AND status = 'approved' ORDER BY created_at DESC LIMIT 1`, conv.id);

      const path = getPath(db, conv).filter((m) => m.status !== 'error' && m.content.trim() && !isOocMessage(m));
      let start = 0;
      if (prev?.covers_until_message_id) {
        const idx = path.findIndex((m) => m.id === prev.covers_until_message_id);
        if (idx >= 0) start = idx + 1;
      }
      const slice = path.slice(start);
      if (slice.length === 0) return reply.code(400).send({ error: '요약할 새 메시지가 없음' });

      const budget = Math.max(1024, config.model.contextTokens - profile.max_tokens - 1200);
      const lines: string[] = [];
      let used = 0;
      for (let i = slice.length - 1; i >= 0; i--) {
        const m = slice[i];
        const line = `${m.role === 'user' ? userName : character.name}: ${m.content}`;
        const t = estimateTokens(line, cal);
        if (used + t > budget) break;
        lines.unshift(line);
        used += t;
      }
      const transcript = lines.join('\n');
      const prompt = renderSummaryPrompt(character.name, userName, prev ? truncateToTokens(prev.content, 600, cal) : null, transcript);
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

      const t = nowIso();
      const sumId = uid();
      const stateId = uid();
      const lastId = slice[slice.length - 1].id;
      const firstId = slice[0].id;
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
        run(db, 'INSERT INTO summaries (id, conversation_id, content, covers_until_message_id, covers_from_message_id, status, created_at, tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', sumId, conv.id, String(parsed.summary).trim(), lastId, null, 'draft', t, 'whole');
        if (stateBullets) {
          run(db, 'INSERT INTO summaries (id, conversation_id, content, covers_until_message_id, covers_from_message_id, status, created_at, tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', stateId, conv.id, stateBullets, lastId, null, 'draft', t, 'state');
        }
        if (sceneText) {
          run(db, 'INSERT INTO summaries (id, conversation_id, content, covers_until_message_id, covers_from_message_id, status, created_at, tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              sceneId, conv.id, sceneText, lastId, firstId, 'draft', t, 'scene');
        }
        const mems = Array.isArray(parsed.memories) ? (parsed.memories as Array<Record<string, unknown>>) : [];
        for (const m of mems.slice(0, 8)) {
          const content = String(m?.content ?? '').trim();
          if (!content) continue;
          const imp = Math.min(5, Math.max(1, Number(m?.importance ?? 3) || 3));
          const id = uid();
          run(
            db,
            `INSERT INTO memories (id, conversation_id, character_id, content, source, status, importance, scope, evidence_message_ids_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'model', 'candidate', ?, 'conversation', ?, ?, ?)`,
            id, conv.id, conv.character_id, content, imp, JSON.stringify([lastId]), t, t,
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
          return { ...memoryOut(m), conflict: v.kind !== 'new' ? v : null };
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
      const targets = scenes.slice(0, THRESHOLD);
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

      const epId = uid();
      const t = nowIso();
      const coversFrom = targets[0].covers_from_message_id ?? targets[0].covers_until_message_id;
      const coversUntil = targets[targets.length - 1].covers_until_message_id;
      db.transaction(() => {
        run(db, 'INSERT INTO summaries (id, conversation_id, content, covers_until_message_id, covers_from_message_id, status, created_at, tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', epId, conv.id, episodeText, coversUntil, coversFrom, 'draft', t, 'episode');
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
