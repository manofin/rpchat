/** npm run test:benches -- pathMemoryP1Guards — actual routes, temporary DB, model must not be called. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { many, nowIso, one, openMigratedDb, run, uid } from '../apps/server/src/db/index.js';
import { getStructuralPath, getPath, setHead } from '../apps/server/src/db/tree.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { chatRoutes } from '../apps/server/src/routes/chat.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { ConversationRow, MessageRow } from '../apps/server/src/types.js';

const ANCHOR_META = JSON.stringify({ memory_anchor: { kind: 'approved' } });


let checks = 0;

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-path-memory-p1-guards-'));
  const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
  run(db, "INSERT INTO model_profiles(name,model,temperature,top_p,max_tokens,stop_json,system_mode) VALUES ('rp-balanced',NULL,0.8,0.95,800,'[]','system')");
  let modelCalls = 0;
  const queue = new GenerationQueue(1);
  const ctx = { db, queue, resolvedModel: () => 'mock', log: { warn() {}, error() {}, info() {}, debug() {} }, model: {
    // complete/stream count the call then throw immediately (model must not be called in any test here).
    complete: async () => { modelCalls++; throw new Error('P1 guard benches must not call the model'); },
    stream: async () => { modelCalls++; throw new Error('P1 guard benches must not call the model'); },
  } } as unknown as Ctx;
  const app = Fastify();
  for (const route of [characterRoutes, conversationRoutes, chatRoutes]) app.register(route(ctx));
  await app.ready();

  const test = async (name: string, fn: () => void | Promise<void>) => { await fn(); console.log(`ok ${++checks} ${name}`); };
  const convOf = (id: string) => one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id = ?', id)!;
  const rowOf = (id: string) => one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', id)!;

  let seq = 0;
  function seed(): ConversationRow {
    const id = `conv-${String(++seq).padStart(2, '0')}`;
    const character = `char-${id}`;
    run(db, `INSERT INTO characters (id, name, created_at, updated_at) VALUES (?, 'c', ?, ?)`, character, nowIso(), nowIso());
    run(db, `INSERT INTO conversations (id, character_id, profile_name, prompt_version, title, created_at, updated_at) VALUES (?, ?, 'rp-balanced', 'p', 't', ?, ?)`, id, character, nowIso(), nowIso());
    // dc25cf8 /api/conversations leaves head NULL unless a greeting is seeded; keep it NULL here.
    return convOf(id);
  }
  function msg(conv: string, parent: string | null, role: 'user' | 'assistant' | 'memory-anchor', content: string, meta = '{}') {
    const id = uid();
    run(db, `INSERT INTO messages (id, conversation_id, parent_id, role, content, status, meta_json, created_at) VALUES (?, ?, ?, ?, ?, 'complete', ?, ?)`, id, conv, parent, role, content, meta, nowIso());
    return id;
  }
  const snapshot = (convId: string) => ({
    head: convOf(convId).head_message_id,
    rows: many<{ id: string; parent_id: string | null; role: string; content: string; status: string; meta_json: string }>(db, 'SELECT id, parent_id, role, content, status, meta_json FROM messages WHERE conversation_id = ? ORDER BY id', convId),
    count: one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', convId)!.n,
  });

  async function fixture() {
    const c = seed();
    const user = msg(c.id, null, 'user', 'visible user');
    const assistant = msg(c.id, user, 'assistant', '"BASE_REPLY"');
    const anchor = msg(c.id, assistant, 'memory-anchor', 'approved anchor', ANCHOR_META);
    setHead(db, c.id, anchor);
    return { conv: c, user, assistant, anchor };
  }

  // 1. continue with body messageId=H -> 409 anchor guard; head=X, rows unchanged, model calls 0
  await test('continue rejects when the structural head is an anchor (messageId=H)', async () => {
    const f = await fixture();
    const before = snapshot(f.conv.id);
    const structural = getStructuralPath(db, convOf(f.conv.id));
    assert.deepEqual(new Set(structural.map(m => m.id)), new Set([f.user, f.assistant, f.anchor]));
    assert.equal(rowOf(f.anchor).parent_id, f.assistant);
    const path = getPath(db, convOf(f.conv.id));
    assert.deepEqual(path.map(m => m.id), [f.user, f.assistant]);
    const calls = modelCalls;
    const r = await app.inject({ method: 'POST', url: `/api/conversations/${f.conv.id}/continue`, payload: { messageId: f.assistant } });
    assert.equal(r.statusCode, 409, r.body);
    assert.deepEqual(JSON.parse(r.body), { error: '기억 승인 지점에서는 이어 쓸 수 없습니다.' });
    assert.equal(convOf(f.conv.id).head_message_id, f.anchor);
    assert.deepEqual(snapshot(f.conv.id), before);
    assert.equal(modelCalls, calls);
  });

  // 2. continue with body messageId=X -> same expectations as test 1
  await test('continue rejects when the structural head is an anchor (messageId=X)', async () => {
    const f = await fixture();
    const before = snapshot(f.conv.id);
    const calls = modelCalls;
    const r = await app.inject({ method: 'POST', url: `/api/conversations/${f.conv.id}/continue`, payload: { messageId: f.anchor } });
    assert.equal(r.statusCode, 409, r.body);
    assert.deepEqual(JSON.parse(r.body), { error: '기억 승인 지점에서는 이어 쓸 수 없습니다.' });
    assert.equal(convOf(f.conv.id).head_message_id, f.anchor);
    assert.deepEqual(snapshot(f.conv.id), before);
    assert.equal(modelCalls, calls);
  });

  await test('regenerate rejects the anchor itself; head and rows are unchanged', async () => {
    const f = await fixture();
    const before = snapshot(f.conv.id);
    const r = await app.inject({ method: 'POST', url: `/api/conversations/${f.conv.id}/regenerate`, payload: { messageId: f.anchor } });
    assert.equal(r.statusCode, 409, r.body);
    assert.deepEqual(JSON.parse(r.body), { error: '기억 승인 기록은 재생성할 수 없음' });
    assert.deepEqual(snapshot(f.conv.id), before);
    assert.equal(modelCalls, 0);
  });

  // 4. select X -> 409, head stays on X
  await test('select rejects the anchor as a branch target; head stays on the anchor', async () => {
    const f = await fixture();
    const before = snapshot(f.conv.id);
    const r = await app.inject({ method: 'POST', url: `/api/messages/${f.anchor}/select` });
    assert.equal(r.statusCode, 409, r.body);
    assert.deepEqual(JSON.parse(r.body), { error: '기억 승인 기록은 본편 분기로 선택할 수 없음' });
    assert.equal(convOf(f.conv.id).head_message_id, f.anchor);
    assert.deepEqual(snapshot(f.conv.id), before);
  });

  // 5. control: select H -> 200, head = H (deepestLeaf does not descend into anchor children; K2-b current behavior)
  await test('control: selecting H moves head to H without descending into the anchor child', async () => {
    const f = await fixture();
    const r = await app.inject({ method: 'POST', url: `/api/messages/${f.assistant}/select` });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(convOf(f.conv.id).head_message_id, f.assistant);
    assert.notEqual(convOf(f.conv.id).head_message_id, f.anchor);
  });

  // 6. control: U0 -> H -> X -> U (user, only child of X), head = U; DELETE U -> 2xx, head = X (general deletion current behavior)
  await test('control: deleting the plain user child of the anchor leaves head on the anchor', async () => {
    const f = await fixture();
    const u = msg(f.conv.id, f.anchor, 'user', 'plain user under the anchor');
    setHead(db, f.conv.id, u);
    const r = await app.inject({ method: 'DELETE', url: `/api/messages/${u}` });
    assert.ok(r.statusCode >= 200 && r.statusCode < 300, `${r.statusCode} ${r.body}`);
    assert.equal(convOf(f.conv.id).head_message_id, f.anchor);
  });

  // 7. malformed mark: Y = role memory-anchor with meta {} under H, head = Y; continue messageId=H -> not 2xx, head and rows unchanged.
  // Exact status code is NOT asserted (P3 error policy undecided); fail-closed via isMemoryAnchorMessage throwing is acceptable.
  await test('malformed anchor mark fails closed on continue without changing head or rows (status code not pinned)', async () => {
    const c = seed();
    const u0 = msg(c.id, null, 'user', 'U0');
    const h = msg(c.id, u0, 'assistant', 'H');
    const y = msg(c.id, h, 'memory-anchor', 'role without meta', '{}'); // role/meta disagree
    run(db, 'UPDATE conversations SET head_message_id = ? WHERE id = ?', y, c.id);
    const before = snapshot(c.id);
    const calls = modelCalls;
    const r = await app.inject({ method: 'POST', url: `/api/conversations/${c.id}/continue`, payload: { messageId: h } });
    assert.ok(r.statusCode < 200 || r.statusCode >= 300, `expected non-2xx, got ${r.statusCode} ${r.body}`);
    assert.deepEqual(snapshot(c.id), before); // head and rows unchanged
    assert.equal(modelCalls, calls);
  });

}

main().then(() => console.log(`done ${checks} checks`)).catch(e => { console.error(e); process.exitCode = 1; });
