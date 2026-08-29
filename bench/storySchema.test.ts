/** npx tsx bench/storySchema.test.ts
 * F8 story-schema — isolated CRUD + mapping. Temp DB only.
 * Helper/bench PASS is not a product PASS (helper-vs-live-contract).
 * Does not start systemd or touch the live DB. No HomePage. No inject.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Fastify from 'fastify';
import { openDb } from '../apps/server/src/db/index.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import type { Ctx } from '../apps/server/src/ctx.js';

const require2 = createRequire(import.meta.url);
let storyRoutes: typeof import('../apps/server/src/routes/stories.js')['storyRoutes'];
try {
  storyRoutes = require2('../apps/server/src/routes/stories.ts').storyRoutes;
} catch (e) {
  console.error('RED: stories routes missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

function cols(db: ReturnType<typeof openDb>, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
}

async function main() {
  const migSql = fs.readFileSync('apps/server/migrations/0008_stories.sql', 'utf8');
  const compat = JSON.parse(fs.readFileSync('deploy/schema-compat.json', 'utf8')) as {
    required_migrations: string[];
  };
  const builderSrc = fs.readFileSync('apps/server/src/prompt/builder.ts', 'utf8');
  const charSrc = fs.readFileSync('apps/server/src/routes/characters.ts', 'utf8');
  const homeSrc = fs.readFileSync('apps/web/src/pages/HomePage.tsx', 'utf8');

  await t('0008 has no BEGIN/COMMIT, no cover, no worlds/world_id', () => {
    assert.match(migSql, /CREATE TABLE stories/);
    assert.match(migSql, /CREATE TABLE story_characters/);
    assert.equal(/\bBEGIN\b/i.test(migSql), false);
    assert.equal(/\bCOMMIT\b/i.test(migSql), false);
    assert.equal(/\bcover\b/i.test(migSql), false);
    assert.equal(/\bworlds\b/i.test(migSql), false);
    assert.equal(/\bworld_id\b/i.test(migSql), false);
  });

  await t('schema-compat required_migrations includes 0008_stories.sql', () => {
    assert.ok(compat.required_migrations.includes('0008_stories.sql'));
    assert.equal(compat.required_migrations.includes('0007_persona_snapshot.sql'), true);
  });

  await t('builder.ts does not query live stories table', () => {
    assert.equal(/\bFROM\s+stories\b/i.test(builderSrc), false);
    assert.equal(builderSrc.includes('story_characters'), false);
  });

  await t('GET /api/characters source has no story_characters filter', () => {
    assert.equal(charSrc.includes('story_characters'), false);
  });

  await t('HomePage character tab still uses GET /api/characters (no hide filter)', () => {
    assert.ok(homeSrc.includes('/api/characters'));
    assert.ok(homeSrc.includes('CharacterEditor'));
    assert.equal(homeSrc.includes('story_characters'), false);
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-story-schema-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));

  await t('openDb records 0008_stories.sql; stories + story_characters exist', () => {
    const names = (db.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    assert.ok(names.includes('0008_stories.sql'), JSON.stringify(names));
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    assert.ok(tables.includes('stories'));
    assert.ok(tables.includes('story_characters'));
    assert.equal(tables.includes('worlds'), false);
  });

  await t('stories columns match ADR v1 (no cover)', () => {
    assert.deepEqual(cols(db, 'stories'), [
      'id',
      'name',
      'tagline',
      'setting',
      'minor_cast',
      'archived',
      'created_at',
      'updated_at',
    ]);
  });

  await t('story_characters columns + composite PK', () => {
    assert.deepEqual(cols(db, 'story_characters'), ['story_id', 'character_id', 'role', 'sort_order']);
    const pk = db.prepare(`PRAGMA table_info(story_characters)`).all() as Array<{ name: string; pk: number }>;
    assert.equal(pk.find((c) => c.name === 'story_id')?.pk, 1);
    assert.equal(pk.find((c) => c.name === 'character_id')?.pk, 2);
  });

  db.exec(`
    INSERT INTO characters (id, name, tagline, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, tags_json, created_at, updated_at)
    VALUES
      ('c1','메인A','','','','','','','','','[]','t0','t0'),
      ('c2','메인B','','','','','','','','','[]','t0','t0');
  `);

  const ctx = {
    db,
    model: {} as Ctx['model'],
    queue: { activeList: [] } as unknown as Ctx['queue'],
    log: console as unknown as Ctx['log'],
    resolvedModel: () => 'm',
    setResolvedModel: () => {},
    health: async () => ({ ok: true, checkedAt: 't', latencyMs: 0, models: [] }),
  } as Ctx;

  const app = Fastify({ logger: false });
  await app.register(characterRoutes(ctx));
  await app.register(storyRoutes(ctx));

  await t('POST /api/stories 201 + GET list/one', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/stories',
      headers: { 'content-type': 'application/json' },
      payload: {
        name: '설원',
        tagline: '한줄',
        setting: '눈 덮인 왕국',
        minor_cast: [{ name: '행상인', note: '정보를 판다' }],
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json();
    assert.ok(body.id);
    assert.equal(body.name, '설원');
    assert.equal(body.tagline, '한줄');
    assert.equal(body.setting, '눈 덮인 왕국');
    assert.deepEqual(body.minor_cast, [{ name: '행상인', note: '정보를 판다' }]);
    assert.equal(body.archived, false);
    assert.equal('cover' in body, false);

    const list = await app.inject({ method: 'GET', url: '/api/stories' });
    assert.equal(list.statusCode, 200, list.body);
    const rows = list.json();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, body.id);
    assert.equal(rows[0].character_count, 0);

    const one = await app.inject({ method: 'GET', url: `/api/stories/${body.id}` });
    assert.equal(one.statusCode, 200, one.body);
    assert.deepEqual(one.json().characters, []);
    (globalThis as { storyId?: string }).storyId = body.id;
  });

  const storyId = (globalThis as { storyId?: string }).storyId!;

  await t('POST empty name is 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/stories',
      headers: { 'content-type': 'application/json' },
      payload: { name: '' },
    });
    assert.equal(res.statusCode, 400, res.body);
  });

  await t('POST invalid minor_cast is 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/stories',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'x', minor_cast: [{ note: '이름없음' }] },
    });
    assert.equal(res.statusCode, 400, res.body);
  });

  await t('PUT /api/stories/:id updates setting + minor_cast', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/stories/${storyId}`,
      headers: { 'content-type': 'application/json' },
      payload: {
        name: '설원',
        tagline: '한줄',
        setting: '왕국은 무너졌다',
        minor_cast: [{ name: '행상인', note: '사라짐' }, { name: '경비', note: '문지기' }],
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().setting, '왕국은 무너졌다');
    assert.equal(res.json().minor_cast.length, 2);
  });

  await t('GET unknown story 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stories/no-such' });
    assert.equal(res.statusCode, 404, res.body);
  });

  await t('POST mapping main + GET one lists hosted character', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/stories/${storyId}/characters`,
      headers: { 'content-type': 'application/json' },
      payload: { characterId: 'c1' },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json();
    assert.equal(body.character_id, 'c1');
    assert.equal(body.role, 'main');
    const one = await app.inject({ method: 'GET', url: `/api/stories/${storyId}` });
    assert.equal(one.statusCode, 200, one.body);
    assert.equal(one.json().characters.length, 1);
    assert.equal(one.json().characters[0].character_id, 'c1');
    assert.equal(one.json().characters[0].name, '메인A');
    const list = await app.inject({ method: 'GET', url: '/api/stories' });
    assert.equal(list.json()[0].character_count, 1);
  });

  await t('role other than main is 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/stories/${storyId}/characters`,
      headers: { 'content-type': 'application/json' },
      payload: { characterId: 'c2', role: 'minor' },
    });
    assert.equal(res.statusCode, 400, res.body);
  });

  await t('unknown character mapping 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/stories/${storyId}/characters`,
      headers: { 'content-type': 'application/json' },
      payload: { characterId: 'no-char' },
    });
    assert.equal(res.statusCode, 404, res.body);
  });

  await t('duplicate mapping 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/stories/${storyId}/characters`,
      headers: { 'content-type': 'application/json' },
      payload: { characterId: 'c1' },
    });
    assert.equal(res.statusCode, 409, res.body);
  });

  await t('N:M — same character in a second story', async () => {
    const s2 = await app.inject({
      method: 'POST',
      url: '/api/stories',
      headers: { 'content-type': 'application/json' },
      payload: { name: '항구' },
    });
    assert.equal(s2.statusCode, 201, s2.body);
    const id2 = s2.json().id as string;
    const map = await app.inject({
      method: 'POST',
      url: `/api/stories/${id2}/characters`,
      headers: { 'content-type': 'application/json' },
      payload: { characterId: 'c1', sortOrder: 2 },
    });
    assert.equal(map.statusCode, 201, map.body);
    const n = db.prepare('SELECT COUNT(*) AS n FROM story_characters WHERE character_id = ?').get('c1') as { n: number };
    assert.equal(n.n, 2);
    (globalThis as { storyId2?: string }).storyId2 = id2;
  });

  await t('GET /api/characters still lists hosted mains (no hide filter)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/characters' });
    assert.equal(res.statusCode, 200, res.body);
    const names = res.json().map((r: { name: string }) => r.name).sort();
    assert.deepEqual(names, ['메인A', '메인B']);
  });

  await t('DELETE mapping removes row; character remains', async () => {
    const id2 = (globalThis as { storyId2?: string }).storyId2!;
    const res = await app.inject({ method: 'DELETE', url: `/api/stories/${id2}/characters/c1` });
    assert.equal(res.statusCode, 200, res.body);
    const n = db.prepare('SELECT COUNT(*) AS n FROM story_characters WHERE story_id = ?').get(id2) as { n: number };
    assert.equal(n.n, 0);
    const c = db.prepare('SELECT id FROM characters WHERE id = ?').get('c1');
    assert.ok(c);
  });

  await t('DELETE story soft-archives; list hides it; mapping kept', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM story_characters WHERE story_id = ?').get(storyId) as { n: number };
    assert.equal(before.n, 1);
    const res = await app.inject({ method: 'DELETE', url: `/api/stories/${storyId}` });
    assert.equal(res.statusCode, 200, res.body);
    const list = await app.inject({ method: 'GET', url: '/api/stories' });
    assert.equal(list.json().some((r: { id: string }) => r.id === storyId), false);
    const one = await app.inject({ method: 'GET', url: `/api/stories/${storyId}` });
    assert.equal(one.statusCode, 200, one.body);
    assert.equal(one.json().archived, true);
    const after = db.prepare('SELECT COUNT(*) AS n FROM story_characters WHERE story_id = ?').get(storyId) as { n: number };
    assert.equal(after.n, 1);
  });

  await t('SQL DELETE story cascades mapping; character remains', () => {
    db.prepare('DELETE FROM stories WHERE id = ?').run(storyId);
    const n = db.prepare('SELECT COUNT(*) AS n FROM story_characters WHERE story_id = ?').get(storyId) as { n: number };
    assert.equal(n.n, 0);
    const c = db.prepare('SELECT id FROM characters WHERE id = ?').get('c1');
    assert.ok(c);
  });

  await t('SQL DELETE character cascades mapping', () => {
    const s3 = db.prepare(
      `INSERT INTO stories (id, name, tagline, setting, minor_cast, archived, created_at, updated_at)
       VALUES ('s3','x','','','[]',0,'t0','t0')`,
    );
    s3.run();
    db.prepare(`INSERT INTO story_characters (story_id, character_id, role, sort_order) VALUES ('s3','c2','main',0)`).run();
    db.prepare('DELETE FROM characters WHERE id = ?').run('c2');
    const n = db.prepare('SELECT COUNT(*) AS n FROM story_characters WHERE character_id = ?').get('c2') as { n: number };
    assert.equal(n.n, 0);
  });

  await t('conversations.character_id NOT NULL; memories still have no story_id', () => {
    const info = db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string; notnull: number }>;
    assert.equal(info.find((c) => c.name === 'character_id')?.notnull, 1);
    assert.equal(info.some((c) => c.name === 'story_id'), true);
    assert.equal(cols(db, 'memories').includes('story_id'), false);
  });

  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`passed ${passed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
