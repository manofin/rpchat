import { many, nowIso, run, uid, type DB } from './index.js';
import { roleEventSchema, type RoleEvent } from '../prompt/roleFacts.js';

type RoleEventRow = { event_json: string };

export function loadRoleEvents(db: DB, conversationId: string): RoleEvent[] {
  return many<RoleEventRow>(db,
    'SELECT event_json FROM role_fact_events WHERE conversation_id = ? ORDER BY sequence',
    conversationId,
  ).map(row => roleEventSchema.parse(JSON.parse(row.event_json)));
}

export function appendRoleEvent(db: DB, event: Omit<RoleEvent, 'id' | 'recorded_by'>, recordedBy: string): RoleEvent {
  const stored = roleEventSchema.parse({ ...event, id: uid(), recorded_by: recordedBy });
  run(db, `INSERT INTO role_fact_events
    (id, conversation_id, proposal_id, action, expected_version, anchor_message_id, recorded_by, event_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    stored.id, stored.conversation_id, stored.proposal_id, stored.action, stored.expected_version,
    stored.anchor_message_id, stored.recorded_by, JSON.stringify(stored), nowIso());
  return stored;
}
