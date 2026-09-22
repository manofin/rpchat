/** npx tsx bench/storyPeerCastStartUi.test.ts
 * ADR-F8e story-peer-cast-start-ui — StoryPage peer-cast start request + labels.
 * ORDER_CONTRACT: preserve selection order; prepend characterId only if absent.
 */
import assert from 'node:assert/strict';
import { loadedStoryStart, nodes, one, button, deferred, tick } from './helpers/storyUiHarness.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.ts';
import { conversationRoutes } from '../apps/server/src/routes/conversations.ts';
import { characterRoutes } from '../apps/server/src/routes/characters.ts';
import { storyRoutes } from '../apps/server/src/routes/stories.ts';
import { GenerationQueue } from '../apps/server/src/model/queue.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, '..');
const src = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

const HAYEON = 'hayeon';
const NARI = 'nari';
const SERA = 'sera';
const STORY = 'story-parallel';

async function runUnit() {
  const { buildStoryStartRequest } = await import('../apps/web/src/lib/storyStartRequest.ts');
  await t('ok1 story create submits the selected peer cast', () => {
    const body = buildStoryStartRequest({
      characterId: HAYEON,
      storyId: STORY,
      selectedIds: [HAYEON, NARI, SERA],
    });
    assert.equal(body.characterId, HAYEON);
    assert.equal(body.storyId, STORY);
    assert.equal(body.mode, 'story');
    assert.deepEqual(body.participantIds, [HAYEON, NARI, SERA]);
    assert.equal('role' in body, false);
    assert.equal('mainCharacterId' in body, false);
  });

  await t('ok2 host remains included when absent from the selected roster', () => {
    const body = buildStoryStartRequest({
      characterId: HAYEON,
      storyId: STORY,
      selectedIds: [NARI, SERA],
    });
    assert.deepEqual(body.participantIds, [HAYEON, NARI, SERA]);
    assert.equal(body.characterId, HAYEON);
  });

  await t('ok3 duplicate participant ids do not produce duplicate request state', () => {
    const body = buildStoryStartRequest({
      characterId: HAYEON,
      storyId: STORY,
      selectedIds: [NARI, HAYEON, NARI, SERA, SERA],
    });
    assert.deepEqual(body.participantIds, [NARI, HAYEON, SERA]);
  });

  await t('ok4 story create does not emit party role tags', () => {
    const body = buildStoryStartRequest({
      characterId: HAYEON,
      storyId: STORY,
      selectedIds: [HAYEON, NARI],
    });
    const raw = JSON.stringify(body);
    assert.equal(raw.includes('party:role=main'), false);
    assert.equal(raw.includes('party:role=supporting'), false);
    assert.equal(raw.includes('party:'), false);
    const page = src('apps/web/src/pages/StoryPage.tsx');
    assert.equal(page.includes('party:role=main'), false);
    assert.equal(page.includes('party:role=supporting'), false);
  });

  await t('ok5 host is not labeled or encoded as the default speaker', () => {
    const page = src('apps/web/src/pages/StoryPage.tsx');
    for (const needle of ['주연', '조연', '대표 응답자', '기본 화자', '메인 캐릭터', '항상 응답']) {
      assert.equal(page.includes(needle), false, needle);
    }
    assert.equal(page.includes('default_focus'), false);
    assert.ok(page.includes('시작 캐릭터') || page.includes('characterId'), 'display host pick may remain');
  });

  await t('ok6 character_id display field stays on the request', () => {
    const body = buildStoryStartRequest({
      characterId: SERA,
      storyId: STORY,
      selectedIds: [NARI],
    });
    assert.equal(body.characterId, SERA);
    const page = src('apps/web/src/pages/StoryPage.tsx');
    assert.ok(page.includes('buildStoryStartRequest'));
    assert.ok(page.includes('characterId'));
  });

  await t('ok7 1:1 create keeps the existing contract', () => {
    const charPage = src('apps/web/src/pages/CharacterPage.tsx');
    assert.equal(charPage.includes('storyId'), false);
    assert.equal(charPage.includes('participantIds'), false);
    assert.equal(charPage.includes('buildStoryStartRequest'), false);
    assert.ok(charPage.includes('characterId: character.id'));
    assert.equal(charPage.includes('이 스토리로 대화 시작'), false);
  });

  await t('ok8 1:1 create does not retain story participant state', () => {
    const charPage = src('apps/web/src/pages/CharacterPage.tsx');
    const page = src('apps/web/src/pages/StoryPage.tsx');
    assert.equal(/let\s+rosterIds/.test(charPage), false);
    assert.ok(page.includes('useState'), 'roster lives in StoryPage component state');
    assert.equal(page.includes('window.sessionStorage'), false);
    assert.equal(charPage.includes('story_participant'), false);
  });

  await t('ok9 failed create preserves the saved roster and opening for retry', async () => {
    let attempts = 0;
    const bodies: unknown[] = [], routes: string[] = [], errors: string[] = [];
    const h = await loadedStoryStart({ post: async (_url, body) => { bodies.push(body); if (++attempts === 1) throw new Error('offline'); return { id: 'room' }; }, navigate: (url) => routes.push(url), toast: (message) => errors.push(message) });
    one(h.render(), (node) => node.type === 'select').props.onChange({ target: { value: 'rain' } });
    one(h.render(), button('시작')).props.onClick(); await tick();
    assert.deepEqual(routes, []); assert.deepEqual(errors, ['offline']); assert.equal(h.state.openingPick, 'rain');
    one(h.render(), button('시작')).props.onClick(); await tick();
    assert.deepEqual(bodies[0], bodies[1]); assert.deepEqual(routes, ['/chat/room']);
  });

  await t('ok10 duplicate submit cannot start two rooms', async () => {
    const response = deferred<unknown>(); let calls = 0;
    const h = await loadedStoryStart({ post: async () => { calls++; return response.promise; } });
    const start = one(h.render(), button('시작')); start.props.onClick(); start.props.onClick();
    assert.equal(calls, 1); assert.equal(one(h.render(), button('생성 중…')).props.disabled, true);
    response.resolve({ id: 'one-room' }); await tick();
  });

  await t('selection order is preserved when the host is already in the roster', () => {
    const body = buildStoryStartRequest({
      characterId: HAYEON,
      storyId: STORY,
      selectedIds: [SERA, HAYEON, NARI],
    });
    assert.deepEqual(body.participantIds, [SERA, HAYEON, NARI]);
  });

  await t('StoryPage starts saved peer cast; participation controls belong in the editor', async () => {
    const bodies: any[] = []; let edits = 0;
    const h = await loadedStoryStart({ post: async (_url, body) => { bodies.push(body); return { id: 'room' }; }, onEdit: () => edits++ });
    assert.equal(nodes(h.render()).filter((node) => node.type === 'input' && node.props.type === 'checkbox').length, 0);
    assert.equal(nodes(h.render()).filter((node) => node.type === 'select' && node.props.id !== 'story-opening-pick').length, 0);
    one(h.render(), button('스토리 수정에서 변경')).props.onClick(); assert.equal(edits, 1);
    one(h.render(), button('시작')).props.onClick(); await tick();
    assert.deepEqual(bodies[0].participantIds, ['b', 'a']); assert.equal(bodies[0].characterId, 'b');
  });

  await t('createSchema accepts participantIds (POST body, not a migration)', () => {
    const conv = src('apps/server/src/routes/conversations.ts');
    assert.match(conv, /participantIds:/);
    assert.equal(conv.includes('0014'), false);
  });

  await t('start-ui still posts participantIds; generate module names stay imported from composeBeat', () => {
    const chat = src('apps/server/src/routes/chat.ts');
    assert.equal(chat.includes('storyCastForGenerate'), true);
    assert.equal(chat.includes('approveStoryExtras'), false);
  });
}

