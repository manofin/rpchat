/**
 * npm run test:benches -- pathMemorySchema --output-dir <new-evidence-dir>
 * Temporary DATA_DIR only. No live DB, model, or network.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openMigratedDb, one, run, uid, nowIso, type DB } from '../apps/server/src/db/index.js';
import { appendEvent, eventsPage, stateToken } from '../apps/server/src/db/pathMemoryLedger.js';
import { mainMessageSql } from '../apps/server/src/db/sideMode.js';
import { deepestLeaf, getPath, getStructuralPath, insertMessage, setHead } from '../apps/server/src/db/tree.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { searchRoutes } from '../apps/server/src/routes/search.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { ConversationRow } from '../apps/server/src/types.js';

const root = path.resolve('apps/server/migrations');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-path-memory-schema-'));
const db = openMigratedDb(dir, root);
const app = Fastify();
app.register(conversationRoutes({ db, queue: { activeList: [] } } as unknown as Ctx));
app.register(searchRoutes({ db } as unknown as Ctx));
let n = 0;
async function test(label: string, fn: () => Promise<void> | void) { await fn(); console.log(`ok ${++n} ${label}`); }
const convOf = (id: string) => one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id = ?', id)!;

function seed(id = uid()): ConversationRow {
  const character = uid();
  run(db, `INSERT INTO characters (id, name, created_at, updated_at) VALUES (?, 'c', ?, ?)`, character, nowIso(), nowIso());
  run(db, `INSERT INTO conversations (id, character_id, profile_name, prompt_version, title, created_at, updated_at) VALUES (?, ?, 'rp-balanced', 'p', 't', ?, ?)`, id, character, nowIso(), nowIso());
  return convOf(id);
}
function msg(conv: string, parent: string | null, role: 'user' | 'assistant' | 'memory-anchor', content: string, meta = '{}') {
  const id = uid();
  run(db, `INSERT INTO messages (id, conversation_id, parent_id, role, content, status, meta_json, created_at) VALUES (?, ?, ?, ?, ?, 'complete', ?, ?)`, id, conv, parent, role, content, meta, nowIso());
  return id;
}
function event(conv: string, anchor: string | null, sources: string[], key = uid()) {
  return appendEvent(db, {
    id: uid(), conversation_id: conv, node_id: 'n', proposal_id: 'p', action: 'accept', change: 'create',
    anchor_message_id: anchor, expected_revision: 1, idempotency_key: key, payload_hash: 'h', schema_version: 1,
    payload_json: '{}', recorded_by: 'test', created_at: nowIso(),
  }, sources);
}

async function main() {
  await test('migrations 0001-0025 and both ledger tables', () => {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'path_memory%'`).all();
    assert.equal(tables.length, 2);
    assert.equal(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM schema_migrations')!.n, 25);
  });

  await test('S3 message FK blocks partial delete; conversation delete cascades', () => {
    const conv = seed();
    const ancestor = msg(conv.id, null, 'user', 'ancestor');
    const anchor = msg(conv.id, ancestor, 'memory-anchor', 'anchor', JSON.stringify({ memory_anchor: { kind: 'approved' } }));
    const source = msg(conv.id, anchor, 'assistant', 'source');
    event(conv.id, anchor, [source]);
    const before = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM messages')!.n;
    assert.throws(() => run(db, 'DELETE FROM messages WHERE id = ?', anchor));
    assert.throws(() => run(db, 'DELETE FROM messages WHERE id = ?', source));
    assert.throws(() => run(db, 'DELETE FROM messages WHERE id = ?', ancestor));
    assert.equal(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM messages')!.n, before);
    run(db, 'DELETE FROM conversations WHERE id = ?', conv.id);
    assert.equal(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM path_memory_events WHERE conversation_id = ?', conv.id)!.n, 0);
  });

  await test('conversation without ledger deletes as before', () => {
    const conv = seed();
    const id = msg(conv.id, null, 'user', 'plain');
    run(db, 'DELETE FROM messages WHERE id = ?', id);
    run(db, 'DELETE FROM conversations WHERE id = ?', conv.id);
    assert.equal(one(db, 'SELECT id FROM conversations WHERE id = ?', conv.id), undefined);
  });

  await test('internal anchor is absent from siblings, leaf, and search', async () => {
    const conv = seed();
    const user = msg(conv.id, null, 'user', 'visible user');
    const anchor = msg(conv.id, user, 'memory-anchor', 'SECRET_ANCHOR', JSON.stringify({ memory_anchor: { kind: 'approved' } }));
    const reply = msg(conv.id, anchor, 'assistant', 'visible reply');
    setHead(db, conv.id, reply);
    const siblings = db.prepare(`SELECT id FROM messages WHERE conversation_id = ? AND parent_id = ? AND ${mainMessageSql()} ORDER BY created_at, id`).all(conv.id, user) as { id: string }[];
    assert.deepEqual(siblings.map(row => row.id), []);
    assert.equal(deepestLeaf(db, anchor), reply);
    const found = await app.inject({ method: 'GET', url: '/api/search?q=SECRET_ANCHOR' });
    assert.equal(found.body.includes('SECRET_ANCHOR'), false);
  });

  await test('setHead allows anchor and rejects side-mode', () => {
    const conv = seed();
    const anchor = msg(conv.id, null, 'memory-anchor', '', JSON.stringify({ memory_anchor: { kind: 'approved' } }));
    setHead(db, conv.id, anchor);
    const side = msg(conv.id, null, 'assistant', 'side', JSON.stringify({ side_mode: { mode: 'summary', prompt: 'p', anchor_message_id: null } }));
    assert.throws(() => setHead(db, conv.id, side));
  });

  await test('structural path differs from display path only by anchors', () => {
    const conv = seed();
    const user = msg(conv.id, null, 'user', 'u');
    const anchor = msg(conv.id, user, 'memory-anchor', '', JSON.stringify({ memory_anchor: { kind: 'approved' } }));
    setHead(db, conv.id, anchor);
    const structural = getStructuralPath(db, convOf(conv.id)).map(row => row.id);
    const display = getPath(db, convOf(conv.id)).map(row => row.id);
    assert.deepEqual(structural.filter(id => id !== anchor), display);
  });

  await test('idempotency is unique per conversation; pages cover 257 events', () => {
    const a = seed(), b = seed();
    event(a.id, null, [], 'same');
    assert.throws(() => event(a.id, null, [], 'same'));
    event(b.id, null, [], 'same');
    for (let i = 0; i < 257; i++) event(a.id, null, [], `k${i}`);
    const all = eventsPage(db, a.id, 0, 1000);
    const paged = [...eventsPage(db, a.id, 0, 100), ...eventsPage(db, a.id, all[99].sequence, 100), ...eventsPage(db, a.id, all[199].sequence, 100)];
    assert.equal(paged.length, all.length);
  });

  await test('state token changes with head and sequence', () => {
    const conv = seed();
    const first = stateToken(db, conv.id, 'h1');
    assert.equal(stateToken(db, conv.id, 'h1'), first);
    assert.notEqual(stateToken(db, conv.id, 'h2'), first);
    event(conv.id, null, []);
    assert.notEqual(stateToken(db, conv.id, 'h1'), first);
  });

  await test('protected delete is 409; ledgerless delete matches current response', async () => {
    const conv = seed();
    const anchor = msg(conv.id, null, 'memory-anchor', '', JSON.stringify({ memory_anchor: { kind: 'approved' } }));
    event(conv.id, anchor, [anchor]);
    const blocked = await app.inject({ method: 'DELETE', url: `/api/messages/${anchor}` });
    assert.equal(blocked.statusCode, 409);
    assert.equal(JSON.parse(blocked.body).error, 'protected-memory-ancestor');
    const plain = seed();
    const id = msg(plain.id, null, 'user', 'plain');
    setHead(db, plain.id, id);
    const allowed = await app.inject({ method: 'DELETE', url: `/api/messages/${id}` });
    assert.equal(allowed.statusCode, 200);
  });
}
main();
