-- 0016_lorebook_story_scope.sql — story-editor-tabs A8: story-scoped keyword book
-- Runner wraps each file in a transaction.

ALTER TABLE lorebooks ADD COLUMN story_id TEXT REFERENCES stories(id) ON DELETE CASCADE;
