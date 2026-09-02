/** npx tsx bench/sceneStateSchema.test.ts
 * F9B Scene State schema — additive optional keys on conversations.scene_json.
 * Clock storage key is clock_minutes (int). Existing string `time` is unchanged.
 * Temp DB only. Does not start systemd or touch the live DB.
 * No pickSpeaker. No F9C–F9F apply/router/UI. No commit/deploy/restart.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openDb } from '../apps/server/src/db/index.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { renderScene } from '../apps/server/src/prompt/templates.ts';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { Scene } from '../apps/server/src/types.js';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

function cols(db: ReturnType<typeof openDb>, table: string) {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
    type: string;
  }>;
}

const SIX = ['place', 'time', 'goal', 'genre', 'conflict', 'mood'] as const;
const ADDITIVE = ['clock_minutes', 'weather', 'location', 'stage', 'arc', 'flags'] as const;
const CONV_COLS = [
  'id',
  'character_id',
  'persona_id',
  'title',
  'mode',
  'profile_name',
  'scene_json',
  'head_message_id',
  'prompt_version',
  'favorite',
  'archived',
  'created_at',
  'updated_at',
  'last_message_at',
  'user_note',
  'persona_name_snapshot',
  'persona_address_snapshot',
  'persona_appearance_snapshot',
  'persona_personality_snapshot',
  'persona_relationship_snapshot',
  'persona_applied_at',
  'story_id',
  'story_applied_at',
  'story_name_snapshot',
  'story_setting_snapshot',
  'story_minor_cast_snapshot',
] as const;

const GOLDEN_SIX: Scene = { place: '취선객잔', time: '밤' };
const GOLDEN_RENDER =
  '### 현재 장면 (정본. 없는 항목을 창작하지 말 것)\n장소: 취선객잔\n시간: 밤';

async function main() {
  const migPath = 'apps/server/migrations/0010_scene_state.sql';
  const migSql = fs.readFileSync(migPath, 'utf8');
  const compat = JSON.parse(fs.readFileSync('deploy/schema-compat.json', 'utf8')) as {
    required_migrations: string[];
  };
  const typesSrc = fs.readFileSync('apps/server/src/types.ts', 'utf8');
  const convSrc = fs.readFileSync('apps/server/src/routes/conversations.ts', 'utf8');
  const templatesSrc = fs.readFileSync('apps/server/src/prompt/templates.ts', 'utf8');
  const migDir = 'apps/server/migrations';

  await t('0010 is not empty and names clock_minutes (not time) as clock', () => {
    assert.ok(migSql.trim().length > 400, `len=${migSql.trim().length}`);
    assert.match(migSql, /clock_minutes/);
    assert.match(migSql, /기존 6/);
    assert.match(migSql, /SELECT 1/);
  });

  await t('0010 has no BEGIN/COMMIT, no worlds, no new table, no ALTER, no UPDATE', () => {
    assert.equal(/\bBEGIN\b/i.test(migSql), false);
    assert.equal(/\bCOMMIT\b/i.test(migSql), false);
    assert.equal(/\bworlds\b/i.test(migSql), false);
    assert.equal(/\bworld_id\b/i.test(migSql), false);
    assert.equal(/\bCREATE TABLE\b/i.test(migSql), false);
    assert.equal(/\bALTER TABLE\b/i.test(migSql), false);
    assert.equal(/\bUPDATE\b/i.test(migSql), false);
    assert.equal(/\bDROP\b/i.test(migSql), false);
    assert.equal(/\bpickSpeaker\b/.test(migSql), false);
  });

  await t('schema-compat required_migrations includes 0010_scene_state.sql', () => {
    assert.ok(compat.required_migrations.includes('0009_conversation_story.sql'));
    assert.ok(compat.required_migrations.includes('0010_scene_state.sql'));
  });

  await t('migrations dir has 0001–0010 only; no extra 0006/0009/0010 empties', () => {
    const files = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
    assert.ok(files.includes('0010_scene_state.sql'), JSON.stringify(files));
    assert.equal(files.filter((f) => f.startsWith('0006_')).length, 1);
    assert.equal(files.filter((f) => f.startsWith('0009_')).length, 1);
    assert.equal(files.filter((f) => f.startsWith('0010_')).length, 1);
    for (const f of files.filter((x) => /^(0006|0009|0010)_/.test(x))) {
      assert.ok(fs.statSync(path.join(migDir, f)).size > 0, f);
    }
  });

  await t('schema files do not import pickSpeaker', () => {
    assert.equal(fs.existsSync('apps/server/src/prompt/pickSpeaker.js'), false);
    assert.equal(/pickSpeaker/.test(typesSrc), false);
    assert.equal(/pickSpeaker/.test(migSql), false);
    assert.equal(/pickSpeaker/.test(convSrc), false);
    assert.equal(fs.existsSync('apps/server/src/prompt/assignSpeakers.js'), false);
    assert.equal(/assignSpeakers/.test(typesSrc), false);
    assert.equal(/assignSpeakers/.test(migSql), false);
    assert.equal(/assignSpeakers/.test(convSrc), false);
  });

  const sceneStart = typesSrc.indexOf('export interface Scene {');
  assert.ok(sceneStart >= 0, 'Scene missing');
  const sceneEnd = typesSrc.indexOf('\n}', sceneStart);
  const sceneBlock = typesSrc.slice(sceneStart, sceneEnd);

  for (const field of SIX) {
    await t(`Scene.${field} remains optional string`, () => {
      const re = new RegExp(`^\\s*${field}\\?:\\s*string;\\s*$`, 'm');
      assert.match(sceneBlock, re);
    });
  }

  await t('Scene.clock_minutes is optional number', () => {
    assert.match(sceneBlock, /^\s*clock_minutes\?:\s*number;\s*$/m);
  });

  for (const field of ['weather', 'location', 'stage', 'arc'] as const) {
    await t(`Scene.${field} is optional string`, () => {
      const re = new RegExp(`^\\s*${field}\\?:\\s*string;\\s*$`, 'm');
      assert.match(sceneBlock, re);
    });
  }

  await t('Scene.flags is optional array of {key, owner_stage?}', () => {
    assert.match(sceneBlock, /^\s*flags\?:\s*Array<\{ key: string; owner_stage\?: string \}>;\s*$/m);
  });

  await t('sceneSchema keeps time as string and adds clock_minutes int', () => {
    const start = convSrc.indexOf('const sceneSchema = z.object({');
    assert.ok(start >= 0);
    const end = convSrc.indexOf('});', start);
    const block = convSrc.slice(start, end);
    assert.match(block, /time:\s*z\.string\(\)\.max\(300\)\.optional\(\)/);
    assert.match(block, /clock_minutes:\s*z\.number\(\)\.int\(\)\.min\(0\)\.optional\(\)/);
    assert.match(block, /weather:\s*z\.string\(\)\.max\(200\)\.optional\(\)/);
    assert.match(block, /location:\s*z\.string\(\)\.max\(100\)\.optional\(\)/);
    assert.match(block, /stage:\s*z\.string\(\)\.max\(100\)\.optional\(\)/);
    assert.match(block, /arc:\s*z\.string\(\)\.max\(100\)\.optional\(\)/);
    assert.match(block, /flags:\s*z\.array\(/);
    assert.match(block, /owner_stage:/);
    assert.equal(/relationship:/.test(block), false);
  });

  await t('renderScene still only reads the six string fields', () => {
    assert.match(templatesSrc, /field\('시간', s\.time\)/);
    assert.equal(/clock_minutes/.test(templatesSrc), false);
    assert.equal(/s\.weather/.test(templatesSrc), false);
  });

  await t('renderScene 6-field golden is unchanged', () => {
    assert.equal(renderScene(GOLDEN_SIX), GOLDEN_RENDER);
  });

  await t('renderScene ignores additive keys (1:1 byte identity)', () => {
    const extra: Scene = {
      ...GOLDEN_SIX,
      clock_minutes: 90,
      weather: 'rain',
      location: 'bureau_lobby_01',
      stage: 'registration',
      arc: 'entry',
      flags: [{ key: 'power_scan_pending', owner_stage: 'registration' }],
    };
    assert.equal(renderScene(extra), GOLDEN_RENDER);
    assert.equal(renderScene({ ...GOLDEN_SIX, clock_minutes: 0 }), GOLDEN_RENDER);
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-scene-state-schema-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));

  await t('openDb records 0010; conversations columns unchanged (26)', () => {
    const names = (
      db.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as Array<{ name: string }>
    ).map((r) => r.name);
    assert.ok(names.includes('0010_scene_state.sql'), JSON.stringify(names));
    const info = cols(db, 'conversations');
    assert.deepEqual(info.map((c) => c.name), [...CONV_COLS]);
    assert.equal(info.find((c) => c.name === 'character_id')?.notnull, 1);
    assert.equal(info.find((c) => c.name === 'scene_json')?.type.toUpperCase(), 'TEXT');
  });

  await t('no scene_clock / extra tables from 0010', () => {
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    assert.equal(tables.includes('scene_clock'), false);
    assert.equal(tables.includes('scene_state_schema'), false);
  });

  db.prepare(
    `INSERT INTO characters (id, name, tagline, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, tags_json, created_at, updated_at)
     VALUES ('c1','메인A','','','','','','','','','[]','t0','t0')`,
  ).run();

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
  await app.register(conversationRoutes(ctx));

  async function postScene(scene: unknown, title: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { 'content-type': 'application/json' },
      payload: { characterId: 'c1', title, scene },
    });
    return res;
  }

  await t('POST 6-field scene roundtrips; no additive keys invented', async () => {
    const res = await postScene({ place: '취선객잔', time: '밤' }, '육필드');
    assert.equal(res.statusCode, 201, res.body);
    const id = res.json().id as string;
    const row = db.prepare('SELECT scene_json FROM conversations WHERE id = ?').get(id) as {
      scene_json: string;
    };
    const parsed = JSON.parse(row.scene_json) as Record<string, unknown>;
    assert.deepEqual(parsed, { place: '취선객잔', time: '밤' });
    for (const k of ADDITIVE) assert.equal(k in parsed, false, k);
  });

  await t('POST clock_minutes + flags persists; time string kept', async () => {
    const res = await postScene(
      {
        place: '취선객잔',
        time: '밤',
        clock_minutes: 90,
        weather: 'rain',
        location: 'bureau_lobby_01',
        stage: 'registration',
        arc: 'entry',
        flags: [{ key: 'power_scan_pending', owner_stage: 'registration' }],
      },
      '가산',
    );
    assert.equal(res.statusCode, 201, res.body);
    const id = res.json().id as string;
    const row = db.prepare('SELECT scene_json FROM conversations WHERE id = ?').get(id) as {
      scene_json: string;
    };
    const parsed = JSON.parse(row.scene_json) as Record<string, unknown>;
    assert.equal(parsed.time, '밤');
    assert.equal(parsed.clock_minutes, 90);
    assert.equal(parsed.weather, 'rain');
    assert.equal(parsed.location, 'bureau_lobby_01');
    assert.equal(parsed.stage, 'registration');
    assert.equal(parsed.arc, 'entry');
    assert.deepEqual(parsed.flags, [{ key: 'power_scan_pending', owner_stage: 'registration' }]);
  });

  await t('PATCH merges clock_minutes without rewriting time', async () => {
    const created = await postScene({ place: '취선객잔', time: '밤', goal: '등록' }, '패치대상');
    const id = created.json().id as string;
    const before = (
      db.prepare('SELECT scene_json FROM conversations WHERE id = ?').get(id) as { scene_json: string }
    ).scene_json;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${id}`,
      headers: { 'content-type': 'application/json' },
      payload: {
        scene: {
          clock_minutes: 15,
          flags: [{ key: 'power_scan_pending', owner_stage: 'registration' }],
        },
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    const after = (
      db.prepare('SELECT scene_json FROM conversations WHERE id = ?').get(id) as { scene_json: string }
    ).scene_json;
    assert.notEqual(after, before);
    const parsed = JSON.parse(after) as Record<string, unknown>;
    assert.equal(parsed.place, '취선객잔');
    assert.equal(parsed.time, '밤');
    assert.equal(parsed.goal, '등록');
    assert.equal(parsed.clock_minutes, 15);
    assert.deepEqual(parsed.flags, [{ key: 'power_scan_pending', owner_stage: 'registration' }]);
  });

  await t('PATCH unknown scene key is stripped (default-deny)', async () => {
    const created = await postScene({ place: 'A', time: '낮' }, '스트립');
    const id = created.json().id as string;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${id}`,
      headers: { 'content-type': 'application/json' },
      payload: { scene: { clock_minutes: 1, relationship: 'auto', hp: 12 } },
    });
    assert.equal(res.statusCode, 200, res.body);
    const parsed = JSON.parse(
      (db.prepare('SELECT scene_json FROM conversations WHERE id = ?').get(id) as { scene_json: string })
        .scene_json,
    ) as Record<string, unknown>;
    assert.equal(parsed.clock_minutes, 1);
    assert.equal('relationship' in parsed, false);
    assert.equal('hp' in parsed, false);
    assert.equal(parsed.time, '낮');
  });

  await t('PATCH/POST reject time as number and clock_minutes as string', async () => {
    const badTime = await postScene({ time: 10 }, '나쁜시간');
    assert.equal(badTime.statusCode, 400, badTime.body);
    const badClock = await postScene({ clock_minutes: '90' }, '나쁜시계');
    assert.equal(badClock.statusCode, 400, badClock.body);
    const neg = await postScene({ clock_minutes: -1 }, '음수');
    assert.equal(neg.statusCode, 400, neg.body);
    const frac = await postScene({ clock_minutes: 1.5 }, '소수');
    assert.equal(frac.statusCode, 400, frac.body);
    const badFlag = await postScene({ flags: [{ owner_stage: 'registration' }] }, '키없음');
    assert.equal(badFlag.statusCode, 400, badFlag.body);
  });

  await t('sibling conversation scene_json bytes unchanged by other PATCH', async () => {
    const a = await postScene({ place: 'X', time: '새벽' }, '형제A');
    const b = await postScene({ place: 'Y', time: '저녁' }, '형제B');
    const idA = a.json().id as string;
    const idB = b.json().id as string;
    const beforeB = (
      db.prepare('SELECT scene_json FROM conversations WHERE id = ?').get(idB) as { scene_json: string }
    ).scene_json;
    await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${idA}`,
      headers: { 'content-type': 'application/json' },
      payload: { scene: { clock_minutes: 3 } },
    });
    const afterB = (
      db.prepare('SELECT scene_json FROM conversations WHERE id = ?').get(idB) as { scene_json: string }
    ).scene_json;
    assert.equal(afterB, beforeB);
    assert.equal(afterB, '{"place":"Y","time":"저녁"}');
  });

  await app.close();
  db.close();
  console.log(`passed ${passed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
