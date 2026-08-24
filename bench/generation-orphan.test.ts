/**
 * interruptOrphanStreaming 단위 테스트. 실행:
 *   npx tsx bench/generation-orphan.test.ts
 * 라이브 DB 무접촉.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { interruptOrphanStreaming } from '../apps/server/src/db/generation.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

function openTemp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-orphan-'));
  const db = new Database(path.join(dir, 't.db'));
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      parent_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      meta_json TEXT NOT NULL DEFAULT '{}',
      bookmarked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);
  return { db, dir };
}

function insert(db: Database.Database, id: string, status: string, createdAt: string) {
  db.prepare(
    `INSERT INTO messages (id, conversation_id, parent_id, role, content, status, meta_json, bookmarked, created_at)
     VALUES (?, 'c1', NULL, 'assistant', 'partial', ?, '{}', 0, ?)`,
  ).run(id, status, createdAt);
}

const old = '2020-01-01T00:00:00.000Z';
const fresh = new Date().toISOString();

{
  const { db, dir } = openTemp();
  insert(db, 'live', 'streaming', old);
  insert(db, 'orphan', 'streaming', old);
  insert(db, 'done', 'complete', old);
  const n = interruptOrphanStreaming(db as never, { keepMessageIds: ['live'] });
  t('keep 은 유지, 고아만 interrupt', () => {
    assert.equal(n, 1);
    const rows = db.prepare('SELECT id, status FROM messages ORDER BY id').all() as { id: string; status: string }[];
    assert.deepEqual(rows, [
      { id: 'done', status: 'complete' },
      { id: 'live', status: 'streaming' },
      { id: 'orphan', status: 'interrupted' },
    ]);
  });
  const meta = db.prepare(`SELECT meta_json FROM messages WHERE id = 'orphan'`).get() as { meta_json: string };
  t('finish_reason orphan-streaming', () => {
    assert.equal(JSON.parse(meta.meta_json).finish_reason, 'orphan-streaming');
  });
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const { db, dir } = openTemp();
  insert(db, 'fresh', 'streaming', fresh);
  insert(db, 'stale', 'streaming', old);
  const n = interruptOrphanStreaming(db as never, { minAgeMs: 2000 });
  t('minAgeMs 는 신선한 streaming 을 건드리지 않음', () => {
    assert.equal(n, 1);
    assert.equal((db.prepare(`SELECT status FROM messages WHERE id = 'fresh'`).get() as { status: string }).status, 'streaming');
    assert.equal((db.prepare(`SELECT status FROM messages WHERE id = 'stale'`).get() as { status: string }).status, 'interrupted');
  });
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const { db, dir } = openTemp();
  insert(db, 'a', 'complete', old);
  const n = interruptOrphanStreaming(db as never);
  t('streaming 없으면 0', () => {
    assert.equal(n, 0);
  });
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`UNIT_OK ${passed}`);
