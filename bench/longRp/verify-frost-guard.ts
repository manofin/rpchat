/**
 * Live-DB check that run-long-rp.ts frost guard matches 서리 character_id
 * and would refuse every frost conversation. No generate. No writes.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const SRC = path.join(path.dirname(new URL(import.meta.url).pathname), 'run-long-rp.ts');
const DB_PATH = process.env.RPCHAT_DB ?? '/home/hermes/rpchat/data/rpchat.db';

const src = fs.readFileSync(SRC, 'utf8');
const m = src.match(/const FROST_CHARACTER_ID = '([0-9a-f-]{36})'/);
if (!m) {
  console.error('FROST_GUARD_FAIL missing FROST_CHARACTER_ID');
  process.exit(1);
}
const pinned = m[1];
if (src.includes('const FROST_ID =')) {
  console.error('FROST_GUARD_FAIL leftover FROST_ID');
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });
const frost = db.prepare("SELECT id, name FROM characters WHERE name = '서리'").get() as
  | { id: string; name: string }
  | undefined;
if (!frost) {
  console.error('FROST_GUARD_FAIL no character named 서리');
  process.exit(1);
}
const convs = db
  .prepare('SELECT id FROM conversations WHERE character_id = ?')
  .all(frost.id) as Array<{ id: string }>;
const msgN = db
  .prepare(
    `SELECT count(*) AS n FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE c.character_id = ?`,
  )
  .get(frost.id) as { n: number };
db.close();

if (pinned !== frost.id) {
  console.error('FROST_GUARD_FAIL pinned', pinned, 'live', frost.id);
  process.exit(1);
}
if (convs.length === 0) {
  console.error('FROST_GUARD_FAIL no frost conversations');
  process.exit(1);
}

console.log(
  JSON.stringify({
    FROST_GUARD_OK: true,
    character_id: frost.id,
    frost_conversations: convs.length,
    frost_messages: msgN.n,
  }),
);
