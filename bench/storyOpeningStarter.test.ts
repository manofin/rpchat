/** npx tsx bench/storyOpeningStarter.test.ts
 * 코드-S1 opening-starter — the start sheet's startPick follows the SELECTED
 * opening: first present_ids entry that is currently hosted wins; empty /
 * archived-only / damaged opening_json falls back to hosted[0].
 * participantIds keeps the saved roster order (no re-prepend).
 *
 * Isolation: temp DB (mkdtemp) only, no live data; no model calls (stub Ctx).
 * Regression control: revert StoryPage to fixed hosted[0] and this bench fails.
 * Uses temp DATA_DIR (mkdtemp) and in-memory Fastify; no live model/DB/network.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.ts';
import { characterRoutes } from '../apps/server/src/routes/characters.ts';
import { storyRoutes } from '../apps/server/src/routes/stories.ts';
import { conversationRoutes } from '../apps/server/src/routes/conversations.ts';
import { GenerationQueue } from '../apps/server/src/model/queue.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';
import { buildStoryStartRequest, pickStoryStartCharacter, selectStoryOpening } from '../apps/web/src/lib/storyStartRequest.ts';
import { loadedStoryStart, storyFixture, character, previewFixture, one, button, text, tick } from './helpers/storyUiHarness.ts';

let passed = 0;
async function t(name: string, check: () => Promise<void> | void) {
  await check();
  console.log(`ok ${++passed} ${name}`);
}

const ids17 = Array.from({ length: 17 }, (_, i) => String(i + 1).padStart(2, '0'));
const cast17 = ids17.map((character_id, sort_order) => ({
  story_id: 'story/fixture', character_id, sort_order, name: `인물-${character_id}`, role: 'main',
}));

async function unit() {
  await t('pure pick: opening-first hosted entry wins even when the roster head is not in the opening', () => {
    const story = storyFixture({
      characters: cast17,
      opening: { scenario: 's', greeting: 'g', scene: {}, present_ids: [ids17[16], ids17[4]] },
    });
    assert.equal(pickStoryStartCharacter({ story, hostedIds: ids17 }), ids17[16]);
    story.opening!.present_ids.unshift('archived-or-unavailable');
    assert.equal(pickStoryStartCharacter({ story, hostedIds: ids17 }), ids17[16], 'skip unavailable entries before the first hosted person');
  });

  await t('pure pick: extra opening swaps the starter to ITS first hosted entry', () => {
    const story = storyFixture({
      characters: cast17,
      opening: { scenario: 's', greeting: 'g', scene: {}, present_ids: [ids17[16]] },
      openings_extra: [{ id: 'rain', label: '비 오는 밤', opening_json: JSON.stringify({ present_ids: [ids17[7], ids17[0]] }) }],
    });
    assert.equal(pickStoryStartCharacter({ story, hostedIds: ids17 }), ids17[16]);
    assert.equal(pickStoryStartCharacter({ story, hostedIds: ids17, openingId: 'rain' }), ids17[7]);
  });

  await t('pure pick fallbacks: empty present_ids / archived-only / damaged or missing opening_json → hosted[0]', () => {
    const story = storyFixture({
      characters: cast17,
      opening: { scenario: 's', greeting: 'g', scene: {}, present_ids: [] },
      openings_extra: [
        { id: 'broken', label: '깨진', opening_json: '{not json' },
        { id: 'archived', label: '보관된 인물만', opening_json: JSON.stringify({ present_ids: ['gone-1', 'gone-2'] }) },
      ],
    });
    assert.equal(pickStoryStartCharacter({ story, hostedIds: ids17 }), ids17[0]);
    assert.equal(pickStoryStartCharacter({ story, hostedIds: ids17, openingId: 'broken' }), ids17[0]);
    assert.equal(pickStoryStartCharacter({ story, hostedIds: ids17, openingId: 'archived' }), ids17[0]);
    assert.equal(pickStoryStartCharacter({ story, hostedIds: ids17, openingId: 'absent' }), ids17[0]);
    assert.equal(selectStoryOpening(story, 'broken'), null);
  });

  await t('start sheet: 17-person story whose first connection character is NOT in the opening starts with the opening-first person', async () => {
    const characters = ids17.map((id) => character(id));
    const fixture = storyFixture({
      characters: cast17,
      openings_extra: [],
      opening: { scenario: 's', greeting: 'g', scene: {}, present_ids: [ids17[16]] },
    });
    const requests: any[] = [];
    const h = await loadedStoryStart({ story: fixture, characters, post: async (_url, body) => { requests.push(body); return { id: 'room' }; } });
    try {
      const start = one(h.render(), button('시작'));
      assert.equal(start.props.disabled, false);
      start.props.onClick();
      await tick();
      assert.equal(requests.length, 1);
      assert.equal(requests[0].characterId, ids17[16], 'startPick = opening-first hosted person');
      assert.deepEqual(requests[0].participantIds, ids17, 'saved order stays 17-wide, no re-prepend');
    } finally { h.cleanup(); }
  });

  await t('start sheet: changing the opening selection changes startPick for inject-preview AND POST', async () => {
    const characters = ids17.map((id) => character(id));
    const fixture = storyFixture({
      characters: cast17,
      opening: { scenario: 's', greeting: 'g', scene: {}, present_ids: [ids17[16]] },
      openings_extra: [{ id: 'rain', label: '비 오는 밤', opening_json: JSON.stringify({ present_ids: [ids17[7]] }) }],
    });
    const previews: string[] = [];
    const posts: any[] = [];
    const h = await loadedStoryStart({
      story: fixture, characters,
      get: async (url) => {
        if (url === '/api/characters') return characters;
        if (url.includes('/inject-preview?')) {
          previews.push(new URL(url, 'http://x').searchParams.get('characterId') ?? '');
          return previewFixture;
        }
        if (url === `/api/stories/${fixture.id}`) return fixture;
        throw new Error(`unexpected fixture request: ${url}`);
      },
      post: async (_url, body) => { posts.push(body); return { id: 'room' }; },
    });
    try {
      assert.equal(previews[0], ids17[16], 'default opening drives the first preview');
      one(h.render(), (node) => node.type === 'select').props.onChange({ target: { value: 'rain' } });
      for (let i = 0; i < 3; i++) { h.render(); h.runEffects(); await tick(); }
      assert.equal(previews[1], ids17[7], 'preview re-fetch follows the new startPick');
      one(h.render(), button('시작')).props.onClick();
      await tick();
      assert.equal(posts[0].characterId, ids17[7]);
      assert.equal(posts[0].openingId, 'rain');
      assert.deepEqual(posts[0].participantIds, ids17);
    } finally { h.cleanup(); }
  });

  await t('start sheet: empty present_ids / archived-only opening / broken opening_json all fall back to hosted[0]', async () => {
    const cases: Array<{ label: string; story: ReturnType<typeof storyFixture>; opening?: string }> = [
      {
        label: 'empty present_ids',
        story: storyFixture({ characters: cast17, openings_extra: [], opening: { scenario: 's', greeting: 'g', scene: {}, present_ids: [] } }),
      },
      {
        label: 'archived-only present_ids',
        story: storyFixture({
          characters: [...cast17, { story_id: 'story/fixture', character_id: 'gone-1', sort_order: 90, name: '인물-gone-1', role: 'main' }],
          openings_extra: [{ id: 'gone', label: '보관된 인물만', opening_json: JSON.stringify({ present_ids: ['gone-1'] }) }],
        }),
        opening: 'gone',
      },
      {
        label: 'damaged opening_json',
        story: storyFixture({
          characters: cast17,
          openings_extra: [{ id: 'broken', label: '깨진', opening_json: '{not json' }],
        }),
        opening: 'broken',
      },
    ];
    for (const c of cases) {
      const characters = [...ids17.map((id) => character(id)), character('gone-1', true)];
      const requests: any[] = [];
      const h = await loadedStoryStart({ story: c.story, characters, post: async (_url, body) => { requests.push(body); return { id: 'room' }; } });
      try {
        if (c.opening) one(h.render(), (node) => node.type === 'select').props.onChange({ target: { value: c.opening } });
        for (let i = 0; i < 3; i++) { h.render(); h.runEffects(); await tick(); }
        const start = one(h.render(), button('시작'));
        assert.equal(start.props.disabled, false, c.label);
        start.props.onClick();
        await tick();
        assert.equal(requests[0].characterId, ids17[0], `${c.label} → hosted[0]`);
      } finally { h.cleanup(); }
    }
  });

  await t('start sheet: 26-person story is refused (no POST, cap notice)', async () => {
    const many = Array.from({ length: 26 }, (_, i) => String(100 + i));
    const characters = many.map((id) => character(id));
    const fixture = storyFixture({
      id: 'story/cast26',
      characters: many.map((character_id, sort_order) => ({ story_id: 'story/cast26', character_id, sort_order, name: `인물-${character_id}`, role: 'main' })),
    });
    const requests: any[] = [];
    const h = await loadedStoryStart({ story: fixture, characters, post: async (_url, body) => { requests.push(body); return { id: 'room' }; } });
    try {
      assert.match(text(h.render()), /최대 25명/);
      assert.equal(requests.length, 0);
      assert.equal(h.requests.some((url) => url.includes('inject-preview')), false);
    } finally { h.cleanup(); }
  });
}

async function server() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-opening-starter-'));
  const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
  const app = Fastify();
  const ctx = { db, model: {}, queue: new GenerationQueue(1), log: app.log,
    resolvedModel: () => 'test', setResolvedModel() {},
    health: async () => ({ ok: true, checkedAt: 'test', latencyMs: 0, models: ['test'] }),
  } as unknown as Ctx;
  await app.register(characterRoutes(ctx));
  await app.register(storyRoutes(ctx));
  await app.register(conversationRoutes(ctx));
  await app.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${app.addresses()[0].port}`;
  const api = async (method: string, url: string, body?: unknown) => {
    const r = await fetch(origin + url, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };
  try {
    const ids: string[] = [];
    for (let i = 0; i < 26; i++) {
      const r = await api('POST', '/api/characters', { name: `starter ${i}` });
      assert.equal(r.status, 201);
      ids.push(r.body.id);
    }
    const story = await api('POST', '/api/stories', { name: 'opening starter fixture' });
    assert.equal(story.status, 201);
    const storyUrl = `/api/stories/${story.body.id}`;
    for (const [sortOrder, characterId] of ids.slice(0, 17).entries()) {
      assert.equal((await api('POST', storyUrl + '/characters', { characterId, sortOrder })).status, 201);
    }

    await t('server: opening-first starter, saved-order snapshot stays 17, scene.present_ids is that one person', async () => {
      assert.equal((await api('PUT', storyUrl, { name: story.body.name, opening: { present_ids: [ids[16]] } })).status, 200);
      const authored = await api('GET', storyUrl);
      const hostedIds = ids.slice(0, 17);
      const characterId = pickStoryStartCharacter({ story: authored.body, hostedIds });
      const r = await api('POST', '/api/conversations', buildStoryStartRequest({ characterId, storyId: story.body.id, selectedIds: hostedIds }));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.character_id, ids[16]);
      assert.deepEqual(JSON.parse(r.body.story_participant_ids_snapshot), ids.slice(0, 17), 'storage order preserved, not re-prepended');
      assert.deepEqual(JSON.parse(r.body.scene_json).present_ids, [ids[16]], 'first scene = the one start character');
    });

    await t('server: extra opening id switches the starter and its scene to that opening', async () => {
      assert.equal((await api('PUT', storyUrl, { name: story.body.name, openings_extra: [{ id: 'rain', label: '비 오는 밤', opening_json: JSON.stringify({ present_ids: [ids[7]] }) }] })).status, 200);
      const authored = await api('GET', storyUrl);
      const hostedIds = ids.slice(0, 17);
      const characterId = pickStoryStartCharacter({ story: authored.body, hostedIds, openingId: 'rain' });
      const r = await api('POST', '/api/conversations', buildStoryStartRequest({ characterId, storyId: story.body.id, selectedIds: hostedIds, openingId: 'rain' }));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.character_id, ids[7]);
      assert.deepEqual(JSON.parse(r.body.story_participant_ids_snapshot), ids.slice(0, 17));
      assert.deepEqual(JSON.parse(r.body.scene_json).present_ids, [ids[7]]);
    });

    await t('server: 26 participants still rejected at the boundary', async () => {
      for (let sortOrder = 17; sortOrder < 25; sortOrder++) {
        assert.equal((await api('POST', storyUrl + '/characters', { characterId: ids[sortOrder], sortOrder })).status, 201);
      }
      const allowed = await api('POST', '/api/conversations', buildStoryStartRequest({ characterId: ids[16], storyId: story.body.id, selectedIds: ids.slice(0, 25) }));
      assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
      assert.deepEqual(JSON.parse(allowed.body.story_participant_ids_snapshot), ids.slice(0, 25));
      const before = db.prepare('SELECT COUNT(*) AS n FROM conversations').get();
      const body = buildStoryStartRequest({ characterId: ids[16], storyId: story.body.id, selectedIds: ids });
      assert.equal(body.participantIds.length, 26);
      const r = await api('POST', '/api/conversations', body);
      assert.equal(r.status, 400);
      assert.ok(r.body.error.fieldErrors.participantIds.length > 0, JSON.stringify(r.body));
      assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM conversations').get(), before);
    });
  } finally {
    await app.close();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  await unit();
  await server();
  console.log(`passed ${passed}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
