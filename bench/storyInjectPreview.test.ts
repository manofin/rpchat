/** npx tsx bench/storyInjectPreview.test.ts
 * F8c story-inject-preview — pre-start pre-flight endpoint. Temp DB only, real migrations.
 * Helper/bench PASS is not a product PASS (helper-vs-live-contract).
 * Does not start systemd or touch the live DB. No UI. No POST /api/conversations archived-gate
 * (separate slice `story-archived-gate`).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openDb } from '../apps/server/src/db/index.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import type { Ctx } from '../apps/server/src/ctx.js';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-story-inject-preview-'));
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
  const CAST = [
    { name: '행상인', note: '정보를 판다' },
    { name: '경비', note: '문을 지킨다' },
  ];
  db.prepare(
    `INSERT INTO stories (id, name, tagline, setting, minor_cast, archived, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
  ).run('s1', '설원왕국', '', SETTING, JSON.stringify(CAST), 0, 't0', 't0');
  db.prepare(
    `INSERT INTO stories (id, name, tagline, setting, minor_cast, archived, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
  ).run('s2-archived', '보관된왕국', '', '보관된 설정', '[]', 1, 't0', 't0');
  db.prepare(
    `INSERT INTO stories (id, name, tagline, setting, minor_cast, archived, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
  ).run('s3-empty', '빈스토리', '', '', '[]', 0, 't0', 't0');
  db.prepare(
    `INSERT INTO stories (id, name, tagline, setting, minor_cast, archived, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
  ).run('s4-damaged', '손상스토리', '', SETTING, '{not-json', 0, 't0', 't0');

  db.prepare(`INSERT INTO story_characters (story_id, character_id, role, sort_order) VALUES (?,?,?,?)`).run('s1', 'c1', 'main', 0);
  db.prepare(`INSERT INTO story_characters (story_id, character_id, role, sort_order) VALUES (?,?,?,?)`).run('s2-archived', 'c1', 'main', 0);
  db.prepare(`INSERT INTO story_characters (story_id, character_id, role, sort_order) VALUES (?,?,?,?)`).run('s3-empty', 'c1', 'main', 0);
  db.prepare(`INSERT INTO story_characters (story_id, character_id, role, sort_order) VALUES (?,?,?,?)`).run('s4-damaged', 'c1', 'main', 0);

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

  await t('archived story → 409', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stories/s2-archived/inject-preview?characterId=c1' });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().error, 'archived');
  });

  await t('unknown storyId → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stories/nope/inject-preview?characterId=c1' });
    assert.equal(res.statusCode, 404, res.body);
  });

  await t('missing characterId → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stories/s1/inject-preview' });
    assert.equal(res.statusCode, 400, res.body);
  });

  await t('characterId not hosted by story → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stories/s1/inject-preview?characterId=c2' });
    assert.equal(res.statusCode, 404, res.body);
    assert.equal(res.json().error, 'character not hosted by story');
  });

  await t('unknown characterId → 404 (not hosted, checked before character lookup)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stories/s1/inject-preview?characterId=ghost' });
    assert.equal(res.statusCode, 404, res.body);
  });

  await t('valid hosted character → 200; setting excerpt substituted; cast all included; willFreeze', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stories/s1/inject-preview?characterId=c1' });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.ok(body.settingExcerpt.includes('눈 덮인 왕국'));
    assert.ok(body.settingExcerpt.includes('메인A는 북쪽 관문을 지킨다'), body.settingExcerpt);
    assert.equal(body.settingExcerpt.includes('{{char}}'), false);
    assert.equal(body.settingTruncated, false);
    assert.deepEqual(body.cast, [
      { name: '행상인', included: true },
      { name: '경비', included: true },
    ]);
    assert.ok(body.estTokens > 0);
    assert.ok(body.storyRoom > 0);
    assert.equal(body.willFreeze, true);
    assert.equal('story_name_snapshot' in body, false);
    assert.equal(body.settingExcerpt.includes('설원왕국'), false); // name not injected (ADR-F8b §4)
  });

  await t('empty setting + empty cast → 200 empty result, no crash', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stories/s3-empty/inject-preview?characterId=c1' });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.settingExcerpt, '');
    assert.equal(body.settingTruncated, false);
    assert.deepEqual(body.cast, []);
    assert.equal(body.estTokens, 0);
    assert.equal(body.willFreeze, true);
  });

  await t('damaged minor_cast JSON → empty cast, setting still shown, no crash', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stories/s4-damaged/inject-preview?characterId=c1' });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.ok(body.settingExcerpt.includes('눈 덮인 왕국'));
    assert.deepEqual(body.cast, []);
  });

  await t('huge setting → settingTruncated true; excerpt keeps head, drops tail', async () => {
    const head = '[[STORY_HEAD]]';
    const tail = '[[STORY_TAIL]]';
    const huge = `${head}${'가'.repeat(8000)}${tail}`;
    db.prepare(`UPDATE stories SET setting = ? WHERE id = 's1'`).run(huge);
    const res = await app.inject({ method: 'GET', url: '/api/stories/s1/inject-preview?characterId=c1' });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.ok(body.settingExcerpt.includes(head));
    assert.equal(body.settingExcerpt.includes(tail), false);
    assert.equal(body.settingTruncated, true);
    db.prepare(`UPDATE stories SET setting = ? WHERE id = 's1'`).run(SETTING);
  });

  await t('minor_cast prefix whole-or-drop → later huge-note items excluded, order preserved', async () => {
    // 기본 CONTEXT_TOKENS(32768)에서 storyRoom이 storyInjectBuild.test.ts의 8192 컨텍스트보다 훨씬 크므로,
    // 어떤 realistic 예산에서도 확실히 넘치도록 8000자보다 훨씬 큰 노트를 쓴다(의도: 드롭 자체의 존재를
    // 검증하는 것이지 특정 바이트 임계값을 검증하는 게 아님).
    const hugeNote = '나'.repeat(200000);
    const cast = [
      { name: '행상인', note: '정보를 판다' },
      { name: '드롭1', note: hugeNote },
      { name: '드롭2', note: hugeNote },
    ];
    db.prepare(`UPDATE stories SET minor_cast = ? WHERE id = 's1'`).run(JSON.stringify(cast));
    const res = await app.inject({ method: 'GET', url: '/api/stories/s1/inject-preview?characterId=c1' });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.deepEqual(body.cast, [
      { name: '행상인', included: true },
      { name: '드롭1', included: false },
      { name: '드롭2', included: false },
    ]);
    db.prepare(`UPDATE stories SET minor_cast = ? WHERE id = 's1'`).run(JSON.stringify(CAST));
  });

  // ---- 충실성: 이 미리보기가 실제 대화 시작 직후의 build 결과와 일치하는지 직접 대조 ----
  await t('FIDELITY: preview output matches the real conversation this exact input would produce', async () => {
    const previewRes = await app.inject({ method: 'GET', url: '/api/stories/s1/inject-preview?characterId=c1' });
    assert.equal(previewRes.statusCode, 200, previewRes.body);
    const preview = previewRes.json();

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { 'content-type': 'application/json' },
      payload: { characterId: 'c1', storyId: 's1', mode: 'story' },
    });
    assert.equal(createRes.statusCode, 201, createRes.body);
    const conv = createRes.json();

    const realRes = await app.inject({ method: 'GET', url: `/api/conversations/${conv.id}/prompt-preview` });
    assert.equal(realRes.statusCode, 200, realRes.body);
    const real = realRes.json();
    const storySection = real.budget.sections.find((s: { name: string }) => s.name === '스토리 설정');
    assert.ok(storySection, 'real build must have a 스토리 설정 section');

    assert.equal(storySection.est_tokens, preview.estTokens, 'estTokens must match real build exactly');
    assert.equal(storySection.budget, preview.storyRoom, 'storyRoom must match real fixed-budget remainder exactly');
    assert.equal(!!storySection.note?.includes('절단'), preview.settingTruncated, 'truncation flag must match');

    const systemText = String(real.messages.find((m: { role: string }) => m.role === 'system')?.content ?? '');
    assert.ok(systemText.includes(preview.settingExcerpt), 'preview excerpt must appear verbatim in the real system prompt');
    for (const c of preview.cast) {
      assert.equal(systemText.includes(`- ${c.name}:`), c.included, `cast inclusion for ${c.name} must match real build`);
    }
  });

  console.log(`passed ${passed}`);
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
