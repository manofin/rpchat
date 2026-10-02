// npm run test:benches -- sideModes
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openMigratedDb, one, run, uid, nowIso } from '../apps/server/src/db/index.js';
import { deepestLeaf, getPath, insertMessage, messageOut, setHead } from '../apps/server/src/db/tree.js';
import { buildSideModePrompt } from '../apps/server/src/prompt/sideModePrompt.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { memoryRoutes } from '../apps/server/src/routes/memory.js';
import { searchRoutes } from '../apps/server/src/routes/search.js';
import { sideModeRoutes } from '../apps/server/src/routes/sideModes.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { GenParams } from '../apps/server/src/model/adapter.js';
import type { ConversationRow } from '../apps/server/src/types.js';
import { config } from '../apps/server/src/config.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-side-modes-'));
const db = openMigratedDb(dir, path.resolve('apps/server/migrations'));
const app = Fastify();
const calls: GenParams[] = [];
let behavior: 'normal' | 'error' | 'wait' = 'normal';
let release: (() => void) | undefined;
let entered: (() => void) | undefined;
let modelName = 'mock';
const queue = new GenerationQueue(1);
const model = {
  stream: async (p: GenParams, cb: (text: string) => void) => {
    calls.push(p); cb('SIDEOUTPUT\n<th'); cb('ink>SECRET_REASON'); entered?.();
    if (behavior === 'wait') await new Promise<void>((resolve, reject) => { release = resolve; p.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
    if (behavior === 'error') throw new Error('INTERNAL_SERVER_DETAIL');
    cb('</think>\n요약 내용');
    return { text: 'SIDEOUTPUT\n<think>SECRET_REASON</think>\n요약 내용', usage: null, finishReason: 'stop', ttftMs: 1, totalMs: 1 };
  },
};
const ctx = { db, model, queue, log: app.log, resolvedModel: () => modelName } as unknown as Ctx;
for (const routes of [characterRoutes, conversationRoutes, memoryRoutes, searchRoutes, sideModeRoutes]) app.register(routes(ctx));
let n = 0;
async function test(label: string, fn: () => Promise<void> | void) { await fn(); console.log(`ok ${++n} ${label}`); }
const req = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, payload });
const conv = (id: string) => one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id = ?', id)!;
const events = (body: string) => body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));

