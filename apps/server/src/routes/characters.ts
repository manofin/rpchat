import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { config } from '../config.js';
import { many, nowIso, one, parseJson, run, uid } from '../db/index.js';
import type { CharacterRow, LoreEntryRow, PersonaRow } from '../types.js';
import { importCard } from '../cardImport.js';
import {
  AVATAR_EXT,
  AVATAR_MAX_BYTES,
  AvatarReject,
  FROST_CHARACTER_ID,
  inspectAvatar,
  publicAvatarPath,
} from '../media/avatar.js';

export function characterOut(c: CharacterRow) {
  return { ...c, tags: parseJson<string[]>(c.tags_json, []), archived: !!c.archived };
}
export function loreOut(e: LoreEntryRow) {
  return {
    ...e,
    keywords: parseJson<string[]>(e.keywords_json, []),
    secondary_keys: parseJson<string[]>(e.secondary_keys_json, []),
    always_on: !!e.always_on,
    enabled: !!e.enabled,
    selective: !!e.selective,
  };
}
export function personaOut(p: PersonaRow) {
  return { ...p, is_default: !!p.is_default };
}

const characterSchema = z.object({
  name: z.string().min(1).max(80),
  tagline: z.string().max(200).default(''),
  avatar: z.string().max(300).nullable().optional(),
  description: z.string().max(8000).default(''),
  personality: z.string().max(4000).default(''),
  speech_style: z.string().max(4000).default(''),
  scenario: z.string().max(4000).default(''),
  first_message: z.string().max(4000).default(''),
  example_dialogue: z.string().max(8000).default(''),
  taboos: z.string().max(2000).default(''),
  tags: z.array(z.string().max(30)).max(20).default([]),
  scene_background: z.string().max(300).nullable().optional(),
  voice_profile: z.string().max(100).nullable().optional(),
});

const LORE_TITLE_MAX = 120;

const loreSchema = z.object({
  title: z.string().min(1).max(LORE_TITLE_MAX),
  keywords: z.array(z.string().min(1).max(40)).max(30).default([]),
  secondary_keys: z.array(z.string().min(1).max(40)).max(30).optional(),
  content: z.string().min(1).max(4000),
  priority: z.number().int().min(-100).max(100).default(0),
  always_on: z.boolean().default(false),
  token_cap: z.number().int().min(20).max(2000).default(300),
  enabled: z.boolean().default(true),
  selective: z.boolean().optional(),
});

const personaSchema = z.object({
  name: z.string().min(1).max(40),
  address_as: z.string().max(80).default(''),
  appearance: z.string().max(2000).default(''),
  personality: z.string().max(2000).default(''),
  relationship: z.string().max(2000).default(''),
  is_default: z.boolean().default(false),
});

