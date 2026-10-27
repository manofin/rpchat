import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openMigratedDb, type DB } from '../apps/server/src/db/index.js';
import { insertMessage, setHead } from '../apps/server/src/db/tree.js';
import { provenanceReader } from '../apps/server/src/memory/provenance.js';
import { fixtureProvenance } from './helpers/derivedProvenanceFixture.js';
import type { SummaryRow } from '../apps/server/src/types.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-graph-'));
const db = openMigratedDb(temp, path.resolve('apps/server/migrations'));
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const PUBLIC = { visibility: 'public' };
const privateToA = { visibility: 'private' as const, recipient_ids: ['a', 'user'], observer_ids: [] };
const row = (id: string) => db.prepare('SELECT * FROM summaries WHERE id=?').get(id) as SummaryRow;
let count = 0;
function check(label: string, run: () => void) { run(); console.log(`ok ${++count} ${label}`); }
function node(id: string, parents: string[]) {
  const content = `SUMMARY_${id}`;
  const inputs = parents.map(id => { const source = row(id); return { kind: 'summary', id, conversation_id: source.conversation_id,
    content_sha256: hash(source.content), projection_sha256: hash(source.content), provenance_sha256: hash(source.input_provenance_json!), audience: privateToA }; });
  db.prepare(`INSERT INTO summaries(id,conversation_id,content,status,tier,created_at,input_provenance_json) VALUES(?,'room',?,'approved','whole','2026',?)`)
    .run(id, content, JSON.stringify({ version: 1, basis: 'generated', content_sha256: hash(content), ceiling: PUBLIC, inputs }));
}
try {
  db.exec(`INSERT INTO characters(id,name,created_at,updated_at) VALUES('a','인물','2026','2026');
    INSERT INTO conversations(id,character_id,profile_name,prompt_version,created_at,updated_at) VALUES('room','a','default','test','2026','2026')`);
  const source = insertMessage(db, 'room', null, 'user', 'PRIVATE_GRAPH_ROOT', 'complete', { observation: privateToA }); setHead(db, 'room', source.id);
  db.exec(`INSERT INTO summaries(id,conversation_id,content,status,tier,created_at) VALUES('root','room','PRIVATE_ROOT_SUMMARY','approved','whole','2026')`);
  fixtureProvenance(db, 'summary', 'root', [source.id]);
  let previous = 'root';
  for (let i = 1; i <= 160; i++) { const id = `chain-${i}`; node(id, [previous]); previous = id; }
  check('127, 128, 129 and 160 generations retain private authorization without a depth cutoff', () => {
    for (const n of [127, 128, 129, 160]) {
      const reader = provenanceReader(db);
      assert.equal(reader.canUse(row(`chain-${n}`), 'summary', privateToA), true);
      assert.equal(reader.canUse(row(`chain-${n}`), 'summary'), false, 'a forged public ceiling cannot widen source permissions');
    }
  });
  let parents = ['root'];
  for (let layer = 0; layer < 20; layer++) {
    const next = [`diamond-${layer}-a`, `diamond-${layer}-b`];
    for (const id of next) node(id, parents);
    parents = next;
  }
  check('shared dependency DAG is queried linearly and the reader reuses cached dependencies', () => {
    let queries = 0;
    const tracked = new Proxy(db, { get(target, property) {
      if (property === 'prepare') return (...args: [string]) => { queries++; return target.prepare(...args); };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } }) as DB;
    const reader = provenanceReader(tracked);
    assert.equal(reader.canUse(row(parents[0]), 'summary', privateToA), true);
    const first = queries;
    assert.ok(first < 100, `expected linear graph reads, got ${first}`);
    for (let i = 0; i < 10; i++) assert.equal(reader.canUse(row(parents[0]), 'summary', privateToA), true);
    assert.equal(queries, first, 'same synchronous snapshot reuses provenance');
    console.log(`GRAPH_QUERIES=${queries}`);
  });
  check('new request sees source withdrawal and restoration through a long chain', () => {
    db.prepare("UPDATE summaries SET status='draft' WHERE id='root'").run();
    assert.equal(provenanceReader(db).canUse(row('chain-160'), 'summary', privateToA), false);
    db.prepare("UPDATE summaries SET status='approved' WHERE id='root'").run();
    assert.equal(provenanceReader(db).canUse(row('chain-160'), 'summary', privateToA), true);
    db.prepare('UPDATE messages SET content=? WHERE id=?').run('EDITED_SOURCE', source.id);
    assert.equal(provenanceReader(db).canUse(row(parents[0]), 'summary', privateToA), false);
  });
  console.log(`PASSED ${count} checks`);
} finally { db.close(); fs.rmSync(temp, { recursive: true, force: true }); }
