/** npx tsx bench/personaDeleteFkGuard.test.ts
 * LOCK-PersonaDeleteFK-20260930 — DELETE /api/personas/:id must 409 when
 * summaries.rel_persona_id (or conversations.persona_id) still references the
 * persona. No cascade / NULL rewrite. Temp DB only; no live DB / systemd.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.ts';
import { characterRoutes } from '../apps/server/src/routes/characters.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-persona-delete-fk-'));
  const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));

  const fk = db.pragma('foreign_keys', { simple: true });
  assert.equal(fk, 1, 'PRAGMA foreign_keys must be ON');

  db.exec(`
    INSERT INTO characters (id, name, tagline, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, tags_json, created_at, updated_at)
    VALUES ('c1','캐','','','','','','','','','[]','t0','t0');
    INSERT INTO personas (id, name, address_as, appearance, personality, relationship, is_default, created_at, updated_at)
    VALUES
      ('p-free','자유','','','','',0,'t0','t0'),
      ('p-conv','대화전용','','','','',0,'t0','t0'),
      ('p-sum','요약전용','','','','',0,'t0','t0'),
      ('p-both','둘다','','','','',0,'t0','t0');
    INSERT INTO conversations (id, character_id, persona_id, title, mode, profile_name, scene_json, prompt_version, created_at, updated_at)
    VALUES
      ('conv-host','c1',NULL,'호스트','chat','rp-balanced','{}','pv','t0','t0'),
      ('conv-conv','c1','p-conv','대화','chat','rp-balanced','{}','pv','t0','t0'),
      ('conv-both','c1','p-both','둘다','chat','rp-balanced','{}','pv','t0','t0');
    INSERT INTO summaries (id, conversation_id, content, status, created_at, tier, rel_character_id, rel_persona_id)
    VALUES
      ('sum-sum','conv-host','요약전용 요약','approved','t0','episode','c1','p-sum'),
      ('sum-both','conv-both','둘다 요약','approved','t0','episode','c1','p-both');
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

  async function del(id: string) {
    return app.inject({ method: 'DELETE', url: `/api/personas/${id}` });
  }

  function personaExists(id: string): boolean {
    return !!db.prepare('SELECT 1 FROM personas WHERE id = ?').get(id);
  }

  await t('summary-only → 409; persona + summary remain', async () => {
    const res = await del('p-sum');
    assert.equal(res.statusCode, 409, res.body);
    const body = res.json() as { error: string };
    assert.match(body.error, /요약 1건/);
    assert.doesNotMatch(body.error, /FOREIGN KEY/i);
    assert.ok(personaExists('p-sum'));
    assert.ok(db.prepare('SELECT 1 FROM summaries WHERE id = ?').get('sum-sum'));
    console.log('sample_409_summary_only', JSON.stringify(body));
  });

  await t('conversation-only → 409; persona + conversation remain', async () => {
    const res = await del('p-conv');
    assert.equal(res.statusCode, 409, res.body);
    const body = res.json() as { error: string };
    assert.match(body.error, /대화 1건/);
    assert.doesNotMatch(body.error, /FOREIGN KEY/i);
    assert.ok(personaExists('p-conv'));
    assert.ok(db.prepare('SELECT 1 FROM conversations WHERE id = ?').get('conv-conv'));
  });

  await t('both → 409; persona + conversation + summary remain', async () => {
    const res = await del('p-both');
    assert.equal(res.statusCode, 409, res.body);
    const body = res.json() as { error: string };
    assert.match(body.error, /대화 1건/);
    assert.match(body.error, /요약 1건/);
    assert.doesNotMatch(body.error, /FOREIGN KEY/i);
    assert.ok(personaExists('p-both'));
    assert.ok(db.prepare('SELECT 1 FROM conversations WHERE id = ?').get('conv-both'));
    assert.ok(db.prepare('SELECT 1 FROM summaries WHERE id = ?').get('sum-both'));
  });

  await t('neither → 200 {ok:true}; persona gone', async () => {
    const res = await del('p-free');
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { ok: true });
    assert.equal(personaExists('p-free'), false);
  });

  await app.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`# pass ${passed}/4`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
