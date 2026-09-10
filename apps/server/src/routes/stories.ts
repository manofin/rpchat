import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { PROMPT_VERSION, config } from '../config.js';
import { many, nowIso, one, parseJson, run, uid } from '../db/index.js';
import { buildPrompt, computeStoryInjection } from '../prompt/builder.js';
import { parseSceneCatalog } from '../prompt/sceneCatalog.js';
import { parseOpening, storedOpening, validateOpeningPut } from '../prompt/storyOpening.js';
import {
  AVATAR_EXT,
  AVATAR_MAX_BYTES,
  AvatarReject,
  inspectAvatar,
  publicCoverPath,
} from '../media/avatar.js';
import { loreOut, loreSchema } from './characters.js';
import type { CharacterRow, ConversationRow, LoreEntryRow, StoryCharacterRow, StoryRow } from '../types.js';

export type StoryOpeningExtra = { id: string; label: string; opening_json: string };

export type StoryEnding = { id: string; title: string; description: string; badge_label: string };

/** Damaged / non-array → [] (GET/POST fallback). Authorship 400 lives in the PUT handler. */
export function parseOpeningsExtra(raw: string | null | undefined): StoryOpeningExtra[] {
  if (raw == null || raw === '') return [];
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    console.warn('[parseOpeningsExtra] damaged openings_extra_json');
    return [];
  }
  if (!Array.isArray(doc)) {
    console.warn('[parseOpeningsExtra] damaged openings_extra_json');
    return [];
  }
  const out: StoryOpeningExtra[] = [];
  const seen = new Set<string>();
  for (const item of doc) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    const label = typeof rec.label === 'string' ? rec.label.trim() : '';
    const opening_json = typeof rec.opening_json === 'string' ? rec.opening_json : '';
    if (!id || id.length > 64 || !label || label.length > 40 || !opening_json) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label, opening_json });
    if (out.length >= 7) break;
  }
  return out;
}

function storedOpeningsExtra(extras: StoryOpeningExtra[]): string {
  return JSON.stringify(
    extras.map((e) => ({
      id: e.id.trim(),
      label: e.label.trim(),
      opening_json: e.opening_json,
    })),
  );
}

/** Damaged / non-array → [] (GET fallback). Authorship 400 lives in the PUT handler. */
export function parseEndings(raw: string | null | undefined): StoryEnding[] {
  if (raw == null || raw === '') return [];
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    console.warn('[parseEndings] damaged endings_json');
    return [];
  }
  if (!Array.isArray(doc)) {
    console.warn('[parseEndings] damaged endings_json');
    return [];
  }
  const out: StoryEnding[] = [];
  const seen = new Set<string>();
  for (const item of doc) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    const title = typeof rec.title === 'string' ? rec.title.trim() : '';
    const description = typeof rec.description === 'string' ? rec.description : '';
    const badge_label = typeof rec.badge_label === 'string' ? rec.badge_label : '';
    if (!id || id.length > 64 || !title || title.length > 40) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title, description, badge_label });
    if (out.length >= 7) break;
  }
  return out;
}

function storedEndings(endings: StoryEnding[]): string {
  return JSON.stringify(
    endings.map((e) => ({
      id: e.id.trim(),
      title: e.title.trim(),
      description: e.description,
      badge_label: e.badge_label,
    })),
  );
}

function extraOpeningJsonIsObject(raw: string): boolean {
  try {
    const doc = JSON.parse(raw) as unknown;
    return typeof doc === 'object' && doc !== null && !Array.isArray(doc);
  } catch {
    return false;
  }
}

