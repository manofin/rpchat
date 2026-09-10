-- 0014_story_opening.sql — F8d story-opening-schema
-- Runner wraps each file in a transaction.

ALTER TABLE stories ADD COLUMN opening_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE conversations ADD COLUMN story_opening_snapshot TEXT;
