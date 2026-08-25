/** npx tsx bench/personaPatch.test.ts
 * Gate 3 prerequisite — live PATCH /api/conversations/:id personaId
 * characterization (existing handler, not a new API).
 *
 * Separates:
 *   SELECT  = PATCH a different personaId
 *   REAPPLY = PATCH the same personaId again
 *   CLEAR   = PATCH personaId: null
 *
 * Helper/bench PASS is not a product PASS (helper-vs-live-contract).
 * Does not start systemd or touch the live DB.
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-persona-patch-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));

  db.exec(`
    INSERT INTO characters (id, name, tagline, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, tags_json, created_at, updated_at)
    VALUES ('c1','캐','','','','','','','','','[]','t0','t0');
    INSERT INTO personas (id, name, address_as, appearance, personality, relationship, is_default, created_at, updated_at)
    VALUES
      ('p1','유저1','호칭1','외형1','성격1','관계1',0,'t0','t0'),
      ('p2','유저2','호칭2','외형2','성격2','관계2',1,'t0','t0');
    INSERT INTO conversations (id, character_id, persona_id, title, mode, profile_name, scene_json, prompt_version, created_at, updated_at)
    VALUES ('conv1','c1',NULL,'제목','chat','rp-balanced','{}','pv','t0','t0');
    INSERT INTO messages (id, conversation_id, parent_id, role, content, status, meta_json, created_at)
    VALUES ('m1','conv1',NULL,'user','안녕','complete','{}','t0');
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

  async function patchPersona(personaId: string | null | undefined) {
    const payload = personaId === undefined ? { title: '제목' } : { personaId };
    return app.inject({
      method: 'PATCH',
      url: '/api/conversations/conv1',
      headers: { 'content-type': 'application/json' },
      payload,
    });
  }

  function row(): any {
    return db.prepare(`SELECT * FROM conversations WHERE id='conv1'`).get();
  }

  function messages(): any[] {
    return db.prepare(`SELECT id, content FROM messages WHERE conversation_id='conv1' ORDER BY id`).all();
  }

  const messagesBefore = messages();

  await t('SELECT: PATCH p1 copies live row into snapshot and sets applied_at', async () => {
    const res = await patchPersona('p1');
    assert.equal(res.statusCode, 200, res.body);
    const r = row();
    assert.equal(r.persona_id, 'p1');
    assert.equal(r.persona_name_snapshot, '유저1');
    assert.equal(r.persona_address_snapshot, '호칭1');
    assert.equal(r.persona_appearance_snapshot, '외형1');
    assert.equal(r.persona_personality_snapshot, '성격1');
    assert.equal(r.persona_relationship_snapshot, '관계1');
    assert.ok(r.persona_applied_at, 'applied_at set');
    const body = res.json();
    assert.equal(body.persona_id, 'p1');
    assert.equal(body.persona_applied_at, r.persona_applied_at);
  });

  const appliedAfterSelect = row().persona_applied_at as string;

  await t('live edit without PATCH leaves snapshot frozen', async () => {
    db.prepare(`UPDATE personas SET appearance='외형1-수정' WHERE id='p1'`).run();
    const r = row();
    assert.equal(r.persona_appearance_snapshot, '외형1');
    assert.equal(r.persona_applied_at, appliedAfterSelect);
  });

  await t('REAPPLY: PATCH same p1 recopies live row and bumps applied_at', async () => {
    const res = await patchPersona('p1');
    assert.equal(res.statusCode, 200, res.body);
    const r = row();
    assert.equal(r.persona_id, 'p1');
    assert.equal(r.persona_appearance_snapshot, '외형1-수정');
    assert.ok(r.persona_applied_at);
    assert.notEqual(r.persona_applied_at, appliedAfterSelect, 'applied_at must change on reapply');
  });

  const appliedAfterReapply = row().persona_applied_at as string;

  await t('SELECT other: PATCH p2 replaces snapshot from p2', async () => {
    const res = await patchPersona('p2');
    assert.equal(res.statusCode, 200, res.body);
    const r = row();
    assert.equal(r.persona_id, 'p2');
    assert.equal(r.persona_name_snapshot, '유저2');
    assert.equal(r.persona_appearance_snapshot, '외형2');
    assert.notEqual(r.persona_applied_at, appliedAfterReapply);
  });

  await t('CLEAR: PATCH personaId null — record actual snapshot SQL behavior', async () => {
    const before = row();
    const res = await patchPersona(null);
    assert.equal(res.statusCode, 200, res.body);
    const r = row();
    assert.equal(r.persona_id, null, 'persona_id CASE writes null');
    // COALESCE(NULL, old) cannot clear snapshot columns. Lock the live SQL, do not "fix" here.
    assert.equal(r.persona_name_snapshot, before.persona_name_snapshot, 'COALESCE keeps name snapshot');
    assert.equal(r.persona_appearance_snapshot, before.persona_appearance_snapshot, 'COALESCE keeps appearance snapshot');
    assert.equal(r.persona_applied_at, before.persona_applied_at, 'COALESCE keeps applied_at');
  });

  await t('unknown personaId → 404, row unchanged', async () => {
    const before = row();
    const res = await patchPersona('ghost');
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'persona not found');
    const after = row();
    assert.equal(after.persona_id, before.persona_id);
    assert.equal(after.persona_applied_at, before.persona_applied_at);
  });

  await t('omitted personaId leaves snapshot and persona_id untouched', async () => {
    const seed = await patchPersona('p1');
    assert.equal(seed.statusCode, 200);
    const before = row();
    const res = await patchPersona(undefined);
    assert.equal(res.statusCode, 200, res.body);
    const after = row();
    assert.equal(after.persona_id, 'p1');
    assert.equal(after.persona_appearance_snapshot, before.persona_appearance_snapshot);
    assert.equal(after.persona_applied_at, before.persona_applied_at);
  });

  await t('persona PATCH does not rewrite messages', async () => {
    assert.deepEqual(messages(), messagesBefore);
  });

  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`passed ${passed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