export function storyOut(s: StoryRow) {
  const { opening_json, stats_json, openings_extra_json, endings_json, ...rest } = s;
  return {
    ...rest,
    minor_cast: parseJson<unknown[]>(s.minor_cast, []),
    stats_json: parseJson<unknown[]>(stats_json ?? '[]', []),
    scene_catalog: parseSceneCatalog(s.scene_catalog ?? '{}'),
    opening: parseOpening(opening_json ?? '{}'),
    openings_extra: parseOpeningsExtra(openings_extra_json ?? '[]'),
    endings: parseEndings(endings_json ?? '[]'),
    archived: !!s.archived,
  };
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

/**
 * f9-catalog-write — the writable shape of `stories.scene_catalog`.
 *
 * This must mirror what `parseSceneCatalog` reads. It did not: the parser has
 * read `default_focus`, `owner_duty`, `outfits`, `emotions`, `stages` and
 * `duties` since f9-beat-render, while this schema listed none of them, and a
 * Zod object strips what it does not list. The six keys were therefore
 * unreachable through the API — the catalog could be parsed but never authored.
 *
 * Ranges follow the existing convention here: 200 places, 50 of everything else,
 * 60-character ids.
 */
const sceneCatalogSchema = z.object({
  places: z
    .array(
      z.object({
        id: z.string().min(1).max(60),
        name: z.string().max(80).optional(),
        tags: z.array(z.string().max(40)).max(20).optional(),
        /** §4.1 focus priority 3: who speaks here when nobody is named. */
        default_focus: z.string().max(60).optional(),
      }),
    )
    .max(200)
    .default([]),
  weathers: z.array(z.string().max(40)).max(50).default([]),
  arcs: z.array(z.string().max(60)).max(50).default([]),
  stagesByArc: z.record(z.array(z.string().max(60)).max(50)).default({}),
  flags: z
    .record(
      z.object({
        owner_stage: z.string().max(60).optional(),
        /** §4.3 hard_event: the duty whose holder this flag transition opens a slot for. */
        owner_duty: z.string().max(60).optional(),
      }),
    )
    .default({}),
  /** Allowed outfit tokens. An outfit outside this list yields no image, never a broken path. */
  outfits: z.array(z.string().max(40)).max(50).default([]),
  /** HUD inventory allow-list (Notes_260903). Adds outside this list are ignored. */
  items: z.array(z.string().max(60)).max(80).default([]),
  /** Ordered 경지 ladder. Empty → grade_up fail-closed. */
  grades: z.array(z.string().max(40)).max(20).default([]),
  /** emotion → asset index n. Non-integer or negative is rejected, not silently coerced. */
  emotions: z.record(z.number().int().min(0)).default({}),
  /** stage id → the duty that closes it (the other half of hard_event). */
  stages: z.record(z.object({ closer_duty: z.string().max(60).optional() })).default({}),
  /** duty → function slot, so two duties that do the same job share one line (§4.3). */
  duties: z.record(z.object({ slot: z.string().max(60).optional() })).default({}),
  /**
   * `storyOut` returns the *parsed* catalog, whose duty-slot map is flattened and
   * renamed to `dutySlots`. Accepting that name back keeps a GET → PUT round-trip
   * lossless; it is normalised to `duties` before storage, so there is still one
   * stored spelling. `duties` wins if a client sends both.
   */
  dutySlots: z.record(z.string().max(60)).optional(),
});

type SceneCatalogInput = z.infer<typeof sceneCatalogSchema>;

/** The stored JSON. One spelling (`duties`); the `dutySlots` alias is folded in here and nowhere else. */
function storedCatalog(c: SceneCatalogInput): string {
  const { dutySlots, ...rest } = c;
  const duties = { ...rest.duties };
  for (const [duty, slot] of Object.entries(dutySlots ?? {})) {
    if (!(duty in duties)) duties[duty] = { slot };
  }
  return JSON.stringify({ ...rest, duties });
}

const EMPTY_CATALOG_JSON = storedCatalog(sceneCatalogSchema.parse({}));

const storySchema = z.object({
  name: z.string().min(1).max(80),
  tagline: z.string().max(200).default(''),
  // story-editor-tabs A2: same treatment as CharacterRow.avatar — client echoes
  // the current value on every save, upload endpoint is the only writer of a
  // non-null value. Not omit=preserve (unlike scene_catalog/opening): there is
  // no legacy client that predates this field.
  cover: z.string().max(300).nullable().optional(),
  // story-editor-tabs A12: same always-write treatment as cover above — client
  // echoes the current value on every save. Creation-time fallback only (see
  // routes/conversations.ts); never read by buildPrompt/composeBeat.
  default_profile_name: z.string().max(60).nullable().optional(),
  default_format: z.enum(['beat', 'dialog', 'hunter']).nullable().optional(),
  // story-editor-tabs A7 (D2=a): omit=preserve on PUT (same as scene_catalog).
  // POST with the key absent stores []. Display-only; applySceneDelta untouched.
  stats_json: z.array(
    z.object({
      id: z.string().regex(/^[a-z0-9_]{1,20}$/),
      label: z.string().min(1).max(20),
      min: z.number().int(),
      max: z.number().int(),
      default: z.number().int(),
    }).refine((s) => s.min <= s.max, { message: 'min <= max' })
      .refine((s) => s.default >= s.min && s.default <= s.max, { message: 'default in range' }),
  ).max(7).superRefine((arr, ctx) => {
    const seen = new Set<string>();
    for (const row of arr) {
      if (seen.has(row.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate id ${row.id}` });
      }
      seen.add(row.id);
    }
  }).optional(),
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
  // f9-place-catalog: the Story layer of the scene model. Ids only; the server
  // validates every proposed delta against this list (applySceneDelta).
  //
  // f9-catalog-write: optional, NOT defaulted. An absent key means "leave the
  // stored catalog alone" — see the PUT handler. Defaulting here is what made a
  // save from a client that does not know about catalogs erase one.
  scene_catalog: sceneCatalogSchema.optional(),
  // ADR-F8d: same omit=preserve / explicit {} = empty contract as scene_catalog.
  opening: z.object({
    scenario: z.string().max(8000).optional(),
    greeting: z.string().max(10000).optional(),
    scene: z.object({
      place_id: z.string().max(60).optional(),
      weather: z.string().max(40).optional(),
      day_index: z.number().int().optional(),
      clock_minutes: z.number().int().optional(),
      beat_goal: z.string().max(500).optional(),
    }).optional(),
    present_ids: z.array(z.string().min(1).max(100)).max(12).optional(),
  }).optional(),
  // ADR-F8f: omit=preserve on PUT (same as opening). Explicit [] clears extras.
  // opening_json on each row is the F8d object *raw string* — not re-serialized.
  openings_extra: z
    .array(
      z
        .object({
          id: z.string().max(64),
          label: z.string().max(40),
          opening_json: z.string(),
        })
        .strict(),
    )
    .max(7)
    .superRefine((arr, ctx) => {
      const seen = new Set<string>();
      arr.forEach((row, i) => {
        const id = row.id.trim();
        const label = row.label.trim();
        if (id.length < 1 || id.length > 64) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'id required', path: [i, 'id'] });
        }
        if (label.length < 1 || label.length > 40) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'label 1-40', path: [i, 'label'] });
        }
        if (id && seen.has(id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate id ${id}`, path: [i, 'id'] });
        }
        if (id) seen.add(id);
        if (!extraOpeningJsonIsObject(row.opening_json)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'opening_json must be an F8d object', path: [i, 'opening_json'] });
        }
      });
    })
    .optional(),
  // ADR-F8g: omit=preserve on PUT (same as openings_extra). Explicit [] clears endings.
  endings: z
    .array(
      z
        .object({
          id: z.string().max(64),
          title: z.string().max(40),
          description: z.string().max(2000).optional().default(''),
          badge_label: z.string().max(40).optional().default(''),
        })
        .strict(),
    )
    .max(7)
    .superRefine((arr, ctx) => {
      const seen = new Set<string>();
      arr.forEach((row, i) => {
        const id = row.id.trim();
        const title = row.title.trim();
        if (id.length < 1 || id.length > 64) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'id required', path: [i, 'id'] });
        }
        if (title.length < 1 || title.length > 40) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'title 1-40', path: [i, 'title'] });
        }
        if (id && seen.has(id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate id ${id}`, path: [i, 'id'] });
        }
        if (id) seen.add(id);
      });
    })
    .optional(),
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

/**
 * story-editor-tabs A8: one lorebook per story (character_id NULL, story_id set),
 * same one-lorebook-per-owner convention as `lorebookFor` in characters.ts. This
 * is the only place a lorebook row ever gets `story_id` — no other path in the
 * product sets it, so the candidate-set query in builder.ts stays byte-identical
 * for every conversation that predates this slice.
 */
function lorebookForStory(db: Ctx['db'], storyId: string): string {
  const b = one<{ id: string }>(db, 'SELECT id FROM lorebooks WHERE story_id = ? ORDER BY created_at LIMIT 1', storyId);
  if (b) return b.id;
  const id = uid();
  run(db, 'INSERT INTO lorebooks (id, story_id, name, created_at) VALUES (?, ?, ?, ?)', id, storyId, '키워드북', nowIso());
  return id;
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
      const openingJson = d.opening === undefined
        ? '{}'
        : (Object.keys(d.opening).length === 0 ? '{}' : storedOpening(parseOpening(JSON.stringify(d.opening))));
      if (d.opening !== undefined && Object.keys(d.opening).length !== 0) {
        const opening = parseOpening(openingJson);
        const catalog = parseSceneCatalog(
          d.scene_catalog === undefined ? EMPTY_CATALOG_JSON : storedCatalog(d.scene_catalog),
        );
        const fieldErrors = validateOpeningPut(opening, catalog, []);
        if (fieldErrors.length) return reply.code(400).send({ error: 'invalid opening', fields: fieldErrors });
      }
      if (d.openings_extra !== undefined) {
        const catalog = parseSceneCatalog(
          d.scene_catalog === undefined ? EMPTY_CATALOG_JSON : storedCatalog(d.scene_catalog),
        );
        const extraErrors = d.openings_extra.flatMap((extra) =>
          validateOpeningPut(parseOpening(extra.opening_json), catalog, []).map((e) => ({
            ...e,
            field: `${extra.id}:${e.field}`,
          })),
        );
        if (extraErrors.length) return reply.code(400).send({ error: 'invalid openings_extra', fields: extraErrors });
      }
      run(
        db,
        `INSERT INTO stories (id, name, tagline, cover, default_profile_name, default_format, stats_json, setting, minor_cast, scene_catalog, opening_json, openings_extra_json, endings_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        d.name,
        d.tagline,
        d.cover ?? null,
        d.default_profile_name ?? null,
        d.default_format ?? null,
        JSON.stringify(d.stats_json ?? []),
        d.setting,
        JSON.stringify(d.minor_cast),
        // A new story with no catalog gets the empty one, as before.
        d.scene_catalog === undefined ? EMPTY_CATALOG_JSON : storedCatalog(d.scene_catalog),
        openingJson,
        d.openings_extra === undefined ? '[]' : storedOpeningsExtra(d.openings_extra),
        d.endings === undefined ? '[]' : storedEndings(d.endings),
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
      // f9-catalog-write: omitting `scene_catalog` preserves the stored one; sending
      // `{}` clears it. Those are different requests. This PUT is a full replace and
      // the field used to carry an empty-catalog default, so a client that does not
      // model catalogs — StoryEditor sends {name, tagline, setting, minor_cast} —
      // erased the catalog on every save. Preserving here covers every such client.
      // cover/default_profile_name/default_format are always-write like
      // name/tagline (StoryEditor's Draft echoes the current value back on every
      // save — see storySchema comments above). None is omit=preserve like
      // scene_catalog/opening, so there is no legacy-client erasure risk to guard.
      const sets = ['name=?', 'tagline=?', 'cover=?', 'default_profile_name=?', 'default_format=?', 'setting=?', 'minor_cast=?'];
      const args: unknown[] = [d.name, d.tagline, d.cover ?? null, d.default_profile_name ?? null, d.default_format ?? null, d.setting, JSON.stringify(d.minor_cast)];
      if (d.stats_json !== undefined) {
        sets.push('stats_json=?');
        args.push(JSON.stringify(d.stats_json));
      }
      if (d.scene_catalog !== undefined) {
        sets.push('scene_catalog=?');
        args.push(storedCatalog(d.scene_catalog));
      }
      if (d.opening !== undefined) {
        const openingJson = Object.keys(d.opening).length === 0
          ? '{}'
          : storedOpening(parseOpening(JSON.stringify(d.opening)));
        const opening = parseOpening(openingJson);
        const catalog = parseSceneCatalog(
          d.scene_catalog !== undefined ? storedCatalog(d.scene_catalog) : (s.scene_catalog ?? '{}'),
        );
        const hosted = hostedCharacters(db, s.id).map((c) => c.character_id);
        const fieldErrors = validateOpeningPut(opening, catalog, hosted);
        if (fieldErrors.length) return reply.code(400).send({ error: 'invalid opening', fields: fieldErrors });
        sets.push('opening_json=?');
        args.push(openingJson);
      }
      if (d.openings_extra !== undefined) {
        const catalog = parseSceneCatalog(
          d.scene_catalog !== undefined ? storedCatalog(d.scene_catalog) : (s.scene_catalog ?? '{}'),
        );
        const hosted = hostedCharacters(db, s.id).map((c) => c.character_id);
        const extraErrors = d.openings_extra.flatMap((extra) =>
          validateOpeningPut(parseOpening(extra.opening_json), catalog, hosted).map((e) => ({
            ...e,
            field: `${extra.id}:${e.field}`,
          })),
        );
        if (extraErrors.length) return reply.code(400).send({ error: 'invalid openings_extra', fields: extraErrors });
        sets.push('openings_extra_json=?');
        args.push(storedOpeningsExtra(d.openings_extra));
      }
      if (d.endings !== undefined) {
        sets.push('endings_json=?');
        args.push(storedEndings(d.endings));
      }
      sets.push('updated_at=?');
      args.push(nowIso());
      run(db, `UPDATE stories SET ${sets.join(', ')} WHERE id=?`, ...args, s.id);
      return storyOut(one<StoryRow>(db, 'SELECT * FROM stories WHERE id = ?', s.id)!);
    });

    app.delete<{ Params: { id: string } }>('/api/stories/:id', async (req, reply) => {
      const r = run(db, 'UPDATE stories SET archived = 1, updated_at = ? WHERE id = ?', nowIso(), req.params.id);
      if (r.changes === 0) return reply.code(404).send({ error: 'not found' });
      return { ok: true };
    });

    // story-editor-tabs A2: same sniff/size pipeline as character avatars
    // (media/avatar.ts). Separate content-type parser scope from characterRoutes
    // — each app.register() call is its own Fastify encapsulation context.
    app.addContentTypeParser(
      ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/octet-stream'],
      { parseAs: 'buffer', bodyLimit: AVATAR_MAX_BYTES },
      (_req, body, done) => {
        done(null, body);
      },
    );

    app.post<{ Params: { id: string }; Body: Buffer }>(
      '/api/stories/:id/cover',
      { bodyLimit: AVATAR_MAX_BYTES },
      async (req, reply) => {
        const id = req.params.id;
        const s = one<StoryRow>(db, 'SELECT * FROM stories WHERE id = ?', id);
        if (!s) return reply.code(404).send({ error: 'not found' });
        const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        let kind;
        try {
          kind = inspectAvatar(buf);
        } catch (e) {
          if (e instanceof AvatarReject) return reply.code(e.status).send({ error: e.message });
          throw e;
        }
        const dir = path.join(config.dataDir, 'media', 'covers');
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, `${id}.${AVATAR_EXT[kind]}`);
        for (const ext of Object.values(AVATAR_EXT)) {
          const prev = path.join(dir, `${id}.${ext}`);
          if (prev !== dest && fs.existsSync(prev)) fs.unlinkSync(prev);
        }
        fs.writeFileSync(dest, buf);
        const cover = publicCoverPath(id, kind);
        run(db, 'UPDATE stories SET cover = ?, updated_at = ? WHERE id = ?', cover, nowIso(), id);
        return storyOut(one<StoryRow>(db, 'SELECT * FROM stories WHERE id = ?', id)!);
      },
    );

    // ---- 키워드북 (story-editor-tabs A8; PUT/DELETE/clone on /api/lore/:id are
    // owner-agnostic and already shipped by characterRoutes — reused as-is) ----
    app.get<{ Params: { id: string } }>('/api/stories/:id/lore', async (req, reply) => {
      if (!one(db, 'SELECT 1 FROM stories WHERE id = ?', req.params.id)) return reply.code(404).send({ error: 'not found' });
      const rows = many<LoreEntryRow>(
        db,
        `SELECT e.* FROM lore_entries e JOIN lorebooks b ON b.id = e.lorebook_id WHERE b.story_id = ? ORDER BY e.priority DESC, e.title`,
        req.params.id,
      );
      return rows.map(loreOut);
    });

    app.post<{ Params: { id: string } }>('/api/stories/:id/lore', async (req, reply) => {
      if (!one(db, 'SELECT 1 FROM stories WHERE id = ?', req.params.id)) return reply.code(404).send({ error: 'not found' });
      const p = loreSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: p.error.flatten() });
      const d = p.data;
      const id = uid();
      run(
        db,
        'INSERT INTO lore_entries (id, lorebook_id, title, keywords_json, secondary_keys_json, content, priority, always_on, token_cap, enabled, selective) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, lorebookForStory(db, req.params.id), d.title, JSON.stringify(d.keywords), JSON.stringify(d.secondary_keys ?? []), d.content, d.priority, d.always_on ? 1 : 0, d.token_cap, d.enabled ? 1 : 0, d.selective ? 1 : 0,
      );
      return reply.code(201).send(loreOut(one<LoreEntryRow>(db, 'SELECT * FROM lore_entries WHERE id = ?', id)!));
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
          story_participant_ids_snapshot: null,
          story_opening_snapshot: null,
          story_endings_snapshot: null,
          ended_at: null,
          reached_ending_id: null,
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
