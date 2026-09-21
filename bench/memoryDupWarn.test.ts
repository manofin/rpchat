/** npx tsx bench/memoryDupWarn.test.ts
 * memory-dup-warn — pin/POST confirm for Jaccard duplicates.
 * Warn = HTTP 200 + { pinned:false, warn:'duplicate', conflict } — never 409.
 * confirm=1 query → pin / 201. CAL_CUT 0.35 unchanged. builder untouched.
 * Temp DB, no model, no hermes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.ts';
import { memoryRoutes } from '../apps/server/src/routes/memory.ts';
import { conversationRoutes } from '../apps/server/src/routes/conversations.ts';
import { characterRoutes } from '../apps/server/src/routes/characters.ts';
import { CAL_CUT, classify } from '../apps/server/src/memory/conflict.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';
import { GenerationQueue } from '../apps/server/src/model/queue.ts';

const PINNED = '보관소에는 시민들이 기증한 편지와 사진이 보관되어 있다';
const DUP_CAND = '보관소에는 시민들의 편지가 보관되어 있다';
const UNIQUE = '산 너머 마을에는 파란 등대가 있다';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

async function main() {
  await t('CAL_CUT === 0.35 (source + export)', () => {
    assert.equal(CAL_CUT, 0.35);
    const src = fs.readFileSync('apps/server/src/memory/conflict.ts', 'utf8');
    assert.match(src, /export const CAL_CUT = 0\.35/);
    const v = classify({ id: 'c', content: DUP_CAND }, [{ id: 'p', content: PINNED }]);
    assert.equal(v.kind, 'duplicate');
  });

  await t('builder inject path untouched (pinned-only SELECT present; no dup-warn)', () => {
    const src = fs.readFileSync('apps/server/src/prompt/builder.ts', 'utf8');
    assert.match(
      src,
      /SELECT \* FROM memories WHERE status = 'pinned'[\s\S]*scope = 'conversation'[\s\S]*scope = 'character'/,
    );
    assert.equal(src.includes("warn: 'duplicate'"), false);
    assert.equal(src.includes('wantsConfirm'), false);
  });

  await t('conflict suppress path still present (no Slice B)', () => {
    const src = fs.readFileSync('apps/server/src/memory/conflict.ts', 'utf8');
    assert.match(src, /conflict-suppressed/);
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-memory-dup-warn-'));
  const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
  db.prepare(
    `INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run('rp-balanced', null, 0.8, 0.95, 400, '[]', 'system', 'bench');

  const ctx = {
    db,
    model: {
      complete: async () => {
        throw new Error('memory-dup-warn must not call model');
      },
    } as unknown as Ctx['model'],
    queue: new GenerationQueue(1),
    log: { error() {}, info() {}, warn() {}, debug() {} } as unknown as Ctx['log'],
    resolvedModel: () => 'm',
    setResolvedModel: () => {},
    health: async () => ({ ok: true, checkedAt: 't', latencyMs: 0, models: [] }),
  } as Ctx;

  const app = Fastify({ logger: false });
  await app.register(characterRoutes(ctx));
  await app.register(conversationRoutes(ctx));
  await app.register(memoryRoutes(ctx));
  await app.ready();

  async function inj(method: string, url: string, body?: unknown) {
    const res = await app.inject({
      method,
      url,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      payload: body === undefined ? undefined : body,
    });
    let json: any = res.body;
    try {
      json = res.body ? JSON.parse(res.body) : null;
    } catch {
      /* text */
    }
    return { status: res.statusCode, json, body: res.body };
  }

  const char = await inj('POST', '/api/characters', { name: 'DupChar', personality: 'p', first_message: '' });
  assert.equal(char.status, 201, char.body);
  const characterId = char.json.id as string;
  const conv = await inj('POST', '/api/conversations', { characterId, mode: 'chat' });
  assert.equal(conv.status, 201, conv.body);
  const conversationId = conv.json.id as string;

  // Seed pinned memory
  const seed = await inj('POST', '/api/memories?confirm=1', {
    conversationId,
    content: PINNED,
    status: 'pinned',
    scope: 'conversation',
  });
  assert.equal(seed.status, 201, seed.body);
  const pinnedId = seed.json.id as string;

  await t('GET memories attaches duplicate conflict on candidate (regression)', async () => {
    // insert candidate directly (bypass POST pin path)
    const t0 = new Date().toISOString();
    db.prepare(
      `INSERT INTO memories (id, conversation_id, character_id, content, source, status, importance, scope, evidence_message_ids_json, created_at, updated_at)
       VALUES (?,?,?,?, 'model', 'candidate', 3, 'conversation', '[]', ?, ?)`,
    ).run('cand-dup', conversationId, characterId, DUP_CAND, t0, t0);
    const res = await inj('GET', `/api/conversations/${conversationId}/memories`);
    assert.equal(res.status, 200);
    const cand = res.json.candidates.find((m: any) => m.id === 'cand-dup');
    assert.ok(cand);
    assert.equal(cand.conflict?.kind, 'duplicate');
    assert.equal(cand.conflict?.withMemoryId, pinnedId);
  });

  await t('PATCH pin without confirm → 200 warn, pinned:false, DB still candidate', async () => {
    const res = await inj('PATCH', '/api/memories/cand-dup', { status: 'pinned' });
    assert.equal(res.status, 200, res.body);
    assert.notEqual(res.status, 409);
    assert.equal(res.json.pinned, false);
    assert.equal(res.json.warn, 'duplicate');
    assert.equal(res.json.conflict?.kind, 'duplicate');
    assert.equal(res.json.conflict?.withMemoryId, pinnedId);
    const row = db.prepare(`SELECT status FROM memories WHERE id='cand-dup'`).get() as { status: string };
    assert.equal(row.status, 'candidate');
  });

  await t('PATCH pin with confirm=1 → pinned', async () => {
    const res = await inj('PATCH', '/api/memories/cand-dup?confirm=1', { status: 'pinned' });
    assert.equal(res.status, 200, res.body);
    assert.equal(res.json.status, 'pinned');
    assert.notEqual(res.json.warn, 'duplicate');
    const row = db.prepare(`SELECT status FROM memories WHERE id='cand-dup'`).get() as { status: string };
    assert.equal(row.status, 'pinned');
  });

  await t('POST without confirm → 200 warn, no pinned insert', async () => {
    const before = (
      db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE content=?`).get(DUP_CAND) as { n: number }
    ).n;
    // Use another near-dup of PINNED that is still duplicate vs PINNED (and vs cand-dup)
    const content = '보관소에는 시민들이 기증한 편지와 사진이 보관되어 있다'; // exact of pinned
    const res = await inj('POST', '/api/memories', {
      conversationId,
      content,
      status: 'pinned',
      scope: 'conversation',
    });
    assert.equal(res.status, 200, res.body);
    assert.notEqual(res.status, 409);
    assert.equal(res.json.pinned, false);
    assert.equal(res.json.warn, 'duplicate');
    assert.equal(res.json.conflict?.kind, 'duplicate');
    const after = (
      db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE content=? AND status='pinned'`).get(content) as {
        n: number;
      }
    ).n;
    // only the original seed (and possibly cand-dup which is different content)
    assert.equal(after, 1, `expected no new pinned insert; before=${before} after=${after}`);
  });

  await t('POST with confirm=1 → 201 pinned', async () => {
    const content = '보관소에는 시민들이 기증한 편지와 사진이 보관되어 있다';
    const res = await inj('POST', '/api/memories?confirm=1', {
      conversationId,
      content,
      status: 'pinned',
      scope: 'conversation',
    });
    assert.equal(res.status, 201, res.body);
    assert.equal(res.json.status, 'pinned');
    assert.ok(res.json.id);
  });

  await t('POST unique content pins without confirm (201)', async () => {
    const res = await inj('POST', '/api/memories', {
      conversationId,
      content: UNIQUE,
      status: 'pinned',
      scope: 'conversation',
    });
    assert.equal(res.status, 201, res.body);
    assert.equal(res.json.status, 'pinned');
  });

  await t('optional: confirm when already pinned → harmless 200', async () => {
    const res = await inj('PATCH', `/api/memories/${pinnedId}?confirm=1`, { status: 'pinned' });
    assert.equal(res.status, 200, res.body);
    assert.equal(res.json.status, 'pinned');
  });

  await t('optional: confirm when deleted → 404', async () => {
    const res = await inj('PATCH', '/api/memories/no-such-id?confirm=1', { status: 'pinned' });
    assert.equal(res.status, 404);
  });

  await t('warn schema identical shape marker (PATCH & POST both use pinned:false)', () => {
    // Covered above; assert UI uses confirm=1
    const ui = fs.readFileSync('apps/web/src/pages/ChatDrawer.tsx', 'utf8');
    assert.match(ui, /warn === 'duplicate'/);
    assert.match(ui, /confirm=1/);
    assert.match(ui, /그래도 채택할까요/);
    assert.match(ui, /그래도 추가할까요/);
  });

  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
