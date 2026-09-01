/** npx tsx bench/storyArchivedGate.test.ts
 * F8c story-archived-gate — POST /api/conversations rejects archived storyId server-side.
 * Temp DB only, real migrations. Helper/bench PASS is not a product PASS.
 * Does not start systemd or touch the live DB. No UI. No builder.ts/computeStoryInjection changes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openDb } from '../apps/server/src/db/index.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { PROMPT_VERSION } from '../apps/server/src/config.js';
import type { Ctx } from '../apps/server/src/ctx.js';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

function count(db: ReturnType<typeof openDb>, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-story-archived-gate-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));

  db.exec(`
    INSERT INTO characters (id, name, tagline, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, tags_json, created_at, updated_at)
    VALUES
      ('c1','메인A','','설명','성격','말투','','','','','[]','t0','t0'),
      ('c2','미참여B','','설명','성격','말투','','','','','[]','t0','t0');
  `);
  db.prepare(
    `INSERT INTO personas (id, name, address_as, appearance, personality, relationship, is_default, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run('p1', '유저', '호칭', '외형', '페르소나성격', '관계', 1, 't0', 't0');
  db.prepare(
    `INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes) VALUES (?,?,?,?,?,?,?,?)`,
  ).run('rp-balanced', null, 0.8, 0.95, 400, '[]', 'system', null);

  const SETTING = '눈 덮인 왕국. {{char}}는 북쪽 관문을 지킨다.';
  db.prepare(
    `INSERT INTO stories (id, name, tagline, setting, minor_cast, archived, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
  ).run('s1-active', '설원왕국', '', SETTING, '[]', 0, 't0', 't0');
  db.prepare(
    `INSERT INTO stories (id, name, tagline, setting, minor_cast, archived, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
  ).run('s2-archived', '보관된왕국', '', '보관된 설정', '[]', 1, 't0', 't0');
  db.prepare(`INSERT INTO story_characters (story_id, character_id, role, sort_order) VALUES (?,?,?,?)`).run('s1-active', 'c1', 'main', 0);

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
  await app.register(storyRoutes(ctx));
  await app.register(conversationRoutes(ctx));

  await t('active story → 201, snapshot populated (regression: normal path unaffected)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { 'content-type': 'application/json' },
      payload: { characterId: 'c1', storyId: 's1-active', mode: 'story' },
    });
    assert.equal(res.statusCode, 201, res.body);
    const conv = res.json();
    assert.equal(conv.story_id, 's1-active');
    assert.ok(conv.story_applied_at);
    assert.equal(conv.story_setting_snapshot, SETTING);
    (globalThis as { activeConvId?: string }).activeConvId = conv.id;
  });

  await t('archived story → 409 {error:"archived"}; zero writes to conversations/messages/stories', async () => {
    const before = {
      conversations: count(db, 'conversations'),
      messages: count(db, 'messages'),
      stories: db.prepare('SELECT updated_at, archived FROM stories WHERE id = ?').get('s2-archived'),
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { 'content-type': 'application/json' },
      payload: { characterId: 'c1', storyId: 's2-archived', mode: 'story' },
    });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().error, 'archived');
    assert.equal(count(db, 'conversations'), before.conversations, 'no conversation row inserted');
    assert.equal(count(db, 'messages'), before.messages, 'no message row inserted (no greeting side effect)');
    assert.deepEqual(
      db.prepare('SELECT updated_at, archived FROM stories WHERE id = ?').get('s2-archived'),
      before.stories,
      'archived story row itself untouched',
    );
  });

  await t('unknown storyId → existing 404 "story not found" contract unchanged', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { 'content-type': 'application/json' },
      payload: { characterId: 'c1', storyId: 'ghost-story', mode: 'story' },
    });
    assert.equal(res.statusCode, 404, res.body);
    assert.equal(res.json().error, 'story not found');
  });

  await t('no storyId (plain character conversation) → unaffected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { 'content-type': 'application/json' },
      payload: { characterId: 'c1', mode: 'chat' },
    });
    assert.equal(res.statusCode, 201, res.body);
    const conv = res.json();
    assert.equal(conv.story_id, null);
    assert.equal(conv.story_applied_at, null);
  });

  await t('unknown characterId → existing 404 "character not found" contract unchanged', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { 'content-type': 'application/json' },
      payload: { characterId: 'ghost-char', storyId: 's1-active', mode: 'story' },
    });
    assert.equal(res.statusCode, 404, res.body);
    assert.equal(res.json().error, 'character not found');
  });

  await t('character not hosted by story → existing (no) contract unchanged: still succeeds (no mapping check added)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { 'content-type': 'application/json' },
      payload: { characterId: 'c2', storyId: 's1-active', mode: 'story' },
    });
    assert.equal(res.statusCode, 201, res.body, 'this slice must not add a hosted-character check');
  });

  await t('existing conversation + frozen snapshot unaffected when its story is archived afterward', async () => {
    const convId = (globalThis as { activeConvId?: string }).activeConvId!;
    db.prepare(`UPDATE stories SET archived = 1, updated_at = 't-later' WHERE id = 's1-active'`).run();

    const getRes = await app.inject({ method: 'GET', url: `/api/conversations/${convId}` });
    assert.equal(getRes.statusCode, 200, getRes.body);
    assert.equal(getRes.json().conversation.story_setting_snapshot, SETTING, 'frozen snapshot unchanged');

    const previewRes = await app.inject({ method: 'GET', url: `/api/conversations/${convId}/prompt-preview` });
    assert.equal(previewRes.statusCode, 200, previewRes.body);
    const systemText = String(previewRes.json().messages.find((m: { role: string }) => m.role === 'system')?.content ?? '');
    assert.ok(systemText.includes('눈 덮인 왕국'), 'build still injects the frozen snapshot after live archive');

    const detailRes = await app.inject({ method: 'GET', url: '/api/stories/s1-active' });
    assert.equal(detailRes.statusCode, 200, detailRes.body, 'archived story detail view still viewable (unchanged)');

    db.prepare(`UPDATE stories SET archived = 0, updated_at = 't0' WHERE id = 's1-active'`).run();
  });

  await t('unarchive → immediately startable again (check reads live archived flag, not cached)', async () => {
    db.prepare(`UPDATE stories SET archived = 0 WHERE id = 's2-archived'`).run();
    const res = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { 'content-type': 'application/json' },
      payload: { characterId: 'c1', storyId: 's2-archived', mode: 'story' },
    });
    assert.equal(res.statusCode, 201, res.body);
  });

  await t('PROMPT_VERSION unchanged; builder.ts / computeStoryInjection untouched', () => {
    const conversationsSrc = fs.readFileSync('apps/server/src/routes/conversations.ts', 'utf8');
    const builderSrc = fs.readFileSync('apps/server/src/prompt/builder.ts', 'utf8');
    assert.match(conversationsSrc, /if \(story\.archived\) return reply\.code\(409\)/);
    assert.doesNotMatch(conversationsSrc, /computeStoryInjection/);
    assert.match(builderSrc, /export function computeStoryInjection/);
    assert.match(builderSrc, /STORY_SETTING_SHARE\s*=\s*0\.7/);
    assert.equal(PROMPT_VERSION, '2026.08.22-r1+story');
  });

  console.log(`passed ${passed}`);
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
