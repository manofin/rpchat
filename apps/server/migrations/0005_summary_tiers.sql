-- P1-3a summary tiers. Runner wraps each file in one transaction — no BEGIN/COMMIT.
ALTER TABLE summaries ADD COLUMN tier TEXT NOT NULL DEFAULT 'whole';
ALTER TABLE summaries ADD COLUMN covers_from_message_id TEXT;
ALTER TABLE summaries ADD COLUMN rolled_up_into TEXT;
CREATE INDEX IF NOT EXISTS idx_summaries_tier ON summaries(conversation_id, tier, created_at);
