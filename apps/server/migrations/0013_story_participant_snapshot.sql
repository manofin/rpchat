-- 0013_story_participant_snapshot.sql — F8e story-peer-cast-schema
-- Runner wraps each file in a transaction.

ALTER TABLE conversations ADD COLUMN story_participant_ids_snapshot TEXT;
