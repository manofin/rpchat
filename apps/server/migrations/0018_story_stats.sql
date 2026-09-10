-- 0018_story_stats.sql — story-editor-tabs A7 (D2=a): display-only custom stats
-- Runner wraps each file in a transaction.
-- Definitions only. Values live on conversations.scene_json.stats.
-- applySceneDelta is not extended.

ALTER TABLE stories ADD COLUMN stats_json TEXT NOT NULL DEFAULT '[]';
