/** npx tsx bench/characterPromptPreview.test.ts
 * C7 GET /api/characters/:id/prompt-preview. Temp DB + real characterRoutes.
 * No live DB, no model, no deploy. Helper/bench PASS is not a product PASS.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openDb } from '../apps/server/src/db/index.js';
import {
  CHARACTER_PROMPT_PREVIEW_EXCERPT_MAX,
  characterRoutes,
} from '../apps/server/src/routes/characters.js';
import { PROMPT_VERSION } from '../apps/server/src/config.js';
import type { Ctx } from '../apps/server/src/ctx.js';

const CHAR_ROUTE = path.resolve('apps/server/src/routes/characters.ts');
const PLAY_GUIDE_MARKER = 'C7PLAYGUIDE_UNIQUE_MARKER_9f3a';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

function virtualConvAstText(file: string): string {
  const r = spawnSync(
    '/home/hermes/.local/bin/ast-grep',
    ['run', '-p', 'const virtualConv: ConversationRow = $X', '--lang', 'ts', '--json=compact', file],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const hits = JSON.parse(r.stdout) as Array<{ text: string }>;
  assert.equal(hits.length, 1, `expected 1 virtualConv, got ${hits.length}`);
  return hits[0].text;
}

function count(db: ReturnType<typeof openDb>, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function fakeCtx(db: ReturnType<typeof openDb>): Ctx {
  const model = new Proxy({} as Ctx['model'], {
    get() {
      throw new Error('C7 preview must not touch ctx.model');
    },
  });
  return {
    db,
    model,
    queue: { activeList: [] } as unknown as Ctx['queue'],
    log: console as unknown as Ctx['log'],
    resolvedModel: () => 'm',
    setResolvedModel: () => {},
    health: async () => ({ ok: true, checkedAt: 't', latencyMs: 0, models: [] }),
  } as Ctx;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-char-prompt-preview-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));

  db.prepare(
    `INSERT INTO characters (id, name, tagline, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, play_guide, tags_json, archived, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'c-live',
    '미리보기캐',
    '한줄',
    '설명본문',
    '성격본문',
    '말투본문',
    '시나리오본문',
    '첫인사',
    '',
    '금기본문',
    PLAY_GUIDE_MARKER,
    '[]',
    0,
    't0',
    't0',
  );
  db.prepare(
    `INSERT INTO characters (id, name, tagline, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, play_guide, tags_json, archived, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'c-arch',
    '보관캐',
    '',
    '보관설명',
    '',
    '',
    '',
    '',
    '',
    '',
    PLAY_GUIDE_MARKER,
    '[]',
    1,
    't0',
    't0',
  );
  db.prepare(
    `INSERT INTO personas (id, name, address_as, appearance, personality, relationship, is_default, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run('p1', '유저이름', '호칭', '외형', '페르소나성격', '관계', 1, 't0', 't0');
  db.prepare(
    `INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes) VALUES (?,?,?,?,?,?,?,?)`,
  ).run('rp-balanced', null, 0.8, 0.95, 400, '[]', 'system', null);

  const ctx = fakeCtx(db);
  const app = Fastify({ logger: false });
  await app.register(characterRoutes(ctx));

  await t("unknown id → 404 {error:'not found'}", async () => {
    const res = await app.inject({ method: 'GET', url: '/api/characters/nope/prompt-preview' });
    assert.equal(res.statusCode, 404, res.body);
    assert.equal(res.json().error, 'not found');
  });

  await t("saved character → 200; section '시스템 규칙+카드+페르소나+장면' present", async () => {
    const convBefore = count(db, 'conversations');
    const msgBefore = count(db, 'messages');
    const res = await app.inject({ method: 'GET', url: '/api/characters/c-live/prompt-preview' });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as {
      charName: string;
      userName: string;
      promptVersion: string;
      model: string;
      contextTokens: number;
      sections: Array<{ name: string; est_tokens: number; budget: number; note?: string; kind?: string }>;
      totalEstTokens: number;
      fixedExcerpt: string;
      fixedTruncated: boolean;
    };
    assert.equal(body.charName, '미리보기캐');
    assert.equal(body.userName, '유저이름');
    assert.equal(body.promptVersion, PROMPT_VERSION);
    assert.equal(body.model, 'm');
    assert.equal(typeof body.contextTokens, 'number');
    assert.ok(body.contextTokens > 0);
    const names = body.sections.map((s) => s.name);
    assert.ok(names.includes('시스템 규칙+카드+페르소나+장면'), JSON.stringify(names));
    assert.equal(names.includes('스토리 설정'), false, '1:1 chat preview must not grow a story section');
    assert.ok(body.totalEstTokens > 0);
    assert.ok(body.fixedExcerpt.includes('미리보기캐'));
    assert.ok(body.fixedExcerpt.includes('성격본문'));
    assert.equal(body.fixedTruncated, false);
    assert.equal(count(db, 'conversations'), convBefore);
    assert.equal(count(db, 'messages'), msgBefore);
  });

  await t('play_guide body never appears in serialized response', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/characters/c-live/prompt-preview' });
    assert.equal(res.statusCode, 200, res.body);
    const raw = JSON.stringify(res.json());
    assert.equal(raw.includes(PLAY_GUIDE_MARKER), false, raw.slice(0, 400));
  });

  await t('archived character uses same id rule as GET /:id → 200', async () => {
    const getRes = await app.inject({ method: 'GET', url: '/api/characters/c-arch' });
    assert.equal(getRes.statusCode, 200, getRes.body);
    const res = await app.inject({ method: 'GET', url: '/api/characters/c-arch/prompt-preview' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().charName, '보관캐');
  });

  await t('excerpt cap constant is imported; huge card truncates at that cap', async () => {
    assert.equal(CHARACTER_PROMPT_PREVIEW_EXCERPT_MAX, 4000);
    const huge = `[[HEAD]]${'가'.repeat(CHARACTER_PROMPT_PREVIEW_EXCERPT_MAX + 200)}[[TAIL]]`;
    db.prepare(`UPDATE characters SET description = ? WHERE id = 'c-live'`).run(huge);
    const res = await app.inject({ method: 'GET', url: '/api/characters/c-live/prompt-preview' });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { fixedExcerpt: string; fixedTruncated: boolean };
    assert.equal(body.fixedTruncated, true);
    assert.equal(body.fixedExcerpt.length, CHARACTER_PROMPT_PREVIEW_EXCERPT_MAX);
    assert.ok(body.fixedExcerpt.includes('[[HEAD]]'));
    assert.equal(body.fixedExcerpt.includes('[[TAIL]]'), false);
    db.prepare(`UPDATE characters SET description = ? WHERE id = 'c-live'`).run('설명본문');
  });

  await t("virtual conv mode is the literal 'chat' (ast-grep match of virtualConv)", () => {
    const text = virtualConvAstText(CHAR_ROUTE);
    assert.equal(text.includes("mode: 'chat'"), true, text.slice(0, 200));
    assert.equal(text.includes("mode: 'story'"), false, text.slice(0, 200));
  });

  console.log(`passed ${passed}`);
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
