/** npm run test:benches -- pathMemoryDbProjection — display index, strict loader and DB guards; temporary DB, hand-written expected values, no model. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMigratedDb, one, run, uid, nowIso, type DB } from '../apps/server/src/db/index.js';
import { getPath, insertMessage, loadDisplayTree, readablePreview, updateMessage } from '../apps/server/src/db/tree.js';
import { buildDisplayIndex, type MessageTree } from '../apps/server/src/pathMemory/tree.js';
import type { ConversationRow, MessageRow } from '../apps/server/src/types.js';

const root = path.resolve('apps/server/migrations');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-path-memory-db-projection-'));
const db = openMigratedDb(dir, root);
let n = 0;
function test(label: string, fn: () => void) { fn(); console.log(`ok ${++n} ${label}`); }
const convOf = (id: string) => one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id = ?', id)!;
const ANCHOR_META = '{"memory_anchor":{"kind":"approved"}}';
const SIDE_META = '{"side_mode":{"mode":"summary","prompt":"p","anchor_message_id":null}}';

let clock = Date.parse('2026-10-14T00:00:00.000Z');
function stamp() {
  const value = new Date(clock).toISOString().slice(0, 23).replace('T', ' ');
  clock += 1;
  return value;
}
function seed(id = uid()): ConversationRow {
  const character = uid();
  run(db, `INSERT INTO characters (id, name, created_at, updated_at) VALUES (?, 'c', ?, ?)`, character, nowIso(), nowIso());
  run(db, `INSERT INTO conversations (id, character_id, profile_name, prompt_version, title, created_at, updated_at) VALUES (?, ?, 'rp-balanced', 'p', 't', ?, ?)`, id, character, nowIso(), nowIso());
  return convOf(id);
}
function msg(conv: string, parent: string | null, role: 'user' | 'assistant' | 'memory-anchor', content: string, meta = '{}') {
  const id = uid();
  run(db, `INSERT INTO messages (id, conversation_id, parent_id, role, content, status, meta_json, created_at) VALUES (?, ?, ?, ?, ?, 'complete', ?, ?)`, id, conv, parent, role, content, meta, stamp());
  return id;
}
function count(conv: string) {
  return one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', conv)!.n;
}
function row(id: string, parent: string | null, role: string, internal = false): MessageTree['rows'][number] {
  return { id, parent, role, status: 'complete', internal };
}
function throwsMessage(fn: () => unknown) {
  try { fn(); }
  catch (error) { return error instanceof Error ? error.message : String(error); }
  return undefined;
}

function main() {
  test('visible ancestor map keeps separate sibling branches', () => {
    const tree: MessageTree = { order: 'oldest-to-newest', rows: [
      row('u1', null, 'user'), row('h1', 'u1', 'assistant'), row('x1', 'h1', 'memory-anchor', true),
      row('x2', 'x1', 'memory-anchor', true), row('u2', 'x2', 'user'), row('v', 'h1', 'user'),
    ] };
    assert.deepEqual(Object.fromEntries(buildDisplayIndex(tree)), { u1: 'u1', h1: 'h1', x1: 'h1', x2: 'h1', u2: 'u2', v: 'v' });
    assert.equal(buildDisplayIndex(tree).get('x2'), 'h1');
  });

  test('an internal root has no visible ancestor', () => {
    assert.deepEqual(Object.fromEntries(buildDisplayIndex({ order: 'oldest-to-newest', rows: [row('x0', null, 'memory-anchor', true)] })), { x0: null });
  });

  test('a missing ancestor fails without a partial map', () => {
    assert.equal(throwsMessage(() => buildDisplayIndex({ order: 'oldest-to-newest', rows: [row('a', 'nope', 'user')] })), 'missing message ancestor');
  });

  test('a cycle anywhere fails without a partial map', () => {
    assert.equal(throwsMessage(() => buildDisplayIndex({ order: 'oldest-to-newest', rows: [row('a', 'b', 'user'), row('b', 'a', 'assistant')] })), 'cyclic message path');
  });

  test('duplicate ids fail before resolution', () => {
    assert.equal(throwsMessage(() => buildDisplayIndex({ order: 'oldest-to-newest', rows: [row('a', null, 'user'), row('a', null, 'assistant')] })), 'duplicate message ID');
  });

  test('strict loader excludes side mode and preserves internal marks', () => {
    const conv = seed();
    const u1 = msg(conv.id, null, 'user', 'U');
    const h1 = msg(conv.id, u1, 'assistant', 'H');
    const x1 = msg(conv.id, h1, 'memory-anchor', 'X1', ANCHOR_META);
    const x2 = msg(conv.id, x1, 'memory-anchor', 'X2', ANCHOR_META);
    const u2 = msg(conv.id, x2, 'user', 'U2');
    const v = msg(conv.id, h1, 'user', 'V');
    msg(conv.id, h1, 'assistant', 'S', SIDE_META);
    const loaded = loadDisplayTree(db, conv.id);
    assert.equal(loaded.order, 'oldest-to-newest');
    assert.deepEqual(loaded.rows.map(item => item.id), [u1, h1, x1, x2, u2, v]);
    assert.deepEqual(loaded.rows.filter(item => item.internal).map(item => item.id), [x1, x2]);
    assert.deepEqual(Object.fromEntries(buildDisplayIndex(loaded)), { [u1]: u1, [h1]: h1, [x1]: h1, [x2]: h1, [u2]: u2, [v]: v });
  });

  test('disagreeing anchor marks fail closed', () => {
    const conv = seed();
    msg(conv.id, null, 'memory-anchor', 'bad', '{}');
    assert.equal(throwsMessage(() => loadDisplayTree(db, conv.id)), 'memory anchor marks disagree');
  });

  test('a main parent pointing at side mode is a missing ancestor', () => {
    const conv = seed();
    const s = msg(conv.id, null, 'assistant', 'S', SIDE_META);
    msg(conv.id, s, 'user', 'W');
    assert.equal(throwsMessage(() => buildDisplayIndex(loadDisplayTree(db, conv.id))), 'missing message ancestor');
  });

  test('a parent in another conversation is a missing ancestor', () => {
    const first = seed();
    const foreign = msg(first.id, null, 'user', 'foreign');
    const second = seed();
    msg(second.id, foreign, 'assistant', 'child');
    assert.equal(throwsMessage(() => buildDisplayIndex(loadDisplayTree(db, second.id))), 'missing message ancestor');
  });

  test('existing path readers do not throw on the side-mode parent corruption', () => {
    const conv = seed();
    const s = msg(conv.id, null, 'assistant', 'S', SIDE_META);
    const w = msg(conv.id, s, 'user', 'W');
    run(db, 'UPDATE conversations SET head_message_id = ? WHERE id = ?', w, conv.id);
    assert.doesNotThrow(() => getPath(db, convOf(conv.id)));
  });

  test('anchor updates are rejected without changing stored bytes', () => {
    const conv = seed();
    const x = msg(conv.id, null, 'memory-anchor', 'X', ANCHOR_META);
    const before = one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', x)!;
    assert.equal(throwsMessage(() => updateMessage(db, x, { content: 'x' })), 'memory anchor rows cannot be updated');
    const after = one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', x)!;
    assert.equal(after.content, before.content);
    assert.equal(after.meta_json, before.meta_json);
    assert.equal(after.status, before.status);
    assert.equal(after.bookmarked, before.bookmarked);
  });

  test('ordinary assistant updates still change content', () => {
    const conv = seed();
    const h = msg(conv.id, null, 'assistant', 'old');
    updateMessage(db, h, { content: '새 본문' });
    assert.equal(one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', h)!.content, '새 본문');
  });

  test('anchor marks cannot be inserted on user rows', () => {
    const conv = seed();
    const before = count(conv.id);
    assert.equal(throwsMessage(() => insertMessage(db, conv.id, null, 'user', 'u', 'complete', { memory_anchor: { kind: 'approved' } })), 'memory anchor mark not allowed on user or assistant rows');
    assert.equal(count(conv.id), before);
  });

  test('ordinary user inserts still add one row', () => {
    const conv = seed();
    const before = count(conv.id);
    insertMessage(db, conv.id, null, 'user', 'u', 'complete', {});
    assert.equal(count(conv.id), before + 1);
  });

  test('preview skips anchors and reads the nearest visible ancestor', () => {
    const conv = seed();
    const u1 = msg(conv.id, null, 'user', 'U본문');
    const h1 = msg(conv.id, u1, 'assistant', 'H본문', '{}');
    const x1 = msg(conv.id, h1, 'memory-anchor', 'X1', ANCHOR_META);
    const x2 = msg(conv.id, x1, 'memory-anchor', 'X2', ANCHOR_META);
    assert.equal(readablePreview(db, x2), 'H본문');
  });

  test('preview of the visible assistant remains unchanged', () => {
    const conv = seed();
    const h1 = msg(conv.id, null, 'assistant', 'H본문', '{}');
    assert.equal(readablePreview(db, h1), 'H본문');
  });

  assert.equal(n, 16);
  db.close();
}

main();
