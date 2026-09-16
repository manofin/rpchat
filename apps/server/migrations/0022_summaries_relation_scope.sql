-- episode-relation-schema — Scope B `(character_id, persona_id)` on summaries.
-- ADD COLUMN only; no backfill; non-episode tiers stay NULL.
-- Episode writes land in a later slice (episode-relation-build); this file does not
-- change INSERT/builder. Runner wraps each file in one transaction — no BEGIN/COMMIT.
-- Bare REFERENCES only (0004-style); no cascade clause on these columns.
ALTER TABLE summaries ADD COLUMN rel_character_id TEXT REFERENCES characters(id);
ALTER TABLE summaries ADD COLUMN rel_persona_id TEXT REFERENCES personas(id);
-- Relation branch for ADR §5 inject (tier+status+pair+created_at).
CREATE INDEX IF NOT EXISTS idx_summaries_relation
  ON summaries(tier, status, rel_character_id, rel_persona_id, created_at);
-- Conversation branch: idx_summaries_conv (0001) / idx_summaries_tier (0005) already
-- exist, but with idx_summaries_relation present SQLite prefers it for any
-- tier+status predicate. Add a conversation-leading composite so ADR §5's
-- conversation half (and OR-by-union) SEARCH on conversation_id.
CREATE INDEX IF NOT EXISTS idx_summaries_conv_tier_status
  ON summaries(conversation_id, tier, status, created_at);
