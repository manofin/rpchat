/** npx tsx bench/storyEndings.test.ts
 * ADR-F8g Slice 1 (story-endings-slice1-schema): stories.endings_json (0020),
 * PUT omit=preserve, POST story_endings_snapshot raw copy, 1:1 isolation.
 * Isolated: temp DB, no systemd, no live DB, no model call, no UI.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openDb } from '../apps/server/src/db/index.ts';
import { GenerationQueue } from '../apps/server/src/model/queue.ts';
import { characterRoutes } from '../apps/server/src/routes/characters.ts';
import { conversationRoutes } from '../apps/server/src/routes/conversations.ts';
import { storyRoutes } from '../apps/server/src/routes/stories.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';

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
    dflt_value: unknown;
  }>;
}

async function main() {
  await t('0020 adds endings_json + snapshot/ended columns; no table; no BEGIN', () => {
    const sql = fs.readFileSync('apps/server/migrations/0020_story_endings.sql', 'utf8');
    assert.match(sql, /ALTER TABLE stories ADD COLUMN endings_json TEXT NOT NULL DEFAULT '\[\]'/);
    assert.match(sql, /ALTER TABLE conversations ADD COLUMN story_endings_snapshot TEXT/);
    assert.match(sql, /ALTER TABLE conversations ADD COLUMN ended_at TEXT/);
    assert.match(sql, /ALTER TABLE conversations ADD COLUMN reached_ending_id TEXT/);
    assert.equal(/\bBEGIN\b/i.test(sql), false);
    assert.equal(/CREATE TABLE\s+story_endings/i.test(sql), false);
  });

  await t('pipeline sources stay ending-free', () => {
    for (const rel of [
      'apps/server/src/prompt/storyOpening.ts',
      'apps/server/src/prompt/composeBeat.ts',
      'apps/server/src/routes/chat.ts',
      'apps/server/src/prompt/resolveFocus.ts',
    ]) {
      const src = fs.readFileSync(rel, 'utf8');
      assert.equal(src.includes('endings_json'), false, rel);
      assert.equal(src.includes('reached_ending_id'), false, rel);
    }
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-story-endings-'));
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
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json, text };
  }

  await t('openDb records 0020; endings_json default []; end columns nullable', () => {
    const names = (db.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    assert.ok(names.includes('0020_story_endings.sql'), JSON.stringify(names));
    const endingsCol = cols(db, 'stories').find((c) => c.name === 'endings_json');
    assert.ok(endingsCol);
    assert.equal(endingsCol!.notnull, 1);
    assert.equal(String(endingsCol!.dflt_value).replace(/'/g, ''), '[]');
    for (const col of ['story_endings_snapshot', 'ended_at', 'reached_ending_id']) {
      assert.equal(cols(db, 'conversations').find((c) => c.name === col)?.notnull, 0, col);
    }
    assert.equal(cols(db, 'conversations').find((c) => c.name === 'character_id')?.notnull, 1);
  });

  const hayeon = (await api('POST', '/api/characters', { name: '하연', personality: '반장', first_message: '카드인사 {{char}}' })).json as {
    id: string;
  };

  const created = await api('POST', '/api/stories', {
    name: '교실',
    setting: '학교',
    scene_catalog: {
      places: [{ id: '교실', name: '1-3' }],
      weathers: ['맑음'],
      arcs: ['entry'],
      stagesByArc: { entry: ['reg'] },
    },
  });
  assert.equal(created.status, 201, created.text);
  const story = created.json as { id: string; endings?: unknown };
  assert.deepEqual(story.endings, []);

  const storedEmpty = db.prepare('SELECT endings_json FROM stories WHERE id = ?').get(story.id) as {
    endings_json: string;
  };
  assert.equal(storedEmpty.endings_json, '[]');

  const ending = { id: 'true', title: '졸업', description: '함께 졸업한다', badge_label: 'TRUE' };

  await t('PUT endings stores rows as given; GET round-trips', async () => {
    const put = await api('PUT', `/api/stories/${story.id}`, {
      name: '교실',
      tagline: '',
      setting: '학교',
      minor_cast: [],
      endings: [ending],
    });
    assert.equal(put.status, 200, put.text);
    const body = put.json as { endings: Array<typeof ending> };
    assert.equal(body.endings.length, 1);
    assert.deepEqual(body.endings[0], ending);
    const row = db.prepare('SELECT endings_json FROM stories WHERE id = ?').get(story.id) as {
      endings_json: string;
    };
    assert.deepEqual(JSON.parse(row.endings_json), [ending]);
  });

  await t('PUT omit endings preserves stored rows', async () => {
    const before = (db.prepare('SELECT endings_json FROM stories WHERE id = ?').get(story.id) as {
      endings_json: string;
    }).endings_json;
    const omitted = await api('PUT', `/api/stories/${story.id}`, {
      name: '교실',
      tagline: '',
      setting: '학교-수정',
      minor_cast: [],
    });
    assert.equal(omitted.status, 200, omitted.text);
    const after = (db.prepare('SELECT endings_json FROM stories WHERE id = ?').get(story.id) as {
      endings_json: string;
    }).endings_json;
    assert.equal(after, before);
  });

  await t('PUT endings 8th / duplicate id / blank title → 400', async () => {
    const base = { name: '교실', tagline: '', setting: '학교', minor_cast: [] as unknown[] };
    const one = { id: 'a', title: '하나', description: '', badge_label: '' };
    const eight = Array.from({ length: 8 }, (_, i) => ({ ...one, id: `e${i}` }));
    assert.equal((await api('PUT', `/api/stories/${story.id}`, { ...base, endings: eight })).status, 400);
    assert.equal(
      (await api('PUT', `/api/stories/${story.id}`, { ...base, endings: [{ ...one, id: 'dup' }, { ...one, id: 'dup' }] })).status,
      400,
    );
    assert.equal(
      (await api('PUT', `/api/stories/${story.id}`, { ...base, endings: [{ ...one, id: 'x', title: '   ' }] })).status,
      400,
    );
  });

  await t('POST story room copies endings_json raw; end columns start NULL', async () => {
    const stored = (db.prepare('SELECT endings_json FROM stories WHERE id = ?').get(story.id) as {
      endings_json: string;
    }).endings_json;
    const conv = await api('POST', '/api/conversations', {
      characterId: hayeon.id,
      storyId: story.id,
      mode: 'story',
    });
    assert.equal(conv.status, 201, conv.text);
    const body = conv.json as { id: string; story_endings_snapshot: string; ended_at: null; reached_ending_id: null };
    assert.equal(body.story_endings_snapshot, stored);
    assert.equal(body.ended_at, null);
    assert.equal(body.reached_ending_id, null);
    const row = db.prepare('SELECT story_endings_snapshot FROM conversations WHERE id = ?').get(body.id) as {
      story_endings_snapshot: string;
    };
    assert.equal(row.story_endings_snapshot, stored);
  });

  await t('story edit after create does not rewrite the room snapshot', async () => {
    const before = (db.prepare('SELECT story_endings_snapshot FROM conversations ORDER BY created_at LIMIT 1').get() as {
      story_endings_snapshot: string;
    }).story_endings_snapshot;
    const put = await api('PUT', `/api/stories/${story.id}`, {
      name: '교실',
      tagline: '',
      setting: '학교',
      minor_cast: [],
      endings: [{ id: 'bad', title: '자퇴', description: '', badge_label: 'BAD' }],
    });
    assert.equal(put.status, 200, put.text);
    const after = (db.prepare('SELECT story_endings_snapshot FROM conversations ORDER BY created_at LIMIT 1').get() as {
      story_endings_snapshot: string;
    }).story_endings_snapshot;
    assert.equal(after, before);
    assert.deepEqual(JSON.parse(after), [ending]);
  });

  await t('1:1 room stays ending-free (snapshot NULL, end columns NULL)', async () => {
    const conv = await api('POST', '/api/conversations', { characterId: hayeon.id, mode: 'chat' });
    assert.equal(conv.status, 201, conv.text);
    const body = conv.json as { story_endings_snapshot: null; ended_at: null; reached_ending_id: null };
    assert.equal(body.story_endings_snapshot, null);
    assert.equal(body.ended_at, null);
    assert.equal(body.reached_ending_id, null);
  });

  await app.close();
  console.log(`passed ${passed}`);
}

void main();
