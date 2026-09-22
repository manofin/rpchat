/** Story conversation selection: real routes and migrations, isolated DB, no model or live access. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.ts';
import { conversationRoutes } from '../apps/server/src/routes/conversations.ts';
import { GenerationQueue } from '../apps/server/src/model/queue.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  console.log(`ok ${++passed} ${name}`);
}

type ListedRoom = {
  id: string; character_id: string; character_name: string; story_id: string | null;
  preview: string; favorite: boolean; archived: boolean; scene: Record<string, unknown>;
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-story-list-'));
  const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
  const ctx = {
    db, model: {} as Ctx['model'], queue: new GenerationQueue(1),
    log: { error() {}, info() {}, warn() {}, debug() {} } as unknown as Ctx['log'],
    resolvedModel: () => 'test-model', setResolvedModel() {},
    health: async () => ({ ok: true, checkedAt: 't', latencyMs: 0, models: ['test-model'] }),
  } as Ctx;
  const app = Fastify({ logger: false });
  await app.register(conversationRoutes(ctx));
  try {
    const special = "story ' OR 1=1 -- & 한글";
    const specialChar = "character ' OR 1=1 -- & 한글";
    const stamp = (year: number, second: number) => new Date(Date.UTC(year, 0, 1) + second * 1000).toISOString();
    const char = db.prepare('INSERT INTO characters (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)');
    for (const [id, name] of [['c-main', '서윤'], ['c-other', '이든'], [specialChar, '특수 문자 이름']]) {
      char.run(id, name, stamp(2020, 0), stamp(2020, 0));
    }
    const story = db.prepare('INSERT INTO stories (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)');
    for (const id of ['s-target', 's-other', special]) story.run(id, id, stamp(2020, 0), stamp(2020, 0));
    const room = db.prepare(`INSERT INTO conversations
      (id, character_id, story_id, title, prompt_version, created_at, updated_at, last_message_at, archived, favorite, scene_json)
      VALUES (?, ?, ?, ?, 'test', ?, ?, ?, ?, ?, ?)`);
    const add = (id: string, storyId: string | null, characterId: string, created: string, last: string | null = created, archived = 0) => {
      room.run(id, characterId, storyId, id, created, created, last, archived, id === 'target-204' ? 1 : 0, id === 'target-204' ? '{"place":"서점"}' : '{}');
    };
    db.transaction(() => {
      for (let i = 0; i < 205; i++) {
        add(`target-${String(i).padStart(3, '0')}`, 's-target', i % 2 ? 'c-other' : 'c-main', stamp(2021, i));
        add(`noise-${String(i).padStart(3, '0')}`, 's-other', 'c-other', stamp(2025, i));
      }
      add('storyless', null, 'c-main', stamp(2026, 0));
      add('archived', 's-target', 'c-main', stamp(2027, 0), stamp(2027, 0), 1);
      add('tie-a', 's-target', 'c-main', stamp(2021, 500));
      add('tie-b', 's-target', 'c-main', stamp(2021, 500));
      add('null-old', 's-target', 'c-other', stamp(2028, 0), null);
      add('null-new', 's-target', 'c-main', stamp(2029, 0), null);
      add('special-room', special, specialChar, stamp(2023, 0));
      db.prepare(`INSERT INTO messages (id, conversation_id, role, content, created_at)
        VALUES ('preview-message', 'target-204', 'user', '창가에 자리가 있나요?', ?)`).run(stamp(2021, 204));
      db.prepare("UPDATE conversations SET head_message_id = 'preview-message' WHERE id = 'target-204'").run();
    })();

    const list = async (query: Record<string, string> = {}) => {
      const res = await app.inject({ method: 'GET', url: `/api/conversations?${new URLSearchParams(query)}` });
      assert.equal(res.statusCode, 200, res.body);
      return res.json<ListedRoom[]>();
    };
    const ids = (rows: ListedRoom[]) => rows.map((r) => r.id);
    const targets = Array.from({ length: 205 }, (_, i) => `target-${String(204 - i).padStart(3, '0')}`);
    const expected = ['tie-b', 'tie-a', ...targets, 'null-new', 'null-old'];
    const before = db.prepare('SELECT * FROM conversations ORDER BY id').all();
    const messagesBefore = db.prepare('SELECT * FROM messages ORDER BY id').all();

    await t('story filter runs before the limit despite 205 newer unrelated conversations', async () => {
      const got = await list({ storyId: 's-target', limit: '200' });
      assert.equal(got.length, 200);
      assert.ok(got.every((r) => r.story_id === 's-target'), 'storyId must filter before LIMIT');
      assert.equal(got.some((r) => r.id === 'target-204'), true, 'old target conversations must not be hidden by newer other stories');
      assert.equal(got.some((r) => ['archived', 'storyless'].includes(r.id)), false);
    });

    await t('story pages preserve recency, created-time order, null-last and deterministic ties', async () => {
      const first = await list({ storyId: 's-target', limit: '200' });
      const second = await list({ storyId: 's-target', limit: '200', offset: '200' });
      assert.deepEqual(ids([...first, ...second]), expected);
      assert.equal(new Set(ids([...first, ...second])).size, expected.length);
      assert.deepEqual(await list({ storyId: 's-target', offset: String(expected.length) }), []);
      assert.deepEqual(ids(await list({ storyId: 's-target', limit: '1', offset: '1' })), ['tie-a']);
    });

    await t('character and story filters intersect before pagination', async () => {
      const expectedMain = expected.filter((id) => id.startsWith('tie-') || id === 'null-new' || (id.startsWith('target-') && Number(id.slice(7)) % 2 === 0));
      const got = await list({ storyId: 's-target', characterId: 'c-main', limit: '200' });
      assert.deepEqual(ids(got), expectedMain);
      assert.ok(got.every((r) => r.character_id === 'c-main' && r.story_id === 's-target'));
      assert.deepEqual(ids(await list({ storyId: 's-target', characterId: 'c-main', limit: '2', offset: '2' })), expectedMain.slice(2, 4));
      assert.deepEqual(await list({ storyId: 's-other', characterId: 'c-main' }), []);
    });

    await t('story and character IDs are literal bound values, including quotes and query punctuation', async () => {
      assert.deepEqual(ids(await list({ storyId: special })), ['special-room']);
      assert.deepEqual(ids(await list({ storyId: special, characterId: specialChar })), ['special-room']);
      assert.deepEqual(await list({ storyId: "' OR 1=1 --" }), []);
      assert.deepEqual(await list({ storyId: 's-target', characterId: "' OR 1=1 --" }), []);
      assert.deepEqual(await list({ storyId: 'missing' }), []);
    });

    await t('default and character-only lists retain their previous filtering, limits and output', async () => {
      const global = await list();
      assert.deepEqual(ids(global), ['storyless', ...Array.from({ length: 49 }, (_, i) => `noise-${String(204 - i).padStart(3, '0')}`)]);
      const characterOnly = await list({ characterId: 'c-other', limit: '200' });
      assert.deepEqual(ids(characterOnly), Array.from({ length: 200 }, (_, i) => `noise-${String(204 - i).padStart(3, '0')}`));
      assert.deepEqual(ids(await list({ characterId: 'c-main', limit: '1' })), ['storyless']);
      assert.deepEqual(ids(await list({ limit: '2', offset: '1' })), ['noise-204', 'noise-203']);
      assert.equal((await list({ limit: '999' })).length, 200);
    });

    await t('rows retain readable preview, character name and serialized scene/boolean shape', async () => {
      const got = (await list({ storyId: 's-target' })).find((r) => r.id === 'target-204');
      assert.ok(got);
      assert.equal(got.character_name, '서윤');
      assert.equal(got.preview, '창가에 자리가 있나요?');
      assert.equal(got.favorite, true);
      assert.equal(got.archived, false);
      assert.deepEqual(got.scene, { place: '서점' });
    });

    await t('invalid offsets safely behave as zero instead of producing SQL errors', async () => {
      const first = await list({ storyId: 's-target', limit: '2' });
      for (const offset of ['-1', '1.5', 'NaN', 'Infinity', '9007199254740992', "' OR 1=1 --"]) {
        assert.deepEqual(await list({ storyId: 's-target', limit: '2', offset }), first, offset);
      }
      assert.equal((await list({ storyId: 's-target', offset: '9007199254740991' })).length, 0);
    });

    await t('all list requests leave persisted conversations and messages unchanged', () => {
      assert.deepEqual(db.prepare('SELECT * FROM conversations ORDER BY id').all(), before);
      assert.deepEqual(db.prepare('SELECT * FROM messages ORDER BY id').all(), messagesBefore);
    });
  } finally {
    await app.close();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`passed ${passed}`);
}

main().catch((error) => { console.error('RED', error); process.exitCode = 1; });
