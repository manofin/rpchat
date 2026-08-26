/** npx tsx bench/userNoteRequestRoundtrip.test.ts
 * Gate 4 A — existing GET/PATCH /api/conversations/:id userNote
 * request-roundtrip characterization (no new API).
 *
 *   omit userNote     → keep stored user_note
 *   string            → store exactly
 *   ""                → store empty string (not SQL NULL)
 *   null              → SQL/API NULL (CLEAR)
 *   500 / 2000 / 4000 → 200, exact match, no truncate
 *   4001              → 400, stored value + updated_at unchanged
 *   missing id        → 404
 *
 * Isolated tmp DB only. Helper/bench PASS is not a product PASS
 * and is not live QA PATCH. Does not touch the live DB.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openDb } from '../apps/server/src/db/index.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import type { Ctx } from '../apps/server/src/ctx.js';

const UNTOUCHED = [
  'title',
  'mode',
  'profile_name',
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-usernote-roundtrip-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));

  db.exec(`
    INSERT INTO characters (id, name, tagline, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, tags_json, created_at, updated_at)
    VALUES
      ('c1','캐1','','','','','','','','','[]','t0','t0'),
      ('c2','캐2','','','','','','','','','[]','t0','t0');
    INSERT INTO personas (id, name, address_as, appearance, personality, relationship, is_default, created_at, updated_at)
    VALUES ('p1','유저1','호칭1','외형1','성격1','관계1',0,'t0','t0');
    INSERT INTO conversations (id, character_id, persona_id, title, mode, profile_name, scene_json, prompt_version, created_at, updated_at, user_note,
      persona_name_snapshot, persona_address_snapshot, persona_appearance_snapshot, persona_personality_snapshot, persona_relationship_snapshot, persona_applied_at)
    VALUES
      ('conv1','c1','p1','제목1','chat','rp-balanced','{}','pv','t0','t-updated','ORIGINAL',
       '유저1','호칭1','외형1','성격1','관계1','t-applied'),
      ('conv2','c2',NULL,'제목2','story','rp-creative','{}','pv','t0','t-other','OTHER-ROOM',
       NULL,NULL,NULL,NULL,NULL,NULL);
    INSERT INTO messages (id, conversation_id, parent_id, role, content, status, meta_json, created_at)
    VALUES
      ('m1','conv1',NULL,'user','안녕','complete','{}','t0'),
      ('m2','conv2',NULL,'user','다른방','complete','{}','t0');
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

  function row(id = 'conv1'): any {
    return db.prepare(`SELECT * FROM conversations WHERE id=?`).get(id);
  }

  function messages(id = 'conv1'): any[] {
    return db.prepare(`SELECT id, content FROM messages WHERE conversation_id=? ORDER BY id`).all(id);
  }

  async function patch(payload: Record<string, unknown>, id = 'conv1') {
    return app.inject({
      method: 'PATCH',
      url: `/api/conversations/${id}`,
      headers: { 'content-type': 'application/json' },
      payload,
    });
  }

  async function get(id = 'conv1') {
    return app.inject({
      method: 'GET',
      url: `/api/conversations/${id}`,
    });
  }

  function assertUntouched(before: any, after: any) {
    for (const col of UNTOUCHED) {
      assert.equal(after[col], before[col], col);
    }
  }

  const messagesBefore1 = messages('conv1');
  const messagesBefore2 = messages('conv2');
  const otherBefore = row('conv2');

  await t('A-01 GET returns current user_note and identifiers', async () => {
    const res = await get('conv1');
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.conversation.id, 'conv1');
    assert.equal(body.conversation.user_note, 'ORIGINAL');
    assert.equal(body.conversation.persona_id, 'p1');
    assert.equal(body.character.id, 'c1');
    assert.equal(row('conv1').user_note, 'ORIGINAL');
  });

  await t('A-02 GET → PATCH string → GET matches exactly; non-target fields stay', async () => {
    const before = row('conv1');
    const first = await get('conv1');
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().conversation.user_note, 'ORIGINAL');
    const res = await patch({ userNote: 'QA test value' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().user_note, 'QA test value');
    const second = await get('conv1');
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().conversation.user_note, 'QA test value');
    const after = row('conv1');
    assert.equal(after.user_note, 'QA test value');
    assertUntouched(before, after);
    assert.deepEqual(messages('conv1'), messagesBefore1);
  });

  await t('A-03 500 and 2000 persist exactly with no truncate', async () => {
    const n500 = 'a'.repeat(500);
    const n2000 = 'b'.repeat(2000);
    let res = await patch({ userNote: n500 });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().user_note, n500);
    assert.equal((await get()).json().conversation.user_note, n500);
    assert.equal(row().user_note.length, 500);
    res = await patch({ userNote: n2000 });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().user_note, n2000);
    assert.equal((await get()).json().conversation.user_note, n2000);
    assert.equal(row().user_note.length, 2000);
  });

  await t('A-04 4000 succeeds; 4001 is 400 and keeps stored value + updated_at', async () => {
    const n4000 = 'c'.repeat(4000);
    let res = await patch({ userNote: n4000 });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().user_note, n4000);
    assert.equal((await get()).json().conversation.user_note, n4000);
    const before = row();
    res = await patch({ userNote: 'd'.repeat(4001) });
    assert.equal(res.statusCode, 400, res.body);
    const after = row();
    assert.equal(after.user_note, n4000);
    assert.equal(after.updated_at, before.updated_at);
    assert.equal((await get()).json().conversation.user_note, n4000);
  });

  await t('A-05 omit keeps; empty string is empty not NULL; null CLEARs', async () => {
    const seed = 'KEEP-ME';
    let res = await patch({ userNote: seed });
    assert.equal(res.statusCode, 200, res.body);
    const before = row();
    res = await patch({ title: '제목1-유지확인' });
    assert.equal(res.statusCode, 200, res.body);
    let after = row();
    assert.equal(after.user_note, seed);
    assert.equal(after.title, '제목1-유지확인');
    assert.notEqual(after.user_note, null);

    res = await patch({ userNote: '' });
    assert.equal(res.statusCode, 200, res.body);
    after = row();
    assert.equal(after.user_note, '');
    assert.notEqual(after.user_note, null);
    assert.equal((await get()).json().conversation.user_note, '');

    res = await patch({ userNote: null });
    assert.equal(res.statusCode, 200, res.body);
    after = row();
    assert.equal(after.user_note, null);
    assert.equal((await get()).json().conversation.user_note, null);

    res = await patch({ title: before.title });
    assert.equal(res.statusCode, 200, res.body);
    after = row();
    assert.equal(after.user_note, null);
  });

  await t('A-06 failed request leaves stored note; UI page does not clear draft on error', async () => {
    const keep = 'PRESERVE';
    let res = await patch({ userNote: keep });
    assert.equal(res.statusCode, 200, res.body);
    const before = row();
    res = await patch({ userNote: 'e'.repeat(4001) });
    assert.equal(res.statusCode, 400, res.body);
    const after = row();
    assert.equal(after.user_note, keep);
    assert.equal(after.updated_at, before.updated_at);

    const page = fs.readFileSync(
      path.resolve('apps/web/src/pages/ConversationUserNotePage.tsx'),
      'utf8',
    );
    assert.match(page, /if \(!patched\) \{/);
    assert.doesNotMatch(page, /setDraft\(''\)/);
    assert.doesNotMatch(page, /setStatusMessage\('저장되었습니다/);
    assert.doesNotMatch(page, /\/500|2,?000\//);
  });

  await t('A-iso other conversation and messages stay unchanged', async () => {
    const other = row('conv2');
    assert.equal(other.user_note, otherBefore.user_note);
    assert.equal(other.updated_at, otherBefore.updated_at);
    assert.equal(other.title, otherBefore.title);
    assert.deepEqual(messages('conv2'), messagesBefore2);
    assert.deepEqual(messages('conv1'), messagesBefore1);
  });

  await t('A-404 missing conversation is 404 and writes nothing', async () => {
    const before1 = row('conv1');
    const before2 = row('conv2');
    const res = await patch({ userNote: 'ghost' }, 'missing-id');
    assert.equal(res.statusCode, 404, res.body);
    assert.equal(row('conv1').updated_at, before1.updated_at);
    assert.equal(row('conv1').user_note, before1.user_note);
    assert.equal(row('conv2').updated_at, before2.updated_at);
    assert.equal(row('conv2').user_note, before2.user_note);
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
