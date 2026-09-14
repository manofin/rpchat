-- 0021_character_play_guide.sql — C3: 사용자 전용 플레이 가이드(프롬프트 미주입)
-- Runner wraps each file in a transaction.
ALTER TABLE characters ADD COLUMN play_guide TEXT NOT NULL DEFAULT '';
