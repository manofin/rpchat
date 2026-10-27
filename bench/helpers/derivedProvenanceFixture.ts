import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DB } from '../../apps/server/src/db/index.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** Explicit synthetic past-generation receipt, independent of the production writer/reader.
 * Never use this helper to backfill real records or a legacy-withholding scenario. */
export function fixtureProvenance(db: DB, kind: 'memory' | 'summary', id: string, sourceIds: string[]) {
  const table = kind === 'memory' ? 'memories' : 'summaries';
  const row = db.prepare(`SELECT content FROM ${table} WHERE id=?`).get(id) as { content: string };
  assert.ok(row); assert.ok(sourceIds.length);
  const inputs = sourceIds.map(sourceId => {
    const m = db.prepare('SELECT * FROM messages WHERE id=?').get(sourceId) as any;
    assert.ok(m); assert.equal(m.status, 'complete');
    const audience = JSON.parse(m.meta_json).observation ?? { visibility: 'public' };
    return { kind: 'message', id: m.id, conversation_id: m.conversation_id, content_sha256: hash(m.content),
      projection_sha256: hash(m.content), provenance_sha256: null, audience };
  });
  const privateInputs = inputs.filter(s => s.audience.visibility === 'private');
  const ceiling = privateInputs.length ? { visibility: 'private', observer_ids: [],
    recipient_ids: privateInputs[0].audience.recipient_ids.filter((id: string) => privateInputs.every(s => s.audience.recipient_ids.includes(id))) } : { visibility: 'public' };
  const receipt = { version: 1, basis: 'generated', content_sha256: hash(row.content), ceiling, inputs };
  db.prepare(`UPDATE ${table} SET input_provenance_json=? WHERE id=?`).run(JSON.stringify(receipt), id);
}
