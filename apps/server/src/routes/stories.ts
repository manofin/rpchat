import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { PROMPT_VERSION, config } from '../config.js';
import { many, nowIso, one, parseJson, run, uid } from '../db/index.js';
import { buildPrompt, computeStoryInjection } from '../prompt/builder.js';
import type { CharacterRow, ConversationRow, StoryCharacterRow, StoryRow } from '../types.js';

export function storyOut(s: StoryRow) {
  return { ...s, minor_cast: parseJson<unknown[]>(s.minor_cast, []), archived: !!s.archived };
}

/** renderStory 출력(### 스토리 설정\n{...}\n\n### 조연\n...)에서 설정 부분만 발췌. 포맷은 templates.ts renderStory 계약. */
function extractSettingExcerpt(text: string): string {
  const marker = '### 스토리 설정\n';
  const idx = text.indexOf(marker);
  if (idx === -1) return '';
  const after = text.slice(idx + marker.length);
  const castIdx = after.indexOf('\n\n### 조연');
  return castIdx === -1 ? after : after.slice(0, castIdx);
}

const storySchema = z.object({
  name: z.string().min(1).max(80),
  tagline: z.string().max(200).default(''),
  setting: z.string().max(8000).default(''),
  minor_cast: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        note: z.string().max(2000).default(''),
      }),
    )
    .max(50)
    .default([]),
});

const mappingSchema = z.object({
  characterId: z.string().min(1),
  role: z.literal('main').default('main'),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});

function hostedCharacters(db: Ctx['db'], storyId: string) {
  return many<StoryCharacterRow & { name: string }>(
    db,
    `SELECT sc.story_id, sc.character_id, sc.role, sc.sort_order, c.name
     FROM story_characters sc
     JOIN characters c ON c.id = sc.character_id
     WHERE sc.story_id = ?
     ORDER BY sc.sort_order ASC, c.name ASC`,
    storyId,
  );
}

