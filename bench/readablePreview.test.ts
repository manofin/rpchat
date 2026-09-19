/**
 * npx tsx bench/readablePreview.test.ts
 * LOCK-FINLEY-SNIPPET-20260919 — list preview walks parent_id to a readable row.
 * Temp DB + light Fastify. LIVE_NO_TOUCH. Helper/bench PASS is not a product PASS.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openDb } from '../apps/server/src/db/index.js';
import { insertMessage, readablePreview, setHead } from '../apps/server/src/db/tree.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { MessageMeta } from '../apps/server/src/types.js';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const now = '2026-09-19T00:00:00.000Z';
const UI_JSON = JSON.stringify({
  location_badge: 'S반 교실',
  roster: ['나리', '유저'],
});
const NARRATION = '교실이 조용하다. 창밖으로 바람이 스친다.';
const LINE = '「오늘은 수업 전에 잠깐 이야기하자.」';
const PREV_TURN = '이전 턴 서술 — 목록에 나오면 안 된다.';

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-readable-preview-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));

  db.exec(`
    INSERT INTO characters (id, name, tagline, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, tags_json, created_at, updated_at)
    VALUES ('c1','캐','','','','','','','','','[]','${now}','${now}');
    INSERT INTO conversations (id, character_id, title, mode, profile_name, scene_json, prompt_version, created_at, updated_at)
    VALUES
      ('conv-11','c1','1:1','chat','rp-balanced','{}','pv','${now}','${now}'),
      ('conv-party','c1','파티','story','rp-balanced','{}','pv','${now}','${now}'),
      ('conv-dialog','c1','다이얼로그','story','rp-balanced','{}','pv','${now}','${now}'),
      ('conv-header','c1','헤더만','story','rp-balanced','{}','pv','${now}','${now}'),
      ('conv-cap','c1','캡','story','rp-balanced','{}','pv','${now}','${now}');
  `);

  function push(
    convId: string,
    parentId: string | null,
    content: string,
    meta: MessageMeta,
    role: 'user' | 'assistant' = 'assistant',
  ) {
    return insertMessage(db, convId, parentId, role, content, 'complete', meta);
  }

  const oneToOneBody = '안녕, 오늘 날씨 좋지? 1:1 본문입니다.';
  const u11 = push('conv-11', null, '유저 인사', {}, 'user');
  const a11 = push('conv-11', u11.id, oneToOneBody, {});
  setHead(db, 'conv-11', a11.id);

  const prev = push('conv-party', null, PREV_TURN, { block_kind: 'narration' });
  const hdr = push('conv-party', prev.id, 'Turn 2', { block_kind: 'header' });
  const nar = push('conv-party', hdr.id, NARRATION, { block_kind: 'narration' });
  const ln = push('conv-party', nar.id, LINE, { block_kind: 'line' });
  const th = push('conv-party', ln.id, '속마음', { block_kind: 'thought' });
  const ui = push('conv-party', th.id, UI_JSON, { block_kind: 'ui' });
  setHead(db, 'conv-party', ui.id);

  const dHdr = push('conv-dialog', null, 'Turn 1', { block_kind: 'header' });
  const dNar = push('conv-dialog', dHdr.id, '복도가 붐빈다.', { block_kind: 'narration' });
  const dL1 = push('conv-dialog', dNar.id, '「먼저 말해볼까.」', { block_kind: 'line' });
  const dL2 = push('conv-dialog', dL1.id, '「마지막 대사다.」', { block_kind: 'line' });
  const dUi = push('conv-dialog', dL2.id, UI_JSON, { block_kind: 'ui' });
  setHead(db, 'conv-dialog', dUi.id);

  const onlyHdr = push('conv-header', null, PREV_TURN, { block_kind: 'narration' });
  const stopHdr = push('conv-header', onlyHdr.id, 'Turn X', { block_kind: 'header' });
  const onlyUi = push('conv-header', stopHdr.id, UI_JSON, { block_kind: 'ui' });
  setHead(db, 'conv-header', onlyUi.id);

  let capParent: string | null = null;
  for (let i = 0; i < 13; i++) {
    const row = push('conv-cap', capParent, `skip-${i}`, { block_kind: 'panel' });
    capParent = row.id;
  }
  setHead(db, 'conv-cap', capParent);

  await t('1:1 preview equals head content slice(0, 120)', () => {
    assert.equal(readablePreview(db, a11.id), oneToOneBody.slice(0, 120));
  });

  await t('1:1 JSON null block_kind still returns content', () => {
    const row = push('conv-11', a11.id, '널 카인드', { block_kind: null as unknown as MessageMeta['block_kind'] });
    assert.equal(readablePreview(db, row.id), '널 카인드');
  });

  await t('ui-head party skips ui/thought and returns last line', () => {
    const preview = readablePreview(db, ui.id);
    assert.equal(preview, LINE);
    assert.equal(preview.includes('{'), false);
    assert.equal(preview.includes('location_badge'), false);
    assert.equal(preview.includes('roster'), false);
    assert.equal(preview.includes(PREV_TURN), false);
  });

  await t('dialog ui-head returns last line not earlier narration', () => {
    const preview = readablePreview(db, dUi.id);
    assert.equal(preview, '「마지막 대사다.」');
    assert.equal(preview.includes('{'), false);
    assert.equal(preview.includes('location_badge'), false);
    assert.equal(preview.includes('roster'), false);
  });

  await t('header stops — does not leak previous turn', () => {
    assert.equal(readablePreview(db, onlyUi.id), '');
  });

  await t('hop cap 12 of skippable kinds → empty', () => {
    assert.equal(readablePreview(db, capParent), '');
  });

  await t('null / missing head → empty', () => {
    assert.equal(readablePreview(db, null), '');
    assert.equal(readablePreview(db, undefined), '');
    assert.equal(readablePreview(db, 'missing-id'), '');
  });

  await t('SQL subquery gone from both list paths', () => {
    const src = fs.readFileSync(path.resolve('apps/server/src/routes/conversations.ts'), 'utf8');
    assert.equal(src.includes('(SELECT content FROM messages'), false);
    assert.equal(src.includes('readablePreview(db, r.head_message_id)'), true);
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

  await t('GET /api/conversations: 1:1 same, party/dialog readable, no ui json', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/conversations?limit=50' });
    assert.equal(res.statusCode, 200, res.body);
    const rows = JSON.parse(res.body) as { id: string; preview: string }[];
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.preview]));
    assert.equal(byId['conv-11'], oneToOneBody.slice(0, 120));
    assert.equal(byId['conv-party'], LINE);
    assert.equal(byId['conv-dialog'], '「마지막 대사다.」');
    assert.equal(byId['conv-header'], '');
    for (const id of ['conv-party', 'conv-dialog', 'conv-header'] as const) {
      const p = byId[id] ?? '';
      assert.equal(p.includes('{'), false, id);
      assert.equal(p.includes('location_badge'), false, id);
      assert.equal(p.includes('roster'), false, id);
    }
  });

  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`passed ${passed}`);
}

void main();
