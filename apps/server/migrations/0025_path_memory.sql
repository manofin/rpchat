-- Path-memory ledger. Conversation delete cascades. Message FKs stay NO ACTION (S3).
CREATE TABLE path_memory_events (
  sequence          INTEGER PRIMARY KEY AUTOINCREMENT,
  id                TEXT NOT NULL UNIQUE,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  node_id           TEXT NOT NULL,
  proposal_id       TEXT NOT NULL,
  action            TEXT NOT NULL CHECK (action IN ('propose', 'accept', 'reject')),
  change            TEXT CHECK (change IN ('create', 'edit', 'move', 'close')),
  anchor_message_id TEXT REFERENCES messages(id),
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
  idempotency_key   TEXT,
  payload_hash      TEXT NOT NULL,
  schema_version    INTEGER NOT NULL,
  payload_json      TEXT NOT NULL,
  recorded_by       TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_pme_conversation ON path_memory_events(conversation_id, sequence);
CREATE UNIQUE INDEX idx_pme_idem ON path_memory_events(conversation_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE path_memory_event_sources (
  event_id   TEXT NOT NULL REFERENCES path_memory_events(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id),
  PRIMARY KEY (event_id, message_id)
);