export function storyRoutes(ctx: Ctx) {
  const { db } = ctx;
  return async function plugin(app: FastifyInstance) {
    app.get('/api/stories', async () => {
      const rows = many<StoryRow & { character_count: number }>(
        db,
        `SELECT s.*,
                (SELECT COUNT(*) FROM story_characters sc WHERE sc.story_id = s.id) AS character_count
         FROM stories s WHERE s.archived = 0
         ORDER BY s.updated_at DESC, s.created_at DESC`,
      );
      return rows.map((r) => ({ ...storyOut(r), character_count: r.character_count }));
    });

    app.post('/api/stories', async (req, reply) => {
      const p = storySchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: p.error.flatten() });
      const d = p.data;
      const id = uid();
      const t = nowIso();
      run(
        db,
        `INSERT INTO stories (id, name, tagline, setting, minor_cast, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        d.name,
        d.tagline,
        d.setting,
        JSON.stringify(d.minor_cast),
        t,
        t,
      );
      return reply.code(201).send(storyOut(one<StoryRow>(db, 'SELECT * FROM stories WHERE id = ?', id)!));
    });

    app.get<{ Params: { id: string } }>('/api/stories/:id', async (req, reply) => {
      const s = one<StoryRow>(db, 'SELECT * FROM stories WHERE id = ?', req.params.id);
      if (!s) return reply.code(404).send({ error: 'not found' });
      return { ...storyOut(s), characters: hostedCharacters(db, s.id) };
    });

    app.put<{ Params: { id: string } }>('/api/stories/:id', async (req, reply) => {
      const s = one<StoryRow>(db, 'SELECT * FROM stories WHERE id = ?', req.params.id);
      if (!s) return reply.code(404).send({ error: 'not found' });
      const p = storySchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: p.error.flatten() });
      const d = p.data;
      run(
        db,
        `UPDATE stories SET name=?, tagline=?, setting=?, minor_cast=?, updated_at=? WHERE id=?`,
        d.name,
        d.tagline,
        d.setting,
        JSON.stringify(d.minor_cast),
        nowIso(),
        s.id,
      );
      return storyOut(one<StoryRow>(db, 'SELECT * FROM stories WHERE id = ?', s.id)!);
    });

    app.delete<{ Params: { id: string } }>('/api/stories/:id', async (req, reply) => {
      const r = run(db, 'UPDATE stories SET archived = 1, updated_at = ? WHERE id = ?', nowIso(), req.params.id);
      if (r.changes === 0) return reply.code(404).send({ error: 'not found' });
      return { ok: true };
    });

    app.post<{ Params: { id: string } }>('/api/stories/:id/characters', async (req, reply) => {
      const s = one<StoryRow>(db, 'SELECT * FROM stories WHERE id = ?', req.params.id);
      if (!s) return reply.code(404).send({ error: 'not found' });
      const p = mappingSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: p.error.flatten() });
      const d = p.data;
      const c = one<CharacterRow>(db, 'SELECT * FROM characters WHERE id = ?', d.characterId);
      if (!c) return reply.code(404).send({ error: 'not found' });
      const existing = one<StoryCharacterRow>(
        db,
        'SELECT * FROM story_characters WHERE story_id = ? AND character_id = ?',
        s.id,
        d.characterId,
      );
      if (existing) return reply.code(409).send({ error: 'already mapped' });
      run(
        db,
        `INSERT INTO story_characters (story_id, character_id, role, sort_order) VALUES (?, ?, ?, ?)`,
        s.id,
        d.characterId,
        d.role,
        d.sortOrder,
      );
      run(db, 'UPDATE stories SET updated_at = ? WHERE id = ?', nowIso(), s.id);
      return reply.code(201).send(
        one<StoryCharacterRow>(db, 'SELECT * FROM story_characters WHERE story_id = ? AND character_id = ?', s.id, d.characterId),
      );
    });

    app.delete<{ Params: { id: string; characterId: string } }>(
      '/api/stories/:id/characters/:characterId',
      async (req, reply) => {
        const r = run(
          db,
          'DELETE FROM story_characters WHERE story_id = ? AND character_id = ?',
          req.params.id,
          req.params.characterId,
        );
        if (r.changes === 0) return reply.code(404).send({ error: 'not found' });
        return { ok: true };
      },
    );

    // ---- 주입 미리보기 (대화 시작 전 pre-flight, 모델 호출 없음, 스냅샷/대화 생성 없음) ----
    app.get<{ Params: { id: string }; Querystring: { characterId?: string } }>(
      '/api/stories/:id/inject-preview',
      async (req, reply) => {
        const story = one<StoryRow>(db, 'SELECT * FROM stories WHERE id = ?', req.params.id);
        if (!story) return reply.code(404).send({ error: 'not found' });
        if (story.archived) return reply.code(409).send({ error: 'archived' });
        const characterId = req.query.characterId;
        if (!characterId) return reply.code(400).send({ error: 'characterId required' });
        const hosted = one<StoryCharacterRow>(
          db,
          'SELECT * FROM story_characters WHERE story_id = ? AND character_id = ?',
          story.id,
          characterId,
        );
        if (!hosted) return reply.code(404).send({ error: 'character not hosted by story' });
        const character = one<CharacterRow>(db, 'SELECT * FROM characters WHERE id = ? AND archived = 0', characterId);
        if (!character) return reply.code(404).send({ error: 'character not found' });

        // 가상 대화(영구 미저장, DB 쓰기 0): 실제 시작 직전과 동일하게 기본 페르소나 + 빈 장면 + 유저노트 없음.
        // buildPrompt를 그대로 호출해 fixed 블록(카드+페르소나+장면) 예산을 실제 경로로 산출 — 재구현 없음.
        const virtualConv: ConversationRow = {
          id: 'preview',
          character_id: character.id,
          persona_id: null,
          title: '',
          mode: 'story',
          profile_name: 'rp-balanced',
          scene_json: '{}',
          head_message_id: null,
          prompt_version: PROMPT_VERSION,
          favorite: 0,
          archived: 0,
          created_at: '',
          updated_at: '',
          last_message_at: null,
          user_note: null,
          persona_name_snapshot: null,
          persona_address_snapshot: null,
          persona_appearance_snapshot: null,
          persona_personality_snapshot: null,
          persona_relationship_snapshot: null,
          persona_applied_at: null,
          story_id: null,
          story_applied_at: null,
          story_name_snapshot: null,
          story_setting_snapshot: null,
          story_minor_cast_snapshot: null,
        };
        const built = buildPrompt(db, virtualConv, [], config.model.contextTokens, ctx.resolvedModel());
        const fixedSection = built.budget.sections.find((s) => s.name === '시스템 규칙+카드+페르소나+장면')!;

        // 라이브 story를 "지금 시작하면 그대로 스냅샷될 값"으로 취급 — INSERT가 원본을 재직렬화 없이
        // 그대로 복사하므로(ADR-F8b §3) 이 값을 computeStoryInjection에 넘기면 실제 시작 결과와 동일하다.
        const minorCast = parseJson<unknown[]>(story.minor_cast, []);
        const resolvedStory = { name: story.name, setting: story.setting, minorCast };
        const injection = computeStoryInjection(
          resolvedStory,
          fixedSection.budget,
          fixedSection.est_tokens,
          built.budget.calibration,
          character.name,
          built.userName,
        );

        const cast = minorCast
          .map((item) => {
            const rec = (item ?? {}) as { name?: unknown; note?: unknown };
            const name = String(rec.name ?? '').trim();
            const note = String(rec.note ?? '').trim();
            if (!name && !note) return null;
            const included = !!injection && injection.text.includes(`- ${name}: ${note}`);
            return { name, included };
          })
          .filter((x): x is { name: string; included: boolean } => x !== null);

        return {
          settingExcerpt: injection ? extractSettingExcerpt(injection.text) : '',
          settingTruncated: !!injection?.note?.includes('절단'),
          cast,
          estTokens: injection?.estTokens ?? 0,
          storyRoom: injection?.storyRoom ?? Math.max(0, fixedSection.budget - fixedSection.est_tokens),
          willFreeze: true,
        };
      },
    );
  };
}
