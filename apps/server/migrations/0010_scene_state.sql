-- 0010_scene_state.sql — F9B Scene State (additive conversations.scene_json keys)
-- Runner wraps each file in a transaction. This file must not open or close that wrapper.
-- Store remains conversations.scene_json TEXT (0001). No new table. No scene_clock.
-- character_id nullability is unchanged from 0001.
-- This migration does not rewrite existing conversation scene_json row bytes.
-- Existing 6 string keys unchanged (기존 6필드 유지): place, time, goal, genre, conflict, mood.
-- Clock storage key is clock_minutes (integer minutes). NOT the string key `time`.
-- Optional additive keys (omitted = 6-field 1:1 byte identity):
--   clock_minutes  -- integer minutes, server SoT; model proposes advance_minutes at F9E
--   weather        -- string token; enum allow-list is F9E apply, not this file
--   location       -- id string
--   stage          -- id string (quest)
--   arc            -- id string (narrative)
--   flags          -- JSON array of {"key": string, "owner_stage"?: string}
-- SQLite cannot constrain JSON shape. This file records the contract in schema_migrations.

SELECT 1;
