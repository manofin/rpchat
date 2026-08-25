-- 0007_persona_snapshot.sql — snapshot lock (2026-08-25)
-- Breaks live persona reference for in-flight chats; persona_id stays the catalog pointer.
ALTER TABLE conversations ADD COLUMN persona_name_snapshot TEXT;
ALTER TABLE conversations ADD COLUMN persona_address_snapshot TEXT;
ALTER TABLE conversations ADD COLUMN persona_appearance_snapshot TEXT;
ALTER TABLE conversations ADD COLUMN persona_personality_snapshot TEXT;
ALTER TABLE conversations ADD COLUMN persona_relationship_snapshot TEXT;
ALTER TABLE conversations ADD COLUMN persona_applied_at TEXT;
