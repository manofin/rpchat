import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { many, nowIso, one, parseJson, run, uid } from '../db/index.js';
import type { CharacterRow, StoryCharacterRow, StoryRow } from '../types.js';

export function storyOut(s: StoryRow) {
  return { ...s, minor_cast: parseJson<unknown[]>(s.minor_cast, []), archived: !!s.archived };
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
  };
}