async function main() {
try {
  db.prepare(`INSERT INTO model_profiles (name, temperature, top_p, max_tokens, stop_json, system_mode) VALUES ('rp-balanced', .8, .95, 400, '[]', 'system')`).run();
  const character = (await req('POST', '/api/characters', { name: '나리', first_message: '' })).json();
  const room = (await req('POST', '/api/conversations', { characterId: character.id })).json();
  const root = insertMessage(db, room.id, null, 'user', 'PUBLIC_ROOT', 'complete', {});
  const leaf = insertMessage(db, room.id, root.id, 'assistant', 'PUBLIC_STORY', 'complete', {});
  setHead(db, room.id, leaf.id);
  run(db, 'UPDATE conversations SET scene_json = ?, ended_at = ? WHERE id = ?', JSON.stringify({ place: '학교', clock_minutes: 120, turn_no: 7, info: { goals: ['미해결'] } }), nowIso(), room.id);
  const state = () => ({ conversation: conv(room.id), memories: db.prepare('SELECT * FROM memories').all(), summaries: db.prepare('SELECT * FROM summaries').all(), log: db.prepare('SELECT * FROM generation_log').all() });
  const before = state();
  let sideId = '';

  await test('ended-room side summary streams and persists without advancing any main state', async () => {
    const response = await req('POST', `/api/conversations/${room.id}/side-mode`, { mode: 'summary', prompt: '부상과 약속 정리' });
    assert.equal(response.statusCode, 200);
    const stream = events(response.body);
    assert.deepEqual(stream.map(event => event.type), ['start', 'token', 'token', 'token', 'done']);
    const start = stream[0], done = stream.at(-1);
    sideId = done.message.id;
    assert.equal(start.messageId, sideId);
    assert.equal(done.message.meta.generation_id, start.generationId);
    assert.deepEqual(done.message.meta.side_mode, { mode: 'summary', prompt: '부상과 약속 정리', anchor_message_id: leaf.id });
    assert.equal(done.message.status, 'complete');
    assert.equal(done.message.eventVersion, 1);
    assert.ok(!response.body.includes('SECRET_REASON'));
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM messages WHERE id = ?').get(sideId)).includes('SECRET_REASON'));
    assert.equal(done.budget.reply_reserve, 1664);
    assert.deepEqual(state(), before);
    assert.equal(queue.activeList.length, 0);
    assert.deepEqual(getPath(db, conv(room.id)).map(row => row.id), [root.id, leaf.id]);
  });

  await test('side rows never become swipe siblings, latest leaves, selected heads or search matches', async () => {
    assert.equal(deepestLeaf(db, root.id), leaf.id);
    assert.deepEqual(messageOut(db, leaf).siblings.ids, [leaf.id]);
    assert.throws(() => setHead(db, room.id, sideId), /부가 모드/);
    assert.equal((await req('POST', `/api/messages/${sideId}/select`)).statusCode, 409);
    assert.deepEqual((await req('GET', '/api/search?q=SIDEOUTPUT')).json().results, []);
    assert.deepEqual((await req('GET', '/api/search?q=SI')).json().results, []);
    assert.equal((await req('POST', '/api/memories', { conversationId: room.id, content: 'side memory', evidenceMessageIds: [sideId] })).statusCode, 400);
    const preview = await req('GET', `/api/conversations/${room.id}/prompt-preview`);
    assert.equal(preview.statusCode, 200);
    assert.ok(!preview.body.includes('SIDEOUTPUT'));
  });

  await test('side output follows its saved ancestor only and direct message reads enforce branch scope', async () => {
    assert.equal((await req('GET', `/api/conversations/${room.id}/side-mode`)).json().length, 1);
    const sibling = insertMessage(db, room.id, root.id, 'assistant', 'OTHER_BRANCH', 'complete', {});
    setHead(db, room.id, sibling.id);
    assert.deepEqual((await req('GET', `/api/conversations/${room.id}/side-mode`)).json(), []);
    assert.equal((await req('GET', `/api/messages/${sideId}`)).statusCode, 404);
    setHead(db, room.id, leaf.id);
    const child = insertMessage(db, room.id, leaf.id, 'user', 'LATER_MAIN', 'complete', {});
    setHead(db, room.id, child.id);
    assert.equal((await req('GET', `/api/conversations/${room.id}/side-mode`)).json()[0].id, sideId);
    setHead(db, room.id, leaf.id);
  });

  await test('empty-room side result never appears on a newly created main branch', async () => {
    const empty = (await req('POST', '/api/conversations', { characterId: character.id })).json();
    await req('POST', `/api/conversations/${empty.id}/side-mode`, { mode: 'community' });
    assert.equal((await req('GET', `/api/conversations/${empty.id}/side-mode`)).json().length, 1);
    const first = insertMessage(db, empty.id, null, 'user', 'FIRST', 'complete', {}); setHead(db, empty.id, first.id);
    assert.deepEqual((await req('GET', `/api/conversations/${empty.id}/side-mode`)).json(), []);
    assert.deepEqual(messageOut(db, first).siblings.ids, [first.id]);
    await req('DELETE', `/api/messages/${first.id}`);
    assert.equal(conv(empty.id).head_message_id, null, 'deleting the root cannot select a side sibling');
  });

  await test('invalid requests, busy room and missing model refuse without rows or model calls', async () => {
    const count = calls.length, rows = db.prepare('SELECT COUNT(*) AS n FROM messages').get();
    for (const payload of [{ mode: 'bad' }, { mode: 'summary', prompt: 'x'.repeat(2001) }, { mode: 'summary', anchor_message_id: root.id }]) {
      assert.equal((await req('POST', `/api/conversations/${room.id}/side-mode`, payload)).statusCode, 400);
    }
    assert.equal((await req('POST', '/api/conversations/missing/side-mode', { mode: 'summary' })).statusCode, 404);
    queue.register({ id: 'busy', conversationId: room.id, messageId: '', startedAt: nowIso(), controller: new AbortController() });
    assert.equal((await req('POST', `/api/conversations/${room.id}/side-mode`, { mode: 'summary' })).statusCode, 409);
    queue.unregister('busy'); modelName = '';
    assert.equal((await req('POST', `/api/conversations/${room.id}/side-mode`, { mode: 'summary' })).statusCode, 503);
    modelName = 'mock';
    assert.equal(calls.length, count); assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM messages').get(), rows);
  });

  await test('active side job remains visible, blocks main mutation and aborts to interrupted', async () => {
    behavior = 'wait'; const ready = new Promise<void>(resolve => { entered = resolve; });
    const pending = req('POST', `/api/conversations/${room.id}/side-mode`, { mode: 'community' });
    await ready;
    const active = queue.activeList[0]; assert.equal(active.kind, 'side-mode'); assert.ok(active.messageId);
    assert.equal((await req('GET', `/api/conversations/${room.id}`)).json().activeGeneration, null);
    assert.equal((await req('GET', `/api/conversations/${room.id}/side-mode`)).json().at(-1).status, 'streaming');
    assert.equal((await req('POST', `/api/messages/${root.id}/select`)).statusCode, 409);
    assert.equal((await req('DELETE', `/api/conversations/${room.id}`)).statusCode, 409);
    assert.equal((await req('POST', `/api/conversations/${room.id}/summarize`)).statusCode, 409);
    queue.abort(active.id);
    const stream = events((await pending).body);
    assert.equal(stream.at(-1).message.status, 'interrupted');
    assert.equal(stream.at(-1).message.meta.finish_reason, 'aborted');
    assert.equal(queue.activeList.length, 0);
    behavior = 'normal'; entered = undefined;
  });

  await test('queued side job abort never reaches the model and queue remains usable', async () => {
    let unlock!: () => void;
    const blocker = queue.run(() => new Promise<void>(resolve => { unlock = resolve; }));
    const count = calls.length;
    const pending = req('POST', `/api/conversations/${room.id}/side-mode`, { mode: 'summary' });
    for (let i = 0; i < 100 && queue.activeList.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(queue.queued, 1); queue.abort(queue.activeList[0].id);
    const stream = events((await pending).body);
    assert.equal(stream.at(-1).message.status, 'interrupted');
    assert.equal(calls.length, count); assert.equal(queue.queued, 0);
    unlock(); await blocker;
    assert.equal(await queue.run(async () => 'ready'), 'ready');
  });

  await test('model failure emits generic error, persists partial row, preserves main state', async () => {
    behavior = 'error'; const prior = state();
    const response = await req('POST', `/api/conversations/${room.id}/side-mode`, { mode: 'summary' });
    const last = events(response.body).at(-1);
    assert.equal(last.type, 'error'); assert.ok(!response.body.includes('INTERNAL_SERVER_DETAIL'));
    const row = (await req('GET', `/api/conversations/${room.id}/side-mode`)).json().find((row: any) => row.id === last.messageId);
    assert.equal(row.status, 'error'); assert.deepEqual(state(), prior); assert.equal(queue.activeList.length, 0);
    behavior = 'normal';
  });

  await test('public community excludes whispers and derived secret memories before budget selection', async () => {
    const secret = insertMessage(db, room.id, leaf.id, 'user', 'SECRET_WHISPER'.repeat(300), 'complete', { observation: { visibility: 'private', recipient_ids: ['user', character.id], observer_ids: [] } });
    const gm = insertMessage(db, room.id, secret.id, 'user', 'GM_ONLY_SECRET', 'complete', { observation: { visibility: 'private', recipient_ids: ['user', 'gm'], observer_ids: [] } });
    const last = insertMessage(db, room.id, gm.id, 'user', 'PUBLIC_END', 'complete', {}); setHead(db, room.id, last.id);
    await req('POST', '/api/memories', { conversationId: room.id, content: 'DERIVED_PRIVATE_FACT', evidenceMessageIds: [secret.id] });
    await req('POST', '/api/memories', { conversationId: room.id, content: 'APPROVED_PUBLIC_FACT', evidenceMessageIds: [root.id] });
    run(db, `INSERT INTO summaries (id, conversation_id, content, covers_from_message_id, covers_until_message_id, status, tier, created_at) VALUES (?, ?, ?, ?, ?, 'approved', 'whole', ?)`, uid(), room.id, 'AGGREGATED_SECRET', root.id, last.id, nowIso());
    for (const mode of ['summary', 'community'] as const) {
      const built = buildSideModePrompt(db, conv(room.id), mode, '', 4096);
      const body = JSON.stringify(built.messages);
      assert.ok(!body.includes('SECRET_WHISPER')); assert.ok(!body.includes('DERIVED_PRIVATE_FACT')); assert.ok(!body.includes('AGGREGATED_SECRET'));
      assert.ok(body.includes('APPROVED_PUBLIC_FACT')); assert.ok(body.includes('PUBLIC_ROOT')); assert.ok(body.includes('PUBLIC_END'));
      assert.equal(body.includes('GM_ONLY_SECRET'), mode === 'summary');
      assert.ok(built.budget.est_total + built.budget.reply_reserve <= 4096);
    }
  });

  await test('same-session output cannot recursively enter a later side prompt and orphan rows recover', async () => {
    const before = JSON.stringify(buildSideModePrompt(db, conv(room.id), 'summary', '', 4096).messages);
    await req('POST', `/api/conversations/${room.id}/side-mode`, { mode: 'summary' });
    assert.equal(JSON.stringify(buildSideModePrompt(db, conv(room.id), 'summary', '', 4096).messages), before);
    const current = (await req('GET', `/api/conversations/${room.id}/side-mode`)).json().at(-1);
    run(db, "UPDATE messages SET status = 'streaming' WHERE id = ?", current.id);
    const recovered = (await req('GET', `/api/conversations/${room.id}/side-mode`)).json().find((row: any) => row.id === current.id);
    assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.meta.finish_reason, 'orphan-streaming');
  });
  await test('budget refusal occurs before insertion or model calls', async () => {
    const prior = db.prepare('SELECT COUNT(*) AS n FROM messages').get(), count = calls.length;
    const originalLimit = config.model.contextTokens;
    try {
      config.model.contextTokens = 2048;
      const refused = await req('POST', `/api/conversations/${room.id}/side-mode`, { mode: 'summary', prompt: '긴'.repeat(2000) });
      assert.equal(refused.statusCode, 422);
      assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM messages').get(), prior);
      assert.equal(calls.length, count);
    } finally { config.model.contextTokens = originalLimit; }
  });
  await test('branch assignments and aggregate provenance cannot republish private memories', async () => {
    const makeMemory = async (content: string) => (await req('POST', '/api/memories?confirm=1', { conversationId: room.id, content, evidenceMessageIds: [root.id] })).json();
    const pub = await makeMemory('ASSIGNED_PUBLIC');
    const secret = await makeMemory('ASSIGNED_NPC_SECRET');
    const off = await makeMemory('OFFBRANCH_FACT');
    const oldScene = JSON.parse(conv(room.id).scene_json);
    const sibling = insertMessage(db, room.id, root.id, 'assistant', 'unused', 'complete', {});
    const entries = [
      { memory_id: pub.id, anchor_message_id: root.id, known_by: 'public', status: 'active', kind: 'fact' },
      { memory_id: secret.id, anchor_message_id: root.id, known_by: [character.id], status: 'active', kind: 'fact' },
      { memory_id: off.id, anchor_message_id: sibling.id, known_by: 'public', status: 'active', kind: 'fact' },
    ];
    run(db, 'UPDATE conversations SET scene_json = ? WHERE id = ?', JSON.stringify({ ...oldScene, dialog_context: { version: 1, entries } }), room.id);
    run(db, `INSERT INTO summaries (id, conversation_id, content, covers_from_message_id, covers_until_message_id, status, tier, created_at) VALUES (?, ?, ?, ?, ?, 'approved', 'whole', ?)`, uid(), room.id, 'SAFE_APPROVED_SUMMARY', root.id, leaf.id, nowIso());
    for (const mode of ['summary', 'community'] as const) {
      const body = JSON.stringify(buildSideModePrompt(db, conv(room.id), mode, '', 10000).messages);
      assert.ok(body.includes('ASSIGNED_PUBLIC')); assert.ok(body.includes('SAFE_APPROVED_SUMMARY'));
      assert.ok(!body.includes('ASSIGNED_NPC_SECRET')); assert.ok(!body.includes('OFFBRANCH_FACT'));
    }
    run(db, 'UPDATE conversations SET scene_json = ? WHERE id = ?', JSON.stringify({ ...oldScene, dialog_context: { version: 0, entries } }), room.id);
    const body = JSON.stringify(buildSideModePrompt(db, conv(room.id), 'community', '', 10000).messages);
    assert.ok(!body.includes('ASSIGNED_NPC_SECRET')); assert.ok(!body.includes('ASSIGNED_PUBLIC'), 'invalid assignment fails closed');
    run(db, 'UPDATE conversations SET scene_json = ? WHERE id = ?', JSON.stringify(oldScene), room.id);
  });
  console.log(`# ${n} side-mode checks passed`);
} finally {
  release?.(); await app.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true });
}

}
main().catch(err => { console.error(err); process.exitCode = 1; });
