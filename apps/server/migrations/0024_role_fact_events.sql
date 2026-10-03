-- Authenticated, append-only role/proposal decisions.
-- Keys, ordering, recorder identity, and optimistic versions are server-owned.
CREATE TABLE role_fact_events (
  sequence        INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  proposal_id     TEXT NOT NULL,
  action          TEXT NOT NULL CHECK (action IN ('register', 'accept', 'reject', 'withdraw_acceptance', 'record_claim')),
  expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
  anchor_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  recorded_by     TEXT NOT NULL,
  event_json      TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_role_fact_events_conversation ON role_fact_events(conversation_id, sequence);
CREATE INDEX idx_role_fact_events_proposal ON role_fact_events(conversation_id, proposal_id, sequence);
