import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, applyMigrations } from '../apps/server/src/db/index.js';
import { insertMessage, setHead } from '../apps/server/src/db/tree.js';
import { provenanceReader } from '../apps/server/src/memory/provenance.js';
import type { MemoryRow, SummaryRow } from '../apps/server/src/types.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-migration-'));
const previous = path.join(temp, 'previous'); fs.mkdirSync(previous);
const current = path.resolve('apps/server/migrations');
for (const file of fs.readdirSync(current).filter(f => f.endsWith('.sql') && f < '0026_')) fs.copyFileSync(path.join(current, file), path.join(previous, file));
const db = openDb(path.join(temp, 'data'));
let checks = 0;
function check(label: string, fn: () => void) { fn(); console.log(`ok ${++checks} ${label}`); }
try {
  assert.equal(applyMigrations(db, previous).applied.length, 25);
  db.exec(`INSERT INTO characters(id,name,created_at,updated_at) VALUES('a','인물','2026','2026');
    INSERT INTO conversations(id,character_id,profile_name,prompt_version,created_at,updated_at) VALUES('room','a','default','test','2026','2026');
    INSERT INTO memories(id,conversation_id,content,source,status,importance,scope,evidence_message_ids_json,created_at,updated_at)
      VALUES('automatic','room','이전 자동 기억','model','pinned',3,'conversation','[]','2026','2026'),
      ('manual','room','직접 쓴 사실','user','pinned',3,'conversation','[]','2026','2026');
    INSERT INTO summaries(id,conversation_id,content,status,tier,created_at) VALUES('old','room','이전 요약 원문','approved','whole','2026')`);
  const message = insertMessage(db, 'room', null, 'user', '기존 대화 원문', 'complete'); setHead(db, 'room', message.id);
  const tables = ['conversations', 'messages', 'memories', 'summaries'];
  const before = tables.map(t => db.prepare(`SELECT * FROM ${t} ORDER BY id`).all());
  check('0025 to 0026 preserves every existing row and adds only null provenance', () => {
    assert.deepEqual(applyMigrations(db, current), { applied: ['0026_derived_provenance.sql'] });
    const after = tables.map(t => db.prepare(`SELECT * FROM ${t} ORDER BY id`).all().map((row: any) => {
      if (t === 'memories' || t === 'summaries') { assert.equal(row.input_provenance_json, null); delete row.input_provenance_json; }
      return row;
    }));
    assert.deepEqual(after, before);
    assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  });
  check('upgraded automatic records are readable but ineligible; manual memory stays usable', () => {
    const automatic = db.prepare("SELECT * FROM memories WHERE id='automatic'").get() as MemoryRow;
    const manual = db.prepare("SELECT * FROM memories WHERE id='manual'").get() as MemoryRow;
    const summary = db.prepare("SELECT * FROM summaries WHERE id='old'").get() as SummaryRow;
    assert.equal(automatic.content, '이전 자동 기억'); assert.equal(summary.content, '이전 요약 원문');
    const reader = provenanceReader(db);
    assert.equal(reader.canUse(automatic, 'memory'), false); assert.equal(reader.canUse(summary, 'summary'), false);
    assert.equal(reader.canUse(manual, 'memory'), true);
  });
  check('second migration application is a no-op and malformed JSON cannot be stored', () => {
    assert.deepEqual(applyMigrations(db, current), { applied: [] });
    for (const invalid of ['not-json', '[]', 'null', '42']) assert.throws(() => db.prepare("UPDATE memories SET input_provenance_json=? WHERE id='automatic'").run(invalid));
    assert.equal((db.prepare("SELECT input_provenance_json FROM memories WHERE id='automatic'").get() as any).input_provenance_json, null);
  });
  console.log(`PASSED ${checks} checks`);
} finally { db.close(); fs.rmSync(temp, { recursive: true, force: true }); }
