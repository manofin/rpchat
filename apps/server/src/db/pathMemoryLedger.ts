import { createHash } from 'node:crypto';
import { type DB, one, run } from './index.js';

export type LedgerEvent = {
  sequence: number;
  id: string;
  conversation_id: string;
  node_id: string;
  proposal_id: string;
  action: 'propose' | 'accept' | 'reject';
  change: 'create' | 'edit' | 'move' | 'close' | null;
  anchor_message_id: string | null;
  expected_revision: number;
  idempotency_key: string | null;
  payload_hash: string;
  schema_version: number;
  payload_json: string;
  recorded_by: string;
  created_at: string;
};

export function appendEvent(db: DB, event: Omit<LedgerEvent, 'sequence'>, sources: readonly string[]): LedgerEvent {
  run(db, `INSERT INTO path_memory_events (
    id, conversation_id, node_id, proposal_id, action, change, anchor_message_id,
    expected_revision, idempotency_key, payload_hash, schema_version, payload_json, recorded_by, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  event.id, event.conversation_id, event.node_id, event.proposal_id, event.action, event.change,
  event.anchor_message_id, event.expected_revision, event.idempotency_key, event.payload_hash,
  event.schema_version, event.payload_json, event.recorded_by, event.created_at);
  for (const messageId of sources) addSource(db, event.id, messageId);
  return one<LedgerEvent>(db, 'SELECT * FROM path_memory_events WHERE id = ?', event.id)!;
}

export function addSource(db: DB, eventId: string, messageId: string): void {
  run(db, 'INSERT INTO path_memory_event_sources (event_id, message_id) VALUES (?, ?)', eventId, messageId);
}

export function eventsPage(db: DB, conversationId: string, afterSequence: number, limit: number): LedgerEvent[] {
  return db.prepare(`SELECT * FROM path_memory_events
    WHERE conversation_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`).all(conversationId, afterSequence, limit) as LedgerEvent[];
}

export function findByIdempotency(db: DB, conversationId: string, key: string): LedgerEvent | undefined {
  return one<LedgerEvent>(db, 'SELECT * FROM path_memory_events WHERE conversation_id = ? AND idempotency_key = ?', conversationId, key);
}

export function protectedMessageIds(db: DB, conversationId: string): string[] {
  const anchors = db.prepare(`SELECT anchor_message_id AS id FROM path_memory_events
    WHERE conversation_id = ? AND action = 'accept' AND anchor_message_id IS NOT NULL`).all(conversationId) as { id: string }[];
  const sources = db.prepare(`SELECT s.message_id AS id FROM path_memory_event_sources s
    JOIN path_memory_events e ON e.id = s.event_id WHERE e.conversation_id = ?`).all(conversationId) as { id: string }[];
  return [...new Set([...anchors, ...sources].map(row => row.id))];
}

/** S5: not stored. Changes when the real head or ledger sequence changes. */
export function stateToken(db: DB, conversationId: string, headId: string | null): string {
  const max = one<{ sequence: number | null }>(db, 'SELECT MAX(sequence) AS sequence FROM path_memory_events WHERE conversation_id = ?', conversationId);
  return createHash('sha256').update(JSON.stringify([conversationId, headId, max?.sequence ?? 0])).digest('hex');
}
