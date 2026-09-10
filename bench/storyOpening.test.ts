/** npx tsx bench/storyOpening.test.ts
 * ADR-F8d story opening: schema, PUT omit/empty/400, POST overlay+greeting, 1:1 prompt 3-A.
 * Isolated: temp DB, no systemd, no live DB, no model call.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { openDb } from '../apps/server/src/db/index.ts';
import { GenerationQueue } from '../apps/server/src/model/queue.ts';
import { characterRoutes } from '../apps/server/src/routes/characters.ts';
import { conversationRoutes } from '../apps/server/src/routes/conversations.ts';
import { storyRoutes } from '../apps/server/src/routes/stories.ts';
import { buildPrompt } from '../apps/server/src/prompt/builder.ts';
import { parseOpening, resolveOpening, applyOpeningOverlay, validateOpeningPut } from '../apps/server/src/prompt/storyOpening.ts';
import { catalogFromStory } from '../apps/server/src/prompt/sceneCatalog.ts';
import { PROMPT_VERSION } from '../apps/server/src/config.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';
import type { ConversationRow, MessageRow } from '../apps/server/src/types.ts';
import type { DB } from '../apps/server/src/db/index.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

function cols(db: ReturnType<typeof openDb>, table: string) {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number; dflt_value: unknown }>);
}

async function main() {
await t('0014 adds opening_json default {} and nullable story_opening_snapshot only', () => {
  const sql = fs.readFileSync('apps/server/migrations/0014_story_opening.sql', 'utf8');
  assert.match(sql, /ALTER TABLE stories ADD COLUMN opening_json TEXT NOT NULL DEFAULT '\{\}'/);
  assert.match(sql, /ALTER TABLE conversations ADD COLUMN story_opening_snapshot TEXT/);
  assert.equal(/\bBEGIN\b/i.test(sql), false);
  assert.equal(/\bworlds\b/.test(sql), false);
  assert.equal(sql.includes('default_character_id'), false);
});

await t('parseOpening treats {} / damage / blank as empty; resolveOpening is DB-free', () => {
  assert.deepEqual(parseOpening('{}').present_ids, []);
  assert.equal(parseOpening('{}').scenario, '');
  assert.equal(parseOpening('not-json').greeting, '');
  assert.equal(resolveOpening({ story_applied_at: null } as ConversationRow), null);
  const src = fs.readFileSync('apps/server/src/prompt/storyOpening.ts', 'utf8');
  assert.equal(/from '\.\.\/db/.test(src), false);
  assert.equal(src.includes('better-sqlite'), false);
});

await t('PUT validate: clock 1440, day 0, foreign present_id, unknown place', () => {
  const catalog = { places: [{ id: '교실' }], weathers: ['맑음'] };
  assert.ok(validateOpeningPut(parseOpening(JSON.stringify({ scene: { clock_minutes: 1440 } })), catalog, []).length);
  assert.ok(validateOpeningPut(parseOpening(JSON.stringify({ scene: { day_index: 0 } })), catalog, []).length);
  assert.ok(validateOpeningPut(parseOpening(JSON.stringify({ present_ids: ['x'] })), catalog, ['a']).length);
  assert.ok(validateOpeningPut(parseOpening(JSON.stringify({ scene: { place_id: '옥상' } })), catalog, []).length);
  assert.equal(validateOpeningPut(parseOpening(JSON.stringify({ scene: { clock_minutes: 578, place_id: '교실' } })), catalog, []).length, 0);
});

await t('applyOpeningOverlay: valid place wins; bad place dropped; owner union', () => {
  const catalog = catalogFromStory(JSON.stringify({
    places: [{ id: '교실', name: '1-3' }, { id: '복도' }],
    weathers: ['맑음', '흐림'],
    arcs: ['entry'],
    stagesByArc: { entry: ['reg'] },
  }));
  const opening = parseOpening(JSON.stringify({
    scene: { place_id: '복도', clock_minutes: 100, weather: '흐림' },
    present_ids: ['nari'],
  }));
  const overlay = applyOpeningOverlay({
    opening,
    catalog,
    hostedIds: ['hayeon', 'nari'],
    ownerId: 'hayeon',
    overlay: {},
  });
  assert.equal(overlay.location, '복도');
  assert.equal(overlay.clock_minutes, 100);
  assert.equal(overlay.weather, '흐림');
  assert.deepEqual(overlay.present_ids, ['hayeon', 'nari']);

  const dropped = applyOpeningOverlay({
    opening: parseOpening(JSON.stringify({ scene: { place_id: '없는곳', clock_minutes: 2000 } })),
    catalog,
    hostedIds: ['hayeon'],
    ownerId: 'hayeon',
    overlay: {},
  });
  assert.equal(dropped.location, undefined);
  assert.equal(dropped.clock_minutes, undefined);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-story-opening-'));
const db = openDb(tmp, path.resolve('apps/server/migrations'));
const ctx = {
  db,
  model: {} as unknown as Ctx['model'],
  queue: new GenerationQueue(1),
  log: { error() {}, info() {}, warn() {}, debug() {} } as unknown as Ctx['log'],
  resolvedModel: () => 'test-model',
  setResolvedModel: () => {},
  health: async () => ({ ok: true, checkedAt: 't', latencyMs: 0, models: ['test-model'] }),
} as Ctx;
const app = Fastify({ logger: false });
await app.register(characterRoutes(ctx));
await app.register(storyRoutes(ctx));
await app.register(conversationRoutes(ctx));
await app.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${(app.addresses()[0] as { port: number }).port}`;

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(`${origin}${url}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = text;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, text };
}

await t('openDb records 0014; stories.opening_json default {}; character_id NOT NULL', () => {
  const names = (db.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as Array<{ name: string }>).map((r) => r.name);
  assert.ok(names.includes('0014_story_opening.sql'), JSON.stringify(names));
  const storyCol = cols(db, 'stories').find((c) => c.name === 'opening_json');
  assert.ok(storyCol);
  assert.equal(storyCol!.notnull, 1);
  assert.equal(String(storyCol!.dflt_value).replace(/'/g, ''), '{}');
  const convCol = cols(db, 'conversations').find((c) => c.name === 'story_opening_snapshot');
  assert.ok(convCol);
  assert.equal(convCol!.notnull, 0);
  assert.equal(cols(db, 'conversations').find((c) => c.name === 'character_id')?.notnull, 1);
});

const hayeon = (await api('POST', '/api/characters', { name: '하연', personality: '반장', first_message: '카드인사 {{char}}' })).json as { id: string };
const nari = (await api('POST', '/api/characters', { name: '나리', personality: '친구', first_message: '나리인사' })).json as { id: string };

const created = await api('POST', '/api/stories', {
  name: '교실',
  setting: '학교',
  scene_catalog: {
    places: [{ id: '교실', name: '1-3' }, { id: '복도' }],
    weathers: ['맑음', '흐림'],
    arcs: ['entry'],
    stagesByArc: { entry: ['reg'] },
  },
});
assert.equal(created.status, 201, created.text);
const story = created.json as { id: string; opening: { scenario: string } };
assert.equal(story.opening.scenario, '');

await api('POST', `/api/stories/${story.id}/characters`, { characterId: hayeon.id, sortOrder: 0 });
await api('POST', `/api/stories/${story.id}/characters`, { characterId: nari.id, sortOrder: 1 });

await t('PUT omit opening preserves stored opening_json', async () => {
  const filled = await api('PUT', `/api/stories/${story.id}`, {
    name: '교실', tagline: '', setting: '학교', minor_cast: [],
    opening: { scenario: '보관할 시나리오', greeting: '', scene: {}, present_ids: [] },
  });
  assert.equal(filled.status, 200, filled.text);
  const before = (db.prepare('SELECT opening_json FROM stories WHERE id = ?').get(story.id) as { opening_json: string }).opening_json;
  const omitted = await api('PUT', `/api/stories/${story.id}`, {
    name: '교실', tagline: '', setting: '학교-수정', minor_cast: [],
  });
  assert.equal(omitted.status, 200, omitted.text);
  const after = (db.prepare('SELECT opening_json FROM stories WHERE id = ?').get(story.id) as { opening_json: string }).opening_json;
  assert.equal(after, before);
});

await t('PUT explicit {} empties opening; clock 1440 is 400', async () => {
  const bad = await api('PUT', `/api/stories/${story.id}`, {
    name: '교실', tagline: '', setting: '학교', minor_cast: [],
    opening: { scene: { clock_minutes: 1440 } },
  });
  assert.equal(bad.status, 400, bad.text);
  const empty = await api('PUT', `/api/stories/${story.id}`, {
    name: '교실', tagline: '', setting: '학교', minor_cast: [],
    opening: {},
  });
  assert.equal(empty.status, 200, empty.text);
  const stored = (db.prepare('SELECT opening_json FROM stories WHERE id = ?').get(story.id) as { opening_json: string }).opening_json;
  assert.equal(stored, '{}');
});

await t('PUT hosted-only present_ids; foreign id 400', async () => {
  const bad = await api('PUT', `/api/stories/${story.id}`, {
    name: '교실', tagline: '', setting: '학교', minor_cast: [],
    opening: { present_ids: ['not-hosted'] },
  });
  assert.equal(bad.status, 400);
  const ok = await api('PUT', `/api/stories/${story.id}`, {
    name: '교실', tagline: '', setting: '학교', minor_cast: [],
    opening: {
      scenario: '스토리 시나리오만',
      greeting: '오프닝 {{char}} 인사',
      scene: { place_id: '복도', weather: '흐림', clock_minutes: 600, day_index: 2, beat_goal: '이동' },
      present_ids: [nari.id],
    },
  });
  assert.equal(ok.status, 200, ok.text);
});

await t('POST copies opening_json raw and applies overlay + greeting (party too)', async () => {
  const raw = (db.prepare('SELECT opening_json FROM stories WHERE id = ?').get(story.id) as { opening_json: string }).opening_json;
  const res = await api('POST', '/api/conversations', {
    characterId: hayeon.id,
    storyId: story.id,
    participantIds: [hayeon.id, nari.id],
    mode: 'story',
  });
  assert.equal(res.status, 201, res.text);
  const conv = res.json as { id: string; story_opening_snapshot: string; scene_json: string };
  assert.equal(conv.story_opening_snapshot, raw);
  const scene = JSON.parse(conv.scene_json) as { location?: string; weather?: string; clock_minutes?: number; day_index?: number; present_ids?: string[] };
  assert.equal(scene.location, '복도');
  assert.equal(scene.weather, '흐림');
  assert.equal(scene.clock_minutes, 600);
  assert.equal(scene.day_index, 2);
  assert.ok(scene.present_ids?.includes(hayeon.id));
  assert.ok(scene.present_ids?.includes(nari.id));

  const detail = await api('GET', `/api/conversations/${conv.id}`);
  const msgs = (detail.json as { messages: Array<{ role: string; content: string; meta: Record<string, unknown> }> }).messages;
  const greet = msgs.find((m) => m.role === 'assistant');
  assert.ok(greet);
  assert.equal(greet!.content.includes('오프닝 하연 인사'), true);
  assert.equal(greet!.meta.block_kind, undefined);
  assert.equal(greet!.meta.speaker_character_id, undefined);
});

await t('empty greeting on party still drops character first_message', async () => {
  const blank = await api('POST', '/api/stories', { name: '빈오프닝', setting: 'x' });
  const sid = (blank.json as { id: string }).id;
  await api('POST', `/api/stories/${sid}/characters`, { characterId: hayeon.id, sortOrder: 0 });
  await api('POST', `/api/stories/${sid}/characters`, { characterId: nari.id, sortOrder: 1 });
  const res = await api('POST', '/api/conversations', {
    characterId: hayeon.id,
    storyId: sid,
    participantIds: [hayeon.id, nari.id],
    mode: 'story',
  });
  assert.equal(res.status, 201, res.text);
  const detail = await api('GET', `/api/conversations/${(res.json as { id: string }).id}`);
  const msgs = (detail.json as { messages: Array<{ role: string; content: string }> }).messages;
  assert.equal(msgs.some((m) => m.content.includes('카드인사')), false);
});

await t('1:1 no-story still uses character first_message', async () => {
  const res = await api('POST', '/api/conversations', { characterId: hayeon.id, mode: 'chat' });
  assert.equal(res.status, 201, res.text);
  const detail = await api('GET', `/api/conversations/${(res.json as { id: string }).id}`);
  const msgs = (detail.json as { messages: Array<{ role: string; content: string }> }).messages;
  assert.ok(msgs.some((m) => m.content.includes('카드인사')));
});

await app.close();

await t('3-A: opening.scenario replaces card scenario; no concat; no-story unchanged', () => {
  const mem = new Database(':memory:') as unknown as DB;
  mem.exec(`
    CREATE TABLE characters (id TEXT PRIMARY KEY, name TEXT, tagline TEXT, description TEXT, personality TEXT, speech_style TEXT, scenario TEXT, taboos TEXT, example_dialogue TEXT);
    CREATE TABLE personas (id TEXT PRIMARY KEY, name TEXT, address_as TEXT, appearance TEXT, personality TEXT, relationship TEXT, is_default INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE model_profiles (name TEXT PRIMARY KEY, model TEXT, temperature REAL, top_p REAL, max_tokens INTEGER, stop_json TEXT, system_mode TEXT, notes TEXT);
    INSERT INTO characters VALUES ('c1','테스트캐','짧은소개','설명','성격','말투','카드시나리오','금기','예시');
    INSERT INTO model_profiles VALUES ('rp-balanced',NULL,0.8,0.95,400,'[]','system',NULL);
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, character_id TEXT, persona_id TEXT, mode TEXT, profile_name TEXT, scene_json TEXT, user_note TEXT,
      story_id TEXT, story_applied_at TEXT, story_name_snapshot TEXT, story_setting_snapshot TEXT, story_minor_cast_snapshot TEXT,
      story_opening_snapshot TEXT
    );
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, status TEXT, created_at TEXT);
    CREATE TABLE memories (id TEXT PRIMARY KEY, conversation_id TEXT, character_id TEXT, content TEXT, source TEXT, status TEXT, importance INTEGER, scope TEXT, evidence_message_ids_json TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE summaries (id TEXT PRIMARY KEY, conversation_id TEXT, content TEXT, covers_until_message_id TEXT, covers_from_message_id TEXT, status TEXT, created_at TEXT, tier TEXT, rolled_up_into TEXT);
    CREATE TABLE lorebooks (id TEXT PRIMARY KEY, character_id TEXT);
    CREATE TABLE lore_entries (id TEXT PRIMARY KEY, lorebook_id TEXT, title TEXT, content TEXT, keywords_json TEXT, secondary_keys_json TEXT, selective INTEGER, always_on INTEGER, priority INTEGER, token_cap INTEGER, enabled INTEGER);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO settings VALUES ('token_calibration','1.0');
  `);
  mem.prepare(`INSERT INTO personas VALUES (?,?,?,?,?,?,?,?,?)`).run('p1', '유저', '', '', '', '', 1, 't', 't');

  const base = {
    id: 'conv1', character_id: 'c1', persona_id: 'p1', title: '', mode: 'chat' as const, profile_name: 'rp-balanced',
    scene_json: '{}', head_message_id: null, prompt_version: PROMPT_VERSION, favorite: 0, archived: 0,
    created_at: 't', updated_at: 't', last_message_at: 't', user_note: null,
    persona_name_snapshot: null, persona_address_snapshot: null, persona_appearance_snapshot: null,
    persona_personality_snapshot: null, persona_relationship_snapshot: null, persona_applied_at: null,
    story_id: null, story_applied_at: null, story_name_snapshot: null, story_setting_snapshot: null,
    story_minor_cast_snapshot: null, story_participant_ids_snapshot: null, story_opening_snapshot: null,
  } as ConversationRow;
  const hist = [{ id: 'm1', conversation_id: 'conv1', role: 'user', content: '안녕', status: 'complete', created_at: 't' } as MessageRow];

  const noStory = buildPrompt(mem, base, hist, 8192, 'm');
  const noStorySys = String(noStory.messages.find((m) => m.role === 'system')?.content ?? '');
  assert.ok(noStorySys.includes('카드시나리오'));
  assert.equal(noStorySys.includes('오프닝시나리오'), false);

  const withOpening = buildPrompt(mem, {
    ...base,
    mode: 'story',
    story_id: 's1',
    story_applied_at: 't0',
    story_name_snapshot: 'n',
    story_setting_snapshot: '',
    story_minor_cast_snapshot: '[]',
    story_opening_snapshot: JSON.stringify({ scenario: '오프닝시나리오' }),
  }, hist, 8192, 'm');
  const openSys = String(withOpening.messages.find((m) => m.role === 'system')?.content ?? '');
  assert.ok(openSys.includes('오프닝시나리오'));
  assert.equal(openSys.includes('카드시나리오'), false);
  assert.equal(openSys.includes('카드시나리오오프닝'), false);
  assert.ok(openSys.includes('시나리오:'));

  const blankOpening = buildPrompt(mem, {
    ...base,
    mode: 'story',
    story_id: 's1',
    story_applied_at: 't0',
    story_name_snapshot: 'n',
    story_setting_snapshot: '',
    story_minor_cast_snapshot: '[]',
    story_opening_snapshot: '{}',
  }, hist, 8192, 'm');
  const blankSys = String(blankOpening.messages.find((m) => m.role === 'system')?.content ?? '');
  assert.ok(blankSys.includes('카드시나리오'));
});

await t('PROMPT_VERSION records +opening; editor has opening fields; templates HARD_RULES untouched', () => {
  assert.equal(PROMPT_VERSION, '2026.08.22-r1+story+compact+roster+opening');
  const editor = fs.readFileSync('apps/web/src/components/StoryEditor.tsx', 'utf8');
  assert.ok(editor.includes('오프닝'));
  assert.ok(editor.includes('openingBody'));
  const templates = fs.readFileSync('apps/server/src/prompt/templates.ts', 'utf8');
  assert.ok(templates.includes("오직 '{{char}}' 역할만 연기한다"));
  const compose = fs.readFileSync('apps/server/src/prompt/composeBeat.ts', 'utf8');
  const passes = fs.readFileSync('apps/server/src/prompt/passes.ts', 'utf8');
  // slice 5: party prompts untouched
  assert.equal(passes.includes('opening.scenario'), false);
  assert.equal(compose.includes('opening.scenario'), false);
});

console.log(`\n${passed} passed`);
}

main().catch((e) => {
  console.error('RED', e);
  process.exit(1);
});