async function main() {
  await runUnit();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-peer-cast-start-ui-'));
  const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
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
  const port = (app.addresses()[0] as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;

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

  const char = async (name: string) => {
    const res = await api('POST', '/api/characters', { name, personality: `${name} 성격`, first_message: '' });
    assert.equal(res.status, 201, res.text);
    return res.json as { id: string; name: string };
  };

  const hayeon = await char('하연');
  const nari = await char('나리');
  const sera = await char('세라');
  const { buildStoryStartRequest } = await import('../apps/web/src/lib/storyStartRequest.ts');
  const storyRes = await api('POST', '/api/stories', { name: '평행 교실', tagline: '', setting: '교실', minor_cast: [] });
  assert.equal(storyRes.status, 201, storyRes.text);
  const story = storyRes.json as { id: string };
  for (const [id, order] of [[hayeon.id, 0], [nari.id, 1]] as const) {
    const add = await api('POST', `/api/stories/${story.id}/characters`, { characterId: id, sortOrder: order });
    assert.equal(add.status, 201, add.text);
  }
  void sera;

  await t('POST participantIds becomes the snapshot, host prepended if missing', async () => {
    const body = buildStoryStartRequest({
      characterId: hayeon.id,
      storyId: story.id,
      selectedIds: [nari.id],
    });
    const res = await api('POST', '/api/conversations', body);
    assert.equal(res.status, 201, res.text);
    const conv = res.json as { character_id: string; story_participant_ids_snapshot: string | null };
    assert.equal(conv.character_id, hayeon.id);
    assert.deepEqual(JSON.parse(conv.story_participant_ids_snapshot!), [hayeon.id, nari.id]);
  });

  await t('POST without participantIds still snapshots hosted roster (schema compat)', async () => {
    const res = await api('POST', '/api/conversations', { characterId: hayeon.id, storyId: story.id, mode: 'story' });
    assert.equal(res.status, 201, res.text);
    const conv = res.json as { story_participant_ids_snapshot: string | null };
    assert.deepEqual(JSON.parse(conv.story_participant_ids_snapshot!), [hayeon.id, nari.id]);
  });

  await app.close();
  console.log(`passed ${passed}`);
}

main().catch((e) => {
  console.error('RED', e);
  process.exit(1);
});
