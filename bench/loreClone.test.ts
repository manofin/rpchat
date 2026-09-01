/** npx tsx bench/loreClone.test.ts
 * G5-7 (minimal) — one-click lore entry clone.
 * Temp DB only, real migrations. Helper/bench PASS is not a product PASS.
 * Does not start systemd or touch the live DB. No UI render. No commit/deploy.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openDb } from '../apps/server/src/db/index.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import type { Ctx } from '../apps/server/src/ctx.js';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const JSON_HEAD = { 'content-type': 'application/json' };

function count(db: ReturnType<typeof openDb>, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-lore-clone-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));
  db.exec(`
    INSERT INTO characters (id, name, tagline, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, tags_json, created_at, updated_at)
    VALUES ('c1','메인A','','설명','성격','말투','','','','','[]','t0','t0');
  `);

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
  await app.register(characterRoutes(ctx));

  const SRC = {
    title: '북쪽 관문',
    keywords: ['관문', '북쪽'],
    secondary_keys: ['눈보라'],
    content: '관문은 겨울마다 닫힌다.',
    priority: 7,
    always_on: true,
    token_cap: 250,
    enabled: false,
    selective: true,
  };
  const createRes = await app.inject({ method: 'POST', url: '/api/characters/c1/lore', headers: JSON_HEAD, payload: SRC });
  assert.equal(createRes.statusCode, 201, createRes.body);
  const src = createRes.json();

  await t('CLONE-01 clone → 201 with a fresh id and the (복제) title', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/lore/${src.id}/clone`, headers: JSON_HEAD, payload: {} });
    assert.equal(res.statusCode, 201, res.body);
    const copy = res.json();
    assert.notEqual(copy.id, src.id, 'clone must get its own id');
    assert.equal(copy.title, '북쪽 관문 (복제)');
    (globalThis as { cloneId?: string }).cloneId = copy.id;
  });

  await t('CLONE-02 every authored field is carried over, booleans included', async () => {
    const copy = db.prepare('SELECT * FROM lore_entries WHERE id = ?').get((globalThis as { cloneId?: string }).cloneId) as Record<string, unknown>;
    assert.equal(copy.content, SRC.content);
    assert.equal(copy.priority, SRC.priority);
    assert.equal(copy.token_cap, SRC.token_cap);
    assert.equal(copy.always_on, 1, 'always_on preserved');
    assert.equal(copy.enabled, 0, 'a disabled entry clones as disabled — no silent re-enable');
    assert.equal(copy.selective, 1, 'selective preserved');
    assert.deepEqual(JSON.parse(String(copy.keywords_json)), SRC.keywords);
    assert.deepEqual(JSON.parse(String(copy.secondary_keys_json)), SRC.secondary_keys);
  });

  await t('CLONE-03 the source row is not modified', async () => {
    const after = db.prepare('SELECT * FROM lore_entries WHERE id = ?').get(src.id) as Record<string, unknown>;
    assert.equal(after.title, '북쪽 관문');
    assert.equal(after.enabled, 0);
  });

  await t('CLONE-04 clone lands in the same lorebook and shows up in the character list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/characters/c1/lore' });
    assert.equal(res.statusCode, 200);
    const rows = res.json() as Array<{ id: string; title: string; lorebook_id: string }>;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].lorebook_id, rows[1].lorebook_id, 'same lorebook');
    assert.deepEqual(rows.map((r) => r.title).sort(), ['북쪽 관문', '북쪽 관문 (복제)']);
  });

  await t('CLONE-05 unknown id → 404 and zero inserts', async () => {
    const before = count(db, 'lore_entries');
    const res = await app.inject({ method: 'POST', url: '/api/lore/nope/clone', headers: JSON_HEAD, payload: {} });
    assert.equal(res.statusCode, 404, res.body);
    assert.equal(res.json().error, 'not found');
    assert.equal(count(db, 'lore_entries'), before, 'no row inserted on the 404 path');
  });

  await t('CLONE-06 the clone stays editable: title never exceeds the PUT schema max (120)', async () => {
    const long = '가'.repeat(120);
    const made = await app.inject({
      method: 'POST', url: '/api/characters/c1/lore', headers: JSON_HEAD,
      payload: { ...SRC, title: long },
    });
    assert.equal(made.statusCode, 201, made.body);
    const res = await app.inject({ method: 'POST', url: `/api/lore/${made.json().id}/clone`, headers: JSON_HEAD, payload: {} });
    assert.equal(res.statusCode, 201, res.body);
    const copy = res.json();
    assert.ok(copy.title.length <= 120, `cloned title ${copy.title.length} chars > 120 — PUT would reject it`);
    assert.ok(copy.title.endsWith(' (복제)'), 'the 복제 marker survives truncation');
    const edit = await app.inject({
      method: 'PUT', url: `/api/lore/${copy.id}`, headers: JSON_HEAD,
      payload: { title: copy.title, keywords: copy.keywords, secondary_keys: copy.secondary_keys, content: copy.content, priority: copy.priority, always_on: copy.always_on, token_cap: copy.token_cap, enabled: copy.enabled, selective: copy.selective },
    });
    assert.equal(edit.statusCode, 200, `round-tripping the cloned title through PUT must work: ${edit.body}`);
  });

  await t('CLONE-07 cloning a clone is allowed and stays deterministic', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/lore/${(globalThis as { cloneId?: string }).cloneId}/clone`, headers: JSON_HEAD, payload: {} });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().title, '북쪽 관문 (복제) (복제)');
  });

  await t('CLONE-08 editor exposes a per-row 복사 button that does not open the row editor', async () => {
    const editorSrc = fs.readFileSync(path.resolve('apps/web/src/components/CharacterEditor.tsx'), 'utf8');
    assert.ok(editorSrc.includes('>복사</button>'), '복사 button missing');
    assert.match(editorSrc, /복사[\s\S]{0,40}<\/button>|stopPropagation\(\); clone\(e\.id\)/, 'clone must be wired');
    assert.ok(editorSrc.includes('ev.stopPropagation(); clone(e.id)'), 'row click opens the editor — clone must stop propagation');
    assert.ok(editorSrc.includes('/clone'), 'calls the clone route');
    assert.ok(editorSrc.includes('로어가 복제됨'), 'toast copy');
  });

  await app.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`passed ${passed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
