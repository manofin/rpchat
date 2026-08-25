/** npx tsx bench/personaPatchClear.test.ts
 * CLEAR contract lock — intended behavior (not current COALESCE characterization).
 *
 *   omitted personaId  → persona_id, snapshot, applied_at unchanged
 *   personaId: null    → persona_id, snapshot fields, applied_at all NULL
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

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-persona-clear-'));
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

  const seed = await patch({ personaId: 'p1' });
  assert.equal(seed.statusCode, 200, seed.body);
  const seeded = row();
  assert.equal(seeded.persona_id, 'p1');
  assert.equal(seeded.persona_name_snapshot, '유저1');
  assert.ok(seeded.persona_applied_at);

  await t('omitted personaId keeps persona_id, snapshot, and applied_at', async () => {
    const before = row();
    const res = await patch({ title: '제목-유지' });
    assert.equal(res.statusCode, 200, res.body);
    const after = row();
    assert.equal(after.persona_id, before.persona_id);
    assert.equal(after.persona_name_snapshot, before.persona_name_snapshot);
    assert.equal(after.persona_address_snapshot, before.persona_address_snapshot);
    assert.equal(after.persona_appearance_snapshot, before.persona_appearance_snapshot);
    assert.equal(after.persona_personality_snapshot, before.persona_personality_snapshot);
    assert.equal(after.persona_relationship_snapshot, before.persona_relationship_snapshot);
    assert.equal(after.persona_applied_at, before.persona_applied_at);
  });

  await t('personaId null sets persona_id, snapshot, and applied_at to NULL', async () => {
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

  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`passed ${passed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
