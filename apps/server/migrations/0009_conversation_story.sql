-- 0009_conversation_story.sql — F8b story inject schema (story-inject-schema)
-- Runner wraps each file in a transaction.

ALTER TABLE conversations ADD COLUMN story_id TEXT REFERENCES stories(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN story_applied_at TEXT;
ALTER TABLE conversations ADD COLUMN story_name_snapshot TEXT;
ALTER TABLE conversations ADD COLUMN story_setting_snapshot TEXT;
ALTER TABLE conversations ADD COLUMN story_minor_cast_snapshot TEXT;
