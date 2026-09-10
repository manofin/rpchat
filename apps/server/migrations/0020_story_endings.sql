-- 0020_story_endings.sql — ADR-F8g Slice 1 (story-endings-slice1-schema)
-- Additive endings list on stories. Conversations gain a frozen snapshot plus
-- end-state columns (NULL = room in progress / pre-slice row).
-- Runner wraps each file in a transaction.

ALTER TABLE stories ADD COLUMN endings_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE conversations ADD COLUMN story_endings_snapshot TEXT;
ALTER TABLE conversations ADD COLUMN ended_at TEXT;
ALTER TABLE conversations ADD COLUMN reached_ending_id TEXT;
