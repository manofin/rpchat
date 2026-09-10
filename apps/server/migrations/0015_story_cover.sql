-- 0015_story_cover.sql — story-editor-tabs A2: story cover image
-- Runner wraps each file in a transaction.

ALTER TABLE stories ADD COLUMN cover TEXT;
