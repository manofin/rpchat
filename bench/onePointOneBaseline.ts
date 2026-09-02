/** npx tsx bench/onePointOneBaseline.ts <db> [convId...]
 * F9 beat-engine 슬라이스 게이트: 1:1 경로의 system 블록 바이트 기준선.
 * 라이브 DB를 열지 않는다 — 인자로 받은 스냅샷 복사본만 읽는다. 쓰기 0. 모델 콜 0.
 * 출력: convId <tab> sha256(system) <tab> bytes
 */
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { DB } from '../apps/server/src/db/index.js';
import { one } from '../apps/server/src/db/index.js';
import { getPath } from '../apps/server/src/db/tree.js';
import { buildPrompt } from '../apps/server/src/prompt/builder.js';
import type { ConversationRow } from '../apps/server/src/types.js';

const [dbPath, ...ids] = process.argv.slice(2);
if (!dbPath) throw new Error('usage: onePointOneBaseline.ts <db-copy> [convId...]');

const db = new Database(dbPath, { readonly: true }) as unknown as DB;

const targets = ids.length
  ? ids
  : (db.prepare(`SELECT id FROM conversations WHERE story_id IS NULL ORDER BY id`).all() as { id: string }[]).map((r) => r.id);

for (const id of targets) {
  const conv = one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id = ?', id);
  if (!conv) { console.log(`${id}\tMISSING\t0`); continue; }
  const built = buildPrompt(db, conv, getPath(db, conv), 16384, 'baseline-model');
  const sys = built.messages.find((m) => m.role === 'system');
  if (!sys) { console.log(`${id}\tNO_SYSTEM\t0`); continue; }
  const bytes = Buffer.from(sys.content, 'utf8');
  console.log(`${id}\t${crypto.createHash('sha256').update(bytes).digest('hex')}\t${bytes.length}`);
}
