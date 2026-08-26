/** npx tsx bench/personaPatchValidation.test.ts
 * PATCH tri-state validation contract (intended, not current HEAD).
 *
 *   personaId "" / whitespace-only → 400; persona fields + updated_at + title unchanged
 *   unknown non-empty              → 404; same immutability
 *   omitted personaId              → 200; persona state kept
 *   personaId null                 → 200; CLEAR
 *   existing id                    → 200; snapshot copy
 *
 * Helper/bench PASS is not a product PASS. Does not touch the live DB.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openDb } from '../apps/server/src/db/index.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import type { Ctx } from '../apps/server/src/ctx.js';

const PERSONA_COLS = [
  'persona_id',
  'persona_name_snapshot',
  'persona_address_snapshot',
  'persona_appearance_snapshot',
  'persona_personality_snapshot',
  'persona_relationship_snapshot',
  'persona_applied_at',
] as const;

let passed = 0;
let failed = 0;

async function t(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`ok ${passed + failed} ${name}`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`not ok ${passed + failed} ${name}`);
    console.log(`  ${msg.split('\n')[0]}`);
  }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-persona-validation-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));

  db.exec(`
    INSERT INTO characters (id, name, tagline, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, tags_json, created_at, updated_at)
    VALUES ('c1','캐','','','','','','','','','[]','t0','t0');
    INSERT INTO personas (id, name, address_as, appearance, personality, relationship, is_default, created_at, updated_at)
    VALUES ('p1','유저1','호칭1','외형1','성격1','관계1',0,'t0','t0');
    INSERT INTO conversations (id, character_id, persona_id, title, mode, profile_name, scene_json, prompt_version, created_at, updated_at)
    VALUES ('conv1','c1',NULL,'제목','chat','rp-balanced','{}','pv','t0','t0');
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
  await app.register(conversationRoutes(ctx));

  function row(): any {
    return db.prepare(`SELECT * FROM conversations WHERE id='conv1'`).get();
  }

  async function patch(payload: Record<string, unknown>) {
    return app.inject({
      method: 'PATCH',
      url: '/api/conversations/conv1',
      headers: { 'content-type': 'application/json' },
      payload,
    });
  }

  function seedApplied(): any {
    db.prepare(
      `UPDATE conversations SET
         persona_id = 'p1',
         persona_name_snapshot = '유저1',
         persona_address_snapshot = '호칭1',
         persona_appearance_snapshot = '외형1',
         persona_personality_snapshot = '성격1',
         persona_relationship_snapshot = '관계1',
         persona_applied_at = 't-applied',
         title = '제목',
         updated_at = 't-updated'
       WHERE id = 'conv1'`,
    ).run();
    return row();
  }

  function assertPersonaAndClockUnchanged(before: any, after: any) {
    for (const col of PERSONA_COLS) {
      assert.equal(after[col], before[col], col);
    }
    assert.equal(after.title, before.title, 'title');
    assert.equal(after.updated_at, before.updated_at, 'updated_at');
  }

  await t('PV-01 personaId empty string is 400 and leaves row+updated_at unchanged', async () => {
    const before = seedApplied();
    const res = await patch({ personaId: '' });
    assert.equal(res.statusCode, 400, res.body);
    assertPersonaAndClockUnchanged(before, row());
  });

  await t('PV-02 personaId whitespace-only is 400 and leaves row+updated_at unchanged', async () => {
    const before = seedApplied();
    const res = await patch({ personaId: '   ' });
    assert.equal(res.statusCode, 400, res.body);
    assertPersonaAndClockUnchanged(before, row());
  });

  await t('PV-03 unknown non-empty personaId is 404 and leaves row+updated_at unchanged', async () => {
    const before = seedApplied();
    const res = await patch({ personaId: 'ghost' });
    assert.equal(res.statusCode, 404, res.body);
    assertPersonaAndClockUnchanged(before, row());
  });

  await t('PV-04 omitted personaId keeps persona state when title changes', async () => {
    const before = seedApplied();
    const res = await patch({ title: '변경' });
    assert.equal(res.statusCode, 200, res.body);
    const after = row();
    for (const col of PERSONA_COLS) {
      assert.equal(after[col], before[col], col);
    }
    assert.equal(after.title, '변경');
  });

  await t('PV-05 personaId null CLEARs id, snapshots, and applied_at', async () => {
    seedApplied();
    const res = await patch({ personaId: null });
    assert.equal(res.statusCode, 200, res.body);
    const after = row();
    assert.equal(after.persona_id, null);
    assert.equal(after.persona_name_snapshot, null);
    assert.equal(after.persona_address_snapshot, null);
    assert.equal(after.persona_appearance_snapshot, null);
    assert.equal(after.persona_personality_snapshot, null);
    assert.equal(after.persona_relationship_snapshot, null);
    assert.equal(after.persona_applied_at, null);
  });

  await t('PV-06 existing personaId copies live snapshot and sets applied_at', async () => {
    db.prepare(
      `UPDATE conversations SET
         persona_id = NULL,
         persona_name_snapshot = NULL,
         persona_address_snapshot = NULL,
         persona_appearance_snapshot = NULL,
         persona_personality_snapshot = NULL,
         persona_relationship_snapshot = NULL,
         persona_applied_at = NULL,
         title = '제목',
         updated_at = 't-updated'
       WHERE id = 'conv1'`,
    ).run();
    const res = await patch({ personaId: 'p1' });
    assert.equal(res.statusCode, 200, res.body);
    const after = row();
    assert.equal(after.persona_id, 'p1');
    assert.equal(after.persona_name_snapshot, '유저1');
    assert.equal(after.persona_address_snapshot, '호칭1');
    assert.equal(after.persona_appearance_snapshot, '외형1');
    assert.equal(after.persona_personality_snapshot, '성격1');
    assert.equal(after.persona_relationship_snapshot, '관계1');
    assert.ok(after.persona_applied_at);
    assert.notEqual(after.persona_applied_at, 't-updated');
  });

  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`passed ${passed}`);
  console.log(`failed ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
