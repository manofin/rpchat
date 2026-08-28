-- 0008_stories.sql — F8 story container (story-schema, 2026-08-28)
-- Runner wraps each file in a transaction.

CREATE TABLE stories (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  tagline     TEXT NOT NULL DEFAULT '',
  setting     TEXT NOT NULL DEFAULT '',
  minor_cast  TEXT NOT NULL DEFAULT '[]',
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE story_characters (
  story_id      TEXT NOT NULL,
  character_id  TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'main',
  sort_order    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (story_id, character_id),
  FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE,
  FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
);