export function characterRoutes(ctx: Ctx) {
  const { db } = ctx;
  return async function plugin(app: FastifyInstance) {
    // ---- 캐릭터 ----
    app.get('/api/characters', async () => {
      const rows = many<CharacterRow & { conversation_count: number; last_chat_at: string | null }>(
        db,
        `SELECT c.*, (SELECT COUNT(*) FROM conversations v WHERE v.character_id = c.id AND v.archived = 0) AS conversation_count,
                (SELECT MAX(last_message_at) FROM conversations v WHERE v.character_id = c.id AND v.archived = 0) AS last_chat_at
         FROM characters c WHERE c.archived = 0 ORDER BY last_chat_at DESC NULLS LAST, c.created_at DESC`,
      );
      return rows.map((r) => ({ ...characterOut(r), conversation_count: r.conversation_count, last_chat_at: r.last_chat_at }));
    });

    app.post('/api/characters', async (req, reply) => {
      const p = characterSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: p.error.flatten() });
      const d = p.data;
      const id = uid();
      const t = nowIso();
      run(
        db,
        `INSERT INTO characters (id, name, tagline, avatar, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, tags_json, scene_background, voice_profile, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, d.name, d.tagline, d.avatar ?? null, d.description, d.personality, d.speech_style, d.scenario, d.first_message, d.example_dialogue, d.taboos,
        JSON.stringify(d.tags), d.scene_background ?? null, d.voice_profile ?? null, t, t,
      );
      run(db, 'INSERT INTO lorebooks (id, character_id, name, created_at) VALUES (?, ?, ?, ?)', uid(), id, `${d.name} 로어북`, t);
      return reply.code(201).send(characterOut(one<CharacterRow>(db, 'SELECT * FROM characters WHERE id = ?', id)!));
    });

    app.get<{ Params: { id: string } }>('/api/characters/:id', async (req, reply) => {
      const c = one<CharacterRow>(db, 'SELECT * FROM characters WHERE id = ?', req.params.id);
      if (!c) return reply.code(404).send({ error: 'not found' });
      return characterOut(c);
    });

    // ---- 외부 카드 가져오기 (Character Card V2/V3 PNG, 또는 V1/V2 JSON) ----
    // PNG 를 base64 로 받으므로 이 라우트만 본문 상한을 넉넉히(8MB) 둔다.
    const importSchema = z.object({
      pngBase64: z.string().min(1).optional(),
      json: z.unknown().optional(),
    });
    app.post('/api/characters/import', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
      const p = importSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: 'pngBase64 또는 json 필요' });
      let card;
      try {
        card = importCard({ pngBase64: p.data.pngBase64, json: p.data.json });
      } catch (e) {
        return reply.code(422).send({ error: `카드 해석 실패: ${(e as Error).message}` });
      }
      const id = uid();
      const t = nowIso();
      db.transaction(() => {
        run(
          db,
          `INSERT INTO characters (id, name, tagline, avatar, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, tags_json, created_at, updated_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, card.name, card.tagline, card.description, card.personality, card.speech_style, card.scenario, card.first_message, card.example_dialogue, card.taboos,
          JSON.stringify(card.tags), t, t,
        );
        const lbId = uid();
        run(db, 'INSERT INTO lorebooks (id, character_id, name, created_at) VALUES (?, ?, ?, ?)', lbId, id, `${card.name} 로어북`, t);
        for (const e of card.lore) {
          run(
            db,
            'INSERT INTO lore_entries (id, lorebook_id, title, keywords_json, secondary_keys_json, content, priority, always_on, token_cap, enabled, selective) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            uid(), lbId, e.title, JSON.stringify(e.keywords), JSON.stringify(e.secondary_keys), e.content, e.priority, e.always_on ? 1 : 0, e.token_cap, e.enabled ? 1 : 0, e.selective ? 1 : 0,
          );
        }
      })();
      ctx.log.info({ name: card.name, source: card.source, spec: card.specVersion, lore: card.lore.length }, '카드 가져오기');
      return reply.code(201).send({
        character: characterOut(one<CharacterRow>(db, 'SELECT * FROM characters WHERE id = ?', id)!),
        warnings: card.warnings,
        imported: { source: card.source, specVersion: card.specVersion, loreCount: card.lore.length },
      });
    });

    app.put<{ Params: { id: string } }>('/api/characters/:id', async (req, reply) => {
      const c = one<CharacterRow>(db, 'SELECT * FROM characters WHERE id = ?', req.params.id);
      if (!c) return reply.code(404).send({ error: 'not found' });
      const p = characterSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: p.error.flatten() });
      const d = p.data;
      run(
        db,
        `UPDATE characters SET name=?, tagline=?, avatar=?, description=?, personality=?, speech_style=?, scenario=?, first_message=?, example_dialogue=?, taboos=?, tags_json=?, scene_background=?, voice_profile=?, updated_at=? WHERE id=?`,
        d.name, d.tagline, d.avatar ?? null, d.description, d.personality, d.speech_style, d.scenario, d.first_message, d.example_dialogue, d.taboos,
        JSON.stringify(d.tags), d.scene_background ?? null, d.voice_profile ?? null, nowIso(), c.id,
      );
      return characterOut(one<CharacterRow>(db, 'SELECT * FROM characters WHERE id = ?', c.id)!);
    });

    app.addContentTypeParser(
      ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/octet-stream'],
      { parseAs: 'buffer', bodyLimit: AVATAR_MAX_BYTES },
      (_req, body, done) => {
        done(null, body);
      },
    );

    app.post<{ Params: { id: string }; Body: Buffer }>(
      '/api/characters/:id/avatar',
      { bodyLimit: AVATAR_MAX_BYTES },
      async (req, reply) => {
        const id = req.params.id;
        if (id === FROST_CHARACTER_ID) return reply.code(403).send({ error: 'frost character' });
        const c = one<CharacterRow>(db, 'SELECT * FROM characters WHERE id = ?', id);
        if (!c) return reply.code(404).send({ error: 'not found' });
        const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        let kind;
        try {
          kind = inspectAvatar(buf);
        } catch (e) {
          if (e instanceof AvatarReject) return reply.code(e.status).send({ error: e.message });
          throw e;
        }
        const dir = path.join(config.dataDir, 'media', 'avatars');
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, `${id}.${AVATAR_EXT[kind]}`);
        for (const ext of Object.values(AVATAR_EXT)) {
          const prev = path.join(dir, `${id}.${ext}`);
          if (prev !== dest && fs.existsSync(prev)) fs.unlinkSync(prev);
        }
        fs.writeFileSync(dest, buf);
        const avatar = publicAvatarPath(id, kind);
        run(db, 'UPDATE characters SET avatar = ?, updated_at = ? WHERE id = ?', avatar, nowIso(), id);
        return characterOut(one<CharacterRow>(db, 'SELECT * FROM characters WHERE id = ?', id)!);
      },
    );

    app.delete<{ Params: { id: string } }>('/api/characters/:id', async (req, reply) => {
      const r = run(db, 'UPDATE characters SET archived = 1, updated_at = ? WHERE id = ?', nowIso(), req.params.id);
      if (r.changes === 0) return reply.code(404).send({ error: 'not found' });
      return { ok: true };
    });

    // ---- 로어 (캐릭터당 로어북 1개 자동 생성; lorebook.character_id NULL 은 전역) ----
    function lorebookFor(characterId: string): string {
      const b = one<{ id: string }>(db, 'SELECT id FROM lorebooks WHERE character_id = ? ORDER BY created_at LIMIT 1', characterId);
      if (b) return b.id;
      const id = uid();
      run(db, 'INSERT INTO lorebooks (id, character_id, name, created_at) VALUES (?, ?, ?, ?)', id, characterId, '로어북', nowIso());
      return id;
    }

    app.get<{ Params: { id: string } }>('/api/characters/:id/lore', async (req) => {
      const rows = many<LoreEntryRow>(
        db,
        `SELECT e.* FROM lore_entries e JOIN lorebooks b ON b.id = e.lorebook_id WHERE b.character_id = ? ORDER BY e.priority DESC, e.title`,
        req.params.id,
      );
      return rows.map(loreOut);
    });

    app.post<{ Params: { id: string } }>('/api/characters/:id/lore', async (req, reply) => {
      if (!one(db, 'SELECT 1 FROM characters WHERE id = ?', req.params.id)) return reply.code(404).send({ error: 'character not found' });
      const p = loreSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: p.error.flatten() });
      const d = p.data;
      const id = uid();
      run(
        db,
        'INSERT INTO lore_entries (id, lorebook_id, title, keywords_json, secondary_keys_json, content, priority, always_on, token_cap, enabled, selective) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, lorebookFor(req.params.id), d.title, JSON.stringify(d.keywords), JSON.stringify(d.secondary_keys ?? []), d.content, d.priority, d.always_on ? 1 : 0, d.token_cap, d.enabled ? 1 : 0, d.selective ? 1 : 0,
      );
      return reply.code(201).send(loreOut(one<LoreEntryRow>(db, 'SELECT * FROM lore_entries WHERE id = ?', id)!));
    });

    app.put<{ Params: { id: string } }>('/api/lore/:id', async (req, reply) => {
      if (!one(db, 'SELECT 1 FROM lore_entries WHERE id = ?', req.params.id)) return reply.code(404).send({ error: 'not found' });
      const p = loreSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: p.error.flatten() });
      const d = p.data;
      const prev = one<LoreEntryRow>(db, 'SELECT * FROM lore_entries WHERE id = ?', req.params.id)!;
      const secondary = d.secondary_keys ?? parseJson<string[]>(prev.secondary_keys_json, []);
      const selective = d.selective ?? !!prev.selective;
      run(
        db,
        'UPDATE lore_entries SET title=?, keywords_json=?, secondary_keys_json=?, content=?, priority=?, always_on=?, token_cap=?, enabled=?, selective=? WHERE id=?',
        d.title, JSON.stringify(d.keywords), JSON.stringify(secondary), d.content, d.priority, d.always_on ? 1 : 0, d.token_cap, d.enabled ? 1 : 0, selective ? 1 : 0, req.params.id,
      );
      return loreOut(one<LoreEntryRow>(db, 'SELECT * FROM lore_entries WHERE id = ?', req.params.id)!);
    });

    // G5-7(minimal): 비슷한 항목을 손으로 다시 치지 않게 하는 1클릭 복제. 같은 로어북, 같은 값, 새 id.
    app.post<{ Params: { id: string } }>('/api/lore/:id/clone', async (req, reply) => {
      const src = one<LoreEntryRow>(db, 'SELECT * FROM lore_entries WHERE id = ?', req.params.id);
      if (!src) return reply.code(404).send({ error: 'not found' });
      // loreSchema.title 상한(120)을 넘기면 복제본을 PUT 으로 다시 저장할 수 없게 된다 → 접미사를 남기고 앞을 자른다.
      const suffix = ' (복제)';
      const base = src.title.length + suffix.length > LORE_TITLE_MAX ? src.title.slice(0, LORE_TITLE_MAX - suffix.length) : src.title;
      const id = uid();
      run(
        db,
        'INSERT INTO lore_entries (id, lorebook_id, title, keywords_json, secondary_keys_json, content, priority, always_on, token_cap, enabled, selective) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, src.lorebook_id, `${base}${suffix}`, src.keywords_json, src.secondary_keys_json, src.content, src.priority, src.always_on, src.token_cap, src.enabled, src.selective,
      );
      return reply.code(201).send(loreOut(one<LoreEntryRow>(db, 'SELECT * FROM lore_entries WHERE id = ?', id)!));
    });

    app.delete<{ Params: { id: string } }>('/api/lore/:id', async (req, reply) => {
      const r = run(db, 'DELETE FROM lore_entries WHERE id = ?', req.params.id);
      if (r.changes === 0) return reply.code(404).send({ error: 'not found' });
      return { ok: true };
    });

    // ---- 페르소나 ----
    app.get('/api/personas', async () => many<PersonaRow>(db, 'SELECT * FROM personas ORDER BY is_default DESC, created_at').map(personaOut));

    app.post('/api/personas', async (req, reply) => {
      const p = personaSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: p.error.flatten() });
      const d = p.data;
      const id = uid();
      const t = nowIso();
      db.transaction(() => {
        if (d.is_default) run(db, 'UPDATE personas SET is_default = 0');
        run(
          db,
          'INSERT INTO personas (id, name, address_as, appearance, personality, relationship, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          id, d.name, d.address_as, d.appearance, d.personality, d.relationship, d.is_default ? 1 : 0, t, t,
        );
      })();
      return reply.code(201).send(personaOut(one<PersonaRow>(db, 'SELECT * FROM personas WHERE id = ?', id)!));
    });

    app.put<{ Params: { id: string } }>('/api/personas/:id', async (req, reply) => {
      if (!one(db, 'SELECT 1 FROM personas WHERE id = ?', req.params.id)) return reply.code(404).send({ error: 'not found' });
      const p = personaSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: p.error.flatten() });
      const d = p.data;
      db.transaction(() => {
        if (d.is_default) run(db, 'UPDATE personas SET is_default = 0');
        run(
          db,
          'UPDATE personas SET name=?, address_as=?, appearance=?, personality=?, relationship=?, is_default=?, updated_at=? WHERE id=?',
          d.name, d.address_as, d.appearance, d.personality, d.relationship, d.is_default ? 1 : 0, nowIso(), req.params.id,
        );
      })();
      return personaOut(one<PersonaRow>(db, 'SELECT * FROM personas WHERE id = ?', req.params.id)!);
    });

    app.delete<{ Params: { id: string } }>('/api/personas/:id', async (req, reply) => {
      const inUse = one<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM conversations WHERE persona_id = ?', req.params.id)?.c ?? 0;
      if (inUse > 0) return reply.code(409).send({ error: `대화 ${inUse}건이 이 페르소나를 사용 중` });
      const r = run(db, 'DELETE FROM personas WHERE id = ?', req.params.id);
      if (r.changes === 0) return reply.code(404).send({ error: 'not found' });
      return { ok: true };
    });
  };
}
