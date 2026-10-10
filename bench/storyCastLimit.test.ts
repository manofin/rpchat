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
import { parseOpening } from '../apps/server/src/prompt/storyOpening.ts';
import { dialogContextSchema } from '../apps/server/src/prompt/dialogActorContext.ts';
import { applyPresenceDelta } from '../apps/server/src/prompt/presence.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';
import { loadedStoryStart, storyFixture, character, one, button, text, tick } from './helpers/storyUiHarness.ts';

let passed = 0;
async function t(name: string, check: () => Promise<void> | void) {
  await check(); console.log(`ok ${++passed} ${name}`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-cast-limit-'));
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
      const r = await api('POST', '/api/characters', { name: `fixture ${i}` });
      assert.equal(r.status, 201); ids.push(r.body.id);
    }
    const story = await api('POST', '/api/stories', { name: 'cast limit fixture' });
    assert.equal(story.status, 201);
    const storyUrl = `/api/stories/${story.body.id}`;
    for (const [sortOrder, characterId] of ids.slice(0, 25).entries()) {
      assert.equal((await api('POST', storyUrl + '/characters', { characterId, sortOrder })).status, 201);
    }
    const create = (extra: object = {}) => api('POST', '/api/conversations', {
      characterId: ids[0], storyId: story.body.id, mode: 'story', ...extra,
    });
    for (const count of [17, 25]) await t(`${count} participants start and persist in order`, async () => {
      const r = await create({ participantIds: ids.slice(0, count) });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual(JSON.parse(r.body.story_participant_ids_snapshot), ids.slice(0, count));
    });
    await t('25-person fallback roster works without participantIds', async () => {
      const r = await create(); assert.equal(r.status, 201);
      assert.deepEqual(JSON.parse(r.body.story_participant_ids_snapshot), ids.slice(0, 25));
    });
    await t('26 participants rejected, including implicit host and fallback', async () => {
      const before = db.prepare('SELECT COUNT(*) AS n FROM conversations').get();
      assert.equal((await create({ participantIds: ids })).status, 400);
      assert.equal((await create({ characterId: ids[25], participantIds: ids.slice(0, 25) })).status, 400);
      assert.equal((await create({ characterId: ids[25] })).status, 400);
      assert.equal((await api('POST', storyUrl + '/characters', { characterId: ids[25], sortOrder: 25 })).status, 201);
      assert.equal((await create()).status, 400);
      assert.equal((await api('DELETE', storyUrl + `/characters/${ids[25]}`)).status, 200);
      assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM conversations').get(), before);
    });
    await t('opening keeps only selected scene characters within the 25-person cast', async () => {
      assert.equal((await api('PUT', storyUrl, { name: story.body.name, opening: { present_ids: ids.slice(0, 2) } })).status, 200);
      const r = await create(); assert.equal(r.status, 201);
      assert.deepEqual(JSON.parse(r.body.scene_json).present_ids, ids.slice(0, 2));
      assert.equal(JSON.parse(r.body.story_participant_ids_snapshot).length, 25);
    });
    await t('25 opening characters survive save, parse, start and scene patch; 26 rejected', async () => {
      const opening = { present_ids: ids.slice(0, 25) };
      assert.equal((await api('PUT', storyUrl, { name: story.body.name, opening })).status, 200);
      assert.deepEqual(parseOpening(JSON.stringify(opening)).present_ids, opening.present_ids);
      const r = await create(); assert.equal(r.status, 201);
      assert.deepEqual(JSON.parse(r.body.scene_json).present_ids, opening.present_ids);
      assert.equal((await api('PUT', storyUrl, { name: story.body.name, openings_extra: [{ id: 'full', label: 'full', opening_json: JSON.stringify(opening) }] })).status, 200);
      const extraRoom = await create({ openingId: 'full' }); assert.equal(extraRoom.status, 201);
      assert.deepEqual(JSON.parse(extraRoom.body.scene_json).present_ids, opening.present_ids);
      assert.equal((await api('PATCH', `/api/conversations/${r.body.id}`, { scene: opening })).status, 200);
      assert.equal((await api('PATCH', `/api/conversations/${r.body.id}`, { scene: { present_ids: ids } })).status, 400);
      assert.equal((await api('PUT', storyUrl, { name: story.body.name, opening: { present_ids: ids } })).status, 400);
      assert.equal((await api('PUT', storyUrl, { name: story.body.name, openings_extra: [{ id: 'large', label: 'large', opening_json: JSON.stringify({ present_ids: ids }) }] })).status, 400);
    });
    await t('knowledge can be shared with 25 participants; 26 rejected', () => {
      const entry = { memory_id: 'm', anchor_message_id: 'a', kind: 'fact', status: 'active', known_by: ids.slice(0, 25) };
      assert.equal(dialogContextSchema.safeParse({ version: 1, entries: [entry] }).success, true);
      assert.equal(dialogContextSchema.safeParse({ version: 1, entries: [{ ...entry, known_by: ids }] }).success, false);
    });
    await t('presence changes retain all 25 participants and cap additions', () => {
      assert.deepEqual(applyPresenceDelta(ids.slice(0, 25), {}), ids.slice(0, 25));
      assert.deepEqual(applyPresenceDelta(ids.slice(0, 24), { present_ids_add: ids.slice(24) }), ids.slice(0, 25));
    });
    for (const count of [17, 25, 26]) await t(`start sheet ${count}-person boundary`, async () => {
      const characters = ids.slice(0, count).map((id) => character(id));
      const fixture = storyFixture({ characters: ids.slice(0, count).map((character_id, sort_order) => ({
        story_id: 'story/fixture', character_id, sort_order, name: character_id, role: 'main',
      })) });
      const requests: any[] = [];
      const h = await loadedStoryStart({ story: fixture, characters, post: async (_url, body) => { requests.push(body); return { id: 'room' }; } });
      try {
        if (count <= 25) {
          const start = one(h.render(), button('시작')); assert.equal(start.props.disabled, false);
          start.props.onClick(); await tick(); assert.deepEqual(requests[0].participantIds, ids.slice(0, count));
        } else {
          assert.match(text(h.render()), /최대 25명/); assert.equal(requests.length, 0);
          assert.equal(h.requests.some((url) => url.includes('inject-preview')), false);
        }
      } finally { h.cleanup(); }
    });
  } finally { await app.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`PASS=${passed}`);
}
main().catch((error) => { console.error(error); process.exit(1); });
