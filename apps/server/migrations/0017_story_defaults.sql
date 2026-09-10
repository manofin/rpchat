-- 0017_story_defaults.sql — story-editor-tabs A12: story-level creation defaults
-- Runner wraps each file in a transaction.

ALTER TABLE stories ADD COLUMN default_profile_name TEXT REFERENCES model_profiles(name) ON DELETE SET NULL;
ALTER TABLE stories ADD COLUMN default_format TEXT;
