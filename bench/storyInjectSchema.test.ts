/** npx tsx bench/storyInjectSchema.test.ts
 * F8b story-inject-schema — 0009 5-col + create INSERT snapshot + resolveStory.
 * Temp DB only. Helper/bench PASS is not a product PASS (helper-vs-live-contract).
 * Does not start systemd or touch the live DB. No renderStory. No buildPrompt inject.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Fastify from 'fastify';
import { openDb } from '../apps/server/src/db/index.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { ConversationRow } from '../apps/server/src/types.js';

const require2 = createRequire(import.meta.url);
let resolveStory: typeof import('../apps/server/src/prompt/resolveStory.js')['resolveStory'];
try {
  resolveStory = require2('../apps/server/src/prompt/resolveStory.ts').resolveStory;
} catch (e) {
  console.error('RED: resolveStory module missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

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

const STORY_COLS = [
  'story_id',
  'story_applied_at',
  'story_name_snapshot',
  'story_setting_snapshot',
  'story_minor_cast_snapshot',
] as const;

const BASE_CONV_COLS = [
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
] as const;

async function main() {
  const migPath = 'apps/server/migrations/0009_conversation_story.sql';
  const migSql = fs.readFileSync(migPath, 'utf8');
  const compat = JSON.parse(fs.readFileSync('deploy/schema-compat.json', 'utf8')) as {
    required_migrations: string[];
  };
  const typesSrc = fs.readFileSync('apps/server/src/types.ts', 'utf8');
  const convSrc = fs.readFileSync('apps/server/src/routes/conversations.ts', 'utf8');
  const builderSrc = fs.readFileSync('apps/server/src/prompt/builder.ts', 'utf8');

  await t('0009 has no BEGIN/COMMIT, no cover, no worlds/world_id', () => {
    assert.match(migSql, /ALTER TABLE conversations ADD COLUMN story_id/);
    assert.equal(/\bBEGIN\b/i.test(migSql), false);
    assert.equal(/\bCOMMIT\b/i.test(migSql), false);
    assert.equal(/\bcover\b/i.test(migSql), false);
    assert.equal(/\bworlds\b/i.test(migSql), false);
    assert.equal(/\bworld_id\b/i.test(migSql), false);
  });

  await t('0009 adds exactly the 5 ADR columns', () => {
    const adds = [...migSql.matchAll(/ADD COLUMN\s+(\w+)/g)].map((m) => m[1]);
    assert.deepEqual(adds, [...STORY_COLS]);
  });

  await t('0009 story_id FK stories(id) ON DELETE SET NULL', () => {
    assert.match(
      migSql,
      /story_id TEXT REFERENCES stories\(id\) ON DELETE SET NULL/,
    );
  });

  await t('schema-compat required_migrations includes 0009_conversation_story.sql', () => {
    assert.ok(compat.required_migrations.includes('0008_stories.sql'));
    assert.ok(compat.required_migrations.includes('0009_conversation_story.sql'));
  });

  const start = typesSrc.indexOf('export interface ConversationRow {');
  assert.ok(start >= 0, 'ConversationRow missing');
  const end = typesSrc.indexOf('\n}', start);
  const block = typesSrc.slice(start, end);

  for (const field of STORY_COLS) {
    await t(`ConversationRow.${field} is string | null`, () => {
      const re = new RegExp(`^\\s*${field}:\\s*string\\s*\\|\\s*null;\\s*$`, 'm');
      assert.match(block, re);
    });
  }

  await t('createSchema includes optional storyId', () => {
    assert.match(convSrc, /const createSchema = z\.object\({[\s\S]*?storyId:/);
  });

  await t('POST conversations uses one INSERT that lists all 5 story columns', () => {
    const post = convSrc.slice(convSrc.indexOf("app.post('/api/conversations'"));
    const next = post.search(/\n    app\.(get|patch|delete)/);
    const body = next >= 0 ? post.slice(0, next) : post;
    const insertCount = (body.match(/INSERT INTO conversations/g) || []).length;
    assert.equal(insertCount, 1, 'exactly one INSERT INTO conversations');
    assert.equal(/UPDATE conversations SET[\s\S]*story_/.test(body), false, 'no story_ UPDATE on create');
    for (const col of STORY_COLS) {
      assert.match(body, new RegExp(`INSERT INTO conversations[\\s\\S]*\\b${col}\\b`));
    }
  });

  await t('create path copies stories.minor_cast without JSON.stringify', () => {
    const post = convSrc.slice(convSrc.indexOf("app.post('/api/conversations'"));
    const next = post.search(/\n    app\.(get|patch|delete)/);
    const body = next >= 0 ? post.slice(0, next) : post;
    assert.match(body, /story_minor_cast_snapshot/);
    assert.equal(/JSON\.stringify\([^)]*minor_cast/.test(body), false);
  });

  await t('builder.ts does not query live stories table', () => {
    assert.equal(/\bFROM\s+stories\b/i.test(builderSrc), false);
    assert.equal(builderSrc.includes('story_characters'), false);
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-story-inject-schema-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));

  await t('openDb records 0009; conversations has base 21 + 5 story cols', () => {
    const names = (db.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    assert.ok(names.includes('0009_conversation_story.sql'), JSON.stringify(names));
    const info = cols(db, 'conversations');
    assert.deepEqual(
      info.map((c) => c.name),
      [...BASE_CONV_COLS, ...STORY_COLS],
    );
    assert.equal(info.find((c) => c.name === 'character_id')?.notnull, 1);
  });

  await t('PRAGMA foreign_key_list story_id → stories.id SET NULL', () => {
    const fk = db.prepare('PRAGMA foreign_key_list(conversations)').all() as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    const hit = fk.find((r) => r.from === 'story_id');
    assert.ok(hit, JSON.stringify(fk));
    assert.equal(hit!.table, 'stories');
    assert.equal(hit!.to, 'id');
    assert.equal(hit!.on_delete.toUpperCase(), 'SET NULL');
  });

  const rawCast = '[ { "name" : "행상인", "note" : "정보를 판다" } ]';
  db.prepare(
    `INSERT INTO characters (id, name, tagline, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, tags_json, created_at, updated_at)
     VALUES ('c1','메인A','','','','','','','','','[]','t0','t0')`,
  ).run();
  db.prepare(
    `INSERT INTO stories (id, name, tagline, setting, minor_cast, archived, created_at, updated_at)
     VALUES ('s1','설원','한줄','눈 덮인 왕국',?,0,'t0','t0')`,
  ).run(rawCast);

  await t('resolveStory: no story_applied_at → null even if story_id set', () => {
    const got = resolveStory({
      story_id: 's1',
      story_applied_at: null,
      story_name_snapshot: '설원',
      story_setting_snapshot: 'x',
      story_minor_cast_snapshot: '[]',
    } as ConversationRow);
    assert.equal(got, null);
  });

  await t('resolveStory: applied_at reads snapshots only (no DB)', () => {
    const got = resolveStory({
      story_id: 's1',
      story_applied_at: '2026-08-29T00:00:00.000Z',
      story_name_snapshot: '설원',
      story_setting_snapshot: '눈 덮인 왕국',
      story_minor_cast_snapshot: '[{"name":"행상인","note":"정보를 판다"}]',
    } as ConversationRow);
    assert.deepEqual(got, {
      name: '설원',
      setting: '눈 덮인 왕국',
      minorCast: [{ name: '행상인', note: '정보를 판다' }],
    });
  });

  await t('resolveStory: damaged JSON → [] + log', () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(String(args[0]));
    };
    try {
      const got = resolveStory({
        story_id: 's1',
        story_applied_at: 't',
        story_name_snapshot: 'n',
        story_setting_snapshot: 's',
        story_minor_cast_snapshot: '{not-json',
      } as ConversationRow);
      assert.deepEqual(got, { name: 'n', setting: 's', minorCast: [] });
      assert.ok(warns.some((w) => /story_minor_cast_snapshot|resolveStory/.test(w)), JSON.stringify(warns));
    } finally {
      console.warn = orig;
    }
  });

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

  await t('POST without storyId leaves all 5 story columns null', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { 'content-type': 'application/json' },
      payload: { characterId: 'c1', title: '무스토리' },
    });
    assert.equal(res.statusCode, 201, res.body);
    const id = res.json().id as string;
    const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Record<string, unknown>;
    for (const col of STORY_COLS) {
      assert.equal(row[col], null, col);
    }
  });

  await t('POST unknown storyId → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { 'content-type': 'application/json' },
      payload: { characterId: 'c1', storyId: 'no-such' },
    });
    assert.equal(res.statusCode, 404, res.body);
  });

  await t('POST storyId fills all 5 columns in the row; minor_cast is exact copy', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { 'content-type': 'application/json' },
      payload: { characterId: 'c1', storyId: 's1', title: '설원방' },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json();
    const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(body.id) as Record<string, unknown>;
    assert.equal(row.story_id, 's1');
    assert.equal(typeof row.story_applied_at, 'string');
    assert.ok(String(row.story_applied_at).length > 0);
    assert.equal(row.story_name_snapshot, '설원');
    assert.equal(row.story_setting_snapshot, '눈 덮인 왕국');
    assert.equal(row.story_minor_cast_snapshot, rawCast);
    assert.equal(body.story_id, 's1');
    assert.equal(body.story_name_snapshot, '설원');
  });

  await t('DELETE story SET NULL story_id; snapshots remain', () => {
    const id = (
      db.prepare(`SELECT id FROM conversations WHERE story_id = 's1'`).get() as { id: string }
    ).id;
    db.prepare('DELETE FROM stories WHERE id = ?').run('s1');
    const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Record<string, unknown>;
    assert.equal(row.story_id, null);
    assert.equal(row.story_name_snapshot, '설원');
    assert.equal(row.story_setting_snapshot, '눈 덮인 왕국');
    assert.equal(row.story_minor_cast_snapshot, rawCast);
    assert.ok(row.story_applied_at);
  });

  await app.close();
  db.close();
  console.log(`passed ${passed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
