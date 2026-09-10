-- 0019_story_openings_extra.sql — ADR-F8f Slice 1 (story-multi-opening-schema)
-- Additive extras list. Default opening stays stories.opening_json (0014).
-- Conversations snapshot column is unchanged: copy the chosen F8d object raw.
-- Runner wraps each file in a transaction.

ALTER TABLE stories ADD COLUMN openings_extra_json TEXT NOT NULL DEFAULT '[]';
