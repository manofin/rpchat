/** npx tsx bench/storyOpeningsExtra.test.ts
 * ADR-F8f Slice 1 (story-multi-opening-schema): stories.openings_extra_json (0019),
 * PUT omit=preserve, POST openingId → F8d opening_json raw snapshot copy.
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
  await t('0019 adds openings_extra_json default [] on stories only; no BEGIN', () => {
    const sql = fs.readFileSync('apps/server/migrations/0019_story_openings_extra.sql', 'utf8');
    assert.match(sql, /ALTER TABLE stories ADD COLUMN openings_extra_json TEXT NOT NULL DEFAULT '\[\]'/);
    assert.equal(/\bBEGIN\b/i.test(sql), false);
    assert.equal(/ALTER TABLE conversations/i.test(sql), false);
    assert.equal(/CREATE TABLE/i.test(sql), false);
    assert.equal(/CREATE TABLE\s+story_openings/i.test(sql), false);
    assert.equal(sql.includes('default_character_id'), false);
  });

  await t('resolveOpening source stays snapshot-only (no extras column)', () => {
    const src = fs.readFileSync('apps/server/src/prompt/storyOpening.ts', 'utf8');
    assert.equal(src.includes('openings_extra'), false);
    assert.equal(/from ['"]\.\.\/db/.test(src), false);
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-story-openings-extra-'));
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

  await t('openDb records 0019; default []; conversations column count unchanged for extras', () => {
    const names = (db.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    assert.ok(names.includes('0019_story_openings_extra.sql'), JSON.stringify(names));
    const storyCol = cols(db, 'stories').find((c) => c.name === 'openings_extra_json');
    assert.ok(storyCol);
    assert.equal(storyCol!.notnull, 1);
    assert.equal(String(storyCol!.dflt_value).replace(/'/g, ''), '[]');
    assert.equal(cols(db, 'conversations').some((c) => c.name === 'openings_extra_json'), false);
    assert.equal(cols(db, 'conversations').find((c) => c.name === 'character_id')?.notnull, 1);
    assert.equal(cols(db, 'conversations').find((c) => c.name === 'story_opening_snapshot')?.notnull, 0);
  });

  const hayeon = (await api('POST', '/api/characters', { name: '하연', personality: '반장', first_message: '카드인사 {{char}}' })).json as {
    id: string;
  };
  const nari = (await api('POST', '/api/characters', { name: '나리', personality: '친구', first_message: '나리인사' })).json as {
    id: string;
  };

  const created = await api('POST', '/api/stories', {
    name: '교실',
    setting: '학교',
    scene_catalog: {
      places: [{ id: '교실', name: '1-3' }, { id: '도서관' }, { id: '복도' }],
      weathers: ['맑음', '흐림'],
      arcs: ['entry'],
      stagesByArc: { entry: ['reg'] },
    },
  });
  assert.equal(created.status, 201, created.text);
  const story = created.json as { id: string; openings_extra?: unknown };
  assert.deepEqual(story.openings_extra, []);

  const storedEmpty = db.prepare('SELECT openings_extra_json FROM stories WHERE id = ?').get(story.id) as {
    openings_extra_json: string;
  };
  assert.equal(storedEmpty.openings_extra_json, '[]');

  await api('POST', `/api/stories/${story.id}/characters`, { characterId: hayeon.id, sortOrder: 0 });
  await api('POST', `/api/stories/${story.id}/characters`, { characterId: nari.id, sortOrder: 1 });

  const defaultOpening = {
    scenario: '기본 시나리오',
    greeting: '기본 {{char}} 인사',
    scene: { place_id: '복도', weather: '흐림' },
    present_ids: [] as string[],
  };
  const putDefault = await api('PUT', `/api/stories/${story.id}`, {
    name: '교실',
    tagline: '',
    setting: '학교',
    minor_cast: [],
    opening: defaultOpening,
  });
  assert.equal(putDefault.status, 200, putDefault.text);

  // Distinct from storedOpening() output: space-after-colon so a re-serialize would fail equality.
  const extraOpeningRaw =
    '{"scenario": "도서관 시작","greeting": "도서관에서 {{char}}","scene": {"place_id": "도서관"},"present_ids": []}';

  await t('PUT openings_extra stores opening_json as given raw string; GET round-trips', async () => {
    const put = await api('PUT', `/api/stories/${story.id}`, {
      name: '교실',
      tagline: '',
      setting: '학교',
      minor_cast: [],
      openings_extra: [{ id: 'lib', label: '도서관에서', opening_json: extraOpeningRaw }],
    });
    assert.equal(put.status, 200, put.text);
    const body = put.json as { openings_extra: Array<{ id: string; label: string; opening_json: string }> };
    assert.equal(body.openings_extra.length, 1);
    assert.equal(body.openings_extra[0].id, 'lib');
    assert.equal(body.openings_extra[0].label, '도서관에서');
    assert.equal(body.openings_extra[0].opening_json, extraOpeningRaw);
    const row = db.prepare('SELECT openings_extra_json FROM stories WHERE id = ?').get(story.id) as {
      openings_extra_json: string;
    };
    const parsed = JSON.parse(row.openings_extra_json) as Array<{ opening_json: string }>;
    assert.equal(parsed[0].opening_json, extraOpeningRaw);
  });

  await t('PUT omit openings_extra preserves stored extras', async () => {
    const before = (db.prepare('SELECT openings_extra_json FROM stories WHERE id = ?').get(story.id) as {
      openings_extra_json: string;
    }).openings_extra_json;
    const omitted = await api('PUT', `/api/stories/${story.id}`, {
      name: '교실',
      tagline: '',
      setting: '학교-수정',
      minor_cast: [],
    });
    assert.equal(omitted.status, 200, omitted.text);
    const after = (db.prepare('SELECT openings_extra_json FROM stories WHERE id = ?').get(story.id) as {
      openings_extra_json: string;
    }).openings_extra_json;
    assert.equal(after, before);
  });

  await t('PUT extras 8th / duplicate id / blank label / damaged opening_json / unhosted present_id → 400', async () => {
    const base = { name: '교실', tagline: '', setting: '학교', minor_cast: [] as unknown[] };
    const one = { id: 'a', label: '하나', opening_json: extraOpeningRaw };
    const eight = Array.from({ length: 8 }, (_, i) => ({ ...one, id: `e${i}` }));
    assert.equal((await api('PUT', `/api/stories/${story.id}`, { ...base, openings_extra: eight })).status, 400);

    assert.equal(
      (
        await api('PUT', `/api/stories/${story.id}`, {
          ...base,
          openings_extra: [
            { id: 'dup', label: 'A', opening_json: extraOpeningRaw },
            { id: 'dup', label: 'B', opening_json: extraOpeningRaw },
          ],
        })
      ).status,
      400,
    );

    assert.equal(
      (
        await api('PUT', `/api/stories/${story.id}`, {
          ...base,
          openings_extra: [{ id: 'x', label: '   ', opening_json: extraOpeningRaw }],
        })
      ).status,
      400,
    );

    assert.equal(
      (
        await api('PUT', `/api/stories/${story.id}`, {
          ...base,
          openings_extra: [{ id: 'x', label: '깨짐', opening_json: '{not-json' }],
        })
      ).status,
      400,
    );

    assert.equal(
      (
        await api('PUT', `/api/stories/${story.id}`, {
          ...base,
          openings_extra: [{ id: 'x', label: '배열', opening_json: '[]' }],
        })
      ).status,
      400,
    );

    assert.equal(
      (
        await api('PUT', `/api/stories/${story.id}`, {
          ...base,
          openings_extra: [
            {
              id: 'x',
              label: '외부',
              opening_json: JSON.stringify({ scenario: '', greeting: '', scene: {}, present_ids: ['not-hosted'] }),
            },
          ],
        })
      ).status,
      400,
    );
  });

  await t('POST omit openingId copies stories.opening_json raw (single-opening path)', async () => {
    const raw = (db.prepare('SELECT opening_json FROM stories WHERE id = ?').get(story.id) as { opening_json: string })
      .opening_json;
    const res = await api('POST', '/api/conversations', {
      characterId: hayeon.id,
      storyId: story.id,
      mode: 'story',
    });
    assert.equal(res.status, 201, res.text);
    const conv = res.json as { story_opening_snapshot: string };
    assert.equal(conv.story_opening_snapshot, raw);
  });

  await t('POST valid openingId copies extra.opening_json raw; wrapper is not the snapshot', async () => {
    const extraRow = JSON.parse(
      (db.prepare('SELECT openings_extra_json FROM stories WHERE id = ?').get(story.id) as { openings_extra_json: string })
        .openings_extra_json,
    ) as Array<{ id: string; label: string; opening_json: string }>;
    const extra = extraRow.find((e) => e.id === 'lib');
    assert.ok(extra);
    const res = await api('POST', '/api/conversations', {
      characterId: hayeon.id,
      storyId: story.id,
      openingId: 'lib',
      mode: 'story',
    });
    assert.equal(res.status, 201, res.text);
    const conv = res.json as { story_opening_snapshot: string; scene_json: string };
    assert.equal(conv.story_opening_snapshot, extraOpeningRaw);
    assert.equal(conv.story_opening_snapshot, extra!.opening_json);
    assert.notEqual(conv.story_opening_snapshot, JSON.stringify(extra));
    const scene = JSON.parse(conv.scene_json) as { location?: string };
    assert.equal(scene.location, '도서관');
    const detail = await api('GET', `/api/conversations/${(res.json as { id: string }).id}`);
    const msgs = (detail.json as { messages: Array<{ role: string; content: string }> }).messages;
    const greet = msgs.find((m) => m.role === 'assistant');
    assert.ok(greet);
    assert.equal(greet!.content.includes('도서관에서 하연'), true);
  });

  await t('POST unknown openingId falls back to default opening_json; not 400', async () => {
    const raw = (db.prepare('SELECT opening_json FROM stories WHERE id = ?').get(story.id) as { opening_json: string })
      .opening_json;
    const res = await api('POST', '/api/conversations', {
      characterId: hayeon.id,
      storyId: story.id,
      openingId: 'deleted-or-typo',
      mode: 'story',
    });
    assert.equal(res.status, 201, res.text);
    const conv = res.json as { story_opening_snapshot: string };
    assert.equal(conv.story_opening_snapshot, raw);
  });

  await t('1:1 ignores openingId; snapshot stays null; greeting is character first_message', async () => {
    const res = await api('POST', '/api/conversations', {
      characterId: hayeon.id,
      openingId: 'lib',
      mode: 'chat',
    });
    assert.equal(res.status, 201, res.text);
    const conv = res.json as { story_id: string | null; story_opening_snapshot: string | null };
    assert.equal(conv.story_id, null);
    assert.equal(conv.story_opening_snapshot, null);
    const detail = await api('GET', `/api/conversations/${(res.json as { id: string }).id}`);
    const msgs = (detail.json as { messages: Array<{ role: string; content: string }> }).messages;
    assert.ok(msgs.some((m) => m.content.includes('카드인사')));
  });

  await t('PUT explicit [] clears extras', async () => {
    const cleared = await api('PUT', `/api/stories/${story.id}`, {
      name: '교실',
      tagline: '',
      setting: '학교',
      minor_cast: [],
      openings_extra: [],
    });
    assert.equal(cleared.status, 200, cleared.text);
    const row = db.prepare('SELECT openings_extra_json FROM stories WHERE id = ?').get(story.id) as {
      openings_extra_json: string;
    };
    assert.equal(row.openings_extra_json, '[]');
    const body = cleared.json as { openings_extra: unknown };
    assert.deepEqual(body.openings_extra, []);
  });

  await app.close();
  console.log(`\n${passed} passed`);
}

main().catch((e) => {
  console.error('RED', e);
  process.exit(1);
});
