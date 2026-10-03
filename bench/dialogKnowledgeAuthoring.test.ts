import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.js';
import { insertMessage, setHead } from '../apps/server/src/db/tree.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { memoryRoutes } from '../apps/server/src/routes/memory.js';
import type { Ctx } from '../apps/server/src/ctx.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-knowledge-authoring-'));
const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
const queue = new GenerationQueue(1);
let modelCalls = 0;
const model = { complete() { modelCalls++; throw new Error('NO_MODEL'); }, stream() { modelCalls++; throw new Error('NO_MODEL'); } };
const ctx = { db, queue, model, resolvedModel: () => 'mock', effectiveDataDir: tmp } as unknown as Ctx;
const app = Fastify();
for (const route of [characterRoutes, storyRoutes, conversationRoutes, memoryRoutes]) app.register(route(ctx));
let passed = 0;
async function t(name: string, fn: () => Promise<void>) { await fn(); console.log(`ok ${++passed} ${name}`); }
async function api(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) {
  const r = await app.inject({ method, url, payload: payload as object });
  assert.ok(r.statusCode < 400, `${r.statusCode} ${r.body}`);
  return r.json();
}
async function main() {
  db.prepare(`INSERT INTO model_profiles(name, temperature, top_p, max_tokens, stop_json, system_mode) VALUES ('rp-balanced', .8, .95, 900, '[]', 'system')`).run();
  const a = await api('POST', '/api/characters', { name: '나리', first_message: '', tags: ['party:place=도서관'] });
  const b = await api('POST', '/api/characters', { name: '세라', first_message: '', tags: ['party:place=도서관'] });
  const story = await api('POST', '/api/stories', { name: 'authoring', setting: 'WORLD', scene_catalog: { places: [{ id: '도서관' }] } });
  for (const [sortOrder, c] of [a, b].entries()) await api('POST', `/api/stories/${story.id}/characters`, { characterId: c.id, sortOrder });
  const room = await api('POST', '/api/conversations', { characterId: a.id, storyId: story.id, scene: { format: 'dialog' } });
  const root = insertMessage(db, room.id, null, 'user', '원래 분기의 입력', 'complete');
  setHead(db, room.id, root.id);
  const secret = await api('POST', '/api/memories', { conversationId: room.id, content: 'NARI_ONLY_TEST_SECRET', evidenceMessageIds: [root.id] });
  const promise = await api('POST', '/api/memories', { conversationId: room.id, content: '사용자가 나리에게 수첩을 돌려준다.' });
  const sceneJson = () => (db.prepare('SELECT scene_json FROM conversations WHERE id=?').get(room.id) as { scene_json: string }).scene_json;
  const memoryRows = () => db.prepare('SELECT * FROM memories ORDER BY id').all();
  const view = async () => {
    const before = memoryRows();
    const result = await api('GET', `/api/conversations/${room.id}/knowledge`);
    assert.deepEqual(memoryRows(), before);
    return result;
  };
  const preview = () => api('GET', `/api/conversations/${room.id}/prompt-preview?draft=현재%20입력`);
  const entry = (m: any, known_by: unknown = []) => ({ memory_id: m.id, anchor_message_id: root.id, kind: 'fact', known_by, status: 'active' });
  const save = async (m: any, e: unknown, headMessageId = root.id) => {
    const before = memoryRows();
    const result = await api('PUT', `/api/conversations/${room.id}/knowledge/${m.id}`, { headMessageId, entry: e });
    assert.deepEqual(memoryRows(), before);
    return result;
  };
  const rejectUnchanged = async (m: any, e: unknown, code: number, headMessageId = root.id) => {
    const before = sceneJson();
    const r = await app.inject({ method: 'PUT', url: `/api/conversations/${room.id}/knowledge/${m.id}`, payload: { headMessageId, entry: e } });
    assert.equal(r.statusCode, code, r.body); assert.equal(sceneJson(), before);
    return r.json();
  };

  await t('GET returns actual roster and pinned memories without changing the scene', async () => {
    const before = sceneJson(), v = await view();
    assert.equal(v.enabled, true); assert.equal(v.headMessageId, root.id);
    assert.deepEqual(v.actors.map((x: any) => x.id), [a.id, b.id]);
    assert.deepEqual(v.entries, []); assert.equal(v.memories.length, 2); assert.equal(sceneJson(), before);
  });
  await t('explicit narrator-only assignment reserves the memory from generic publishing', async () => {
    await save(secret, entry(secret));
    const p = await preview();
    assert.equal(p.actor_context.public_facts.length, 0);
    assert.equal(p.actor_context.narrator_facts[0].text, secret.content);
    assert.ok(p.actor_context.actors.every((x: any) => x.facts.length === 0));
    assert.equal(JSON.parse(sceneJson()).pending_edit.head_message_id, root.id);
  });
  await t('private assignment and user→NPC promise are reflected in actual preview', async () => {
    await save(secret, entry(secret, [a.id]));
    await save(promise, { ...entry(promise, 'public'), kind: 'promise', subject_id: 'user', target_id: a.id });
    const p = await preview();
    assert.deepEqual(p.actor_context.actors.find((x: any) => x.id === a.id).facts.map((x: any) => x.memory_id), [secret.id]);
    assert.equal(p.actor_context.actors.find((x: any) => x.id === b.id).facts.length, 0);
    const fact = p.actor_context.public_facts[0];
    assert.equal(fact.subject_id, 'user'); assert.equal(fact.target_id, a.id); assert.equal(fact.kind, 'promise');
    assert.equal((await view()).entries.length, 2);
  });
  await t('resolved entries remain reserved and do not become public facts', async () => {
    await save(secret, { ...entry(secret, [a.id]), status: 'resolved' });
    const p = await preview();
    assert.ok(!JSON.stringify(p.messages).includes(secret.content));
    assert.equal(p.actor_context.excluded.find((x: any) => x.memory_id === secret.id).reason, 'resolved');
    await save(secret, entry(secret, [a.id]));
  });
  await t('opening and editing another assignment retain an approved public scope', async () => {
    const before = sceneJson();
    const v = await view();
    assert.equal(v.entries.find((e: any) => e.memory_id === promise.id).known_by, 'public');
    assert.equal(sceneJson(), before);
    await save(secret, entry(secret, [a.id]));
    assert.equal((await view()).entries.find((e: any) => e.memory_id === promise.id).known_by, 'public');
  });
  await t('unassigning one memory preserves unrelated assignments and scene state', async () => {
    const before = JSON.parse(sceneJson());
    await save(promise, null);
    const after = JSON.parse(sceneJson());
    assert.deepEqual(after.dialog_context.entries.map((x: any) => x.memory_id), [secret.id]);
    assert.deepEqual(after.user_sheet, before.user_sheet); assert.equal(after.turn_no, before.turn_no);
  });
  await t('stale branch head rejects the save without any mutation', async () => {
    await rejectUnchanged(secret, entry(secret, 'public'), 409, 'stale-head');
  });
  await t('registered generation blocks authoring including ending jobs', async () => {
    queue.register({ id: 'busy', kind: 'ending-judge', conversationId: room.id, messageId: '', startedAt: '', controller: new AbortController() });
    try { await rejectUnchanged(secret, entry(secret, 'public'), 409); } finally { queue.unregister('busy'); }
  });
  await t('candidate, foreign room and unknown recipients cannot be assigned', async () => {
    const candidate = await api('POST', '/api/memories', { conversationId: room.id, content: '未承認_TEST', status: 'candidate' });
    await rejectUnchanged(candidate, entry(candidate), 400);
    const other = await api('POST', '/api/conversations', { characterId: a.id, storyId: story.id, scene: { format: 'dialog' } });
    const foreign = await api('POST', '/api/memories', { conversationId: other.id, content: 'FOREIGN_MEMORY' });
    await rejectUnchanged(foreign, entry(foreign), 400);
    await rejectUnchanged(secret, entry(secret, ['unknown']), 400);
    await rejectUnchanged(secret, { ...entry(secret), kind: 'promise', subject_id: 'user' }, 400);
    await rejectUnchanged(secret, { ...entry(secret), kind: 'relationship', subject_id: 'user', target_id: 'unknown', status: 'resolved' }, 400);
  });
  await t('strict shape, duplicate holders and off-branch anchors reject unchanged', async () => {
    await rejectUnchanged(secret, { ...entry(secret), unwanted: true }, 400);
    await rejectUnchanged(secret, entry(secret, [a.id, a.id]), 400);
    const sibling = insertMessage(db, room.id, null, 'user', '別分岐_TEST', 'complete');
    await rejectUnchanged(secret, { ...entry(secret), anchor_message_id: sibling.id }, 400);
  });
  await t('character memory for a secondary NPC is available, not only main character', async () => {
    const shared = await api('POST', '/api/memories', { characterId: b.id, scope: 'character', content: 'SECOND_ACTOR_MEMORY' });
    assert.ok((await view()).memories.some((x: any) => x.id === shared.id));
    await save(shared, entry(shared, [b.id]));
    const p = await preview(); assert.ok(p.actor_context.actors.find((x: any) => x.id === b.id).facts.some((x: any) => x.memory_id === shared.id));
  });
  await t('branch-local save preserves off-branch exclusions rather than publishing them', async () => {
    const branch = insertMessage(db, room.id, null, 'user', '새 분기의 입력', 'complete'); setHead(db, room.id, branch.id);
    await rejectUnchanged(secret, { ...entry(secret), anchor_message_id: branch.id }, 400, branch.id);
    const m = await api('POST', '/api/memories', { conversationId: room.id, content: 'BRANCH_APPROVED_FACT' });
    await save(m, { ...entry(m, 'public'), anchor_message_id: branch.id }, branch.id);
    const v = await view(); assert.ok(v.entries.some((x: any) => x.memory_id === secret.id));
    const p = await preview(); assert.ok(!JSON.stringify(p.messages).includes(secret.content));
    assert.ok(p.actor_context.public_facts.some((x: any) => x.memory_id === m.id));
    setHead(db, room.id, root.id);
  });
  await t('non-dialog format and malformed prior contract cannot be silently replaced', async () => {
    const original = sceneJson();
    db.prepare('UPDATE conversations SET scene_json=? WHERE id=?').run(JSON.stringify({ format: 'beat' }), room.id);
    assert.equal((await view()).enabled, false); await rejectUnchanged(secret, entry(secret), 400);
    db.prepare('UPDATE conversations SET scene_json=? WHERE id=?').run(JSON.stringify({ format: 'dialog', dialog_context: { entries: 'bad' } }), room.id);
    assert.equal((await view()).invalidContract, true); await rejectUnchanged(secret, null, 409);
    db.prepare('UPDATE conversations SET scene_json=? WHERE id=?').run(original, room.id);
  });
  await t('beat rooms cannot edit dialog recognition scope even with stored assignments and observation filtering enabled', async () => {
    const original = sceneJson();
    const beat = { ...JSON.parse(original), format: 'beat', observation_filter: true };
    db.prepare('UPDATE conversations SET scene_json=? WHERE id=?').run(JSON.stringify(beat), room.id);
    try {
      const before = memoryRows();
      const v = await view();
      assert.equal(v.enabled, false);
      await rejectUnchanged(secret, entry(secret, 'public'), 400);
      await rejectUnchanged(secret, null, 400);
      assert.deepEqual(memoryRows(), before);
      assert.deepEqual(JSON.parse(sceneJson()).dialog_context, beat.dialog_context);
    } finally {
      db.prepare('UPDATE conversations SET scene_json=? WHERE id=?').run(original, room.id);
    }
  });
  await t('authoring never invokes model and nonexistent rooms return 404', async () => {
    assert.equal(modelCalls, 0);
    assert.equal((await app.inject({ method: 'GET', url: '/api/conversations/missing/knowledge' })).statusCode, 404);
  });
}
main().finally(async () => { await app.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); }).catch(e => { console.error(e); process.exitCode = 1; });
