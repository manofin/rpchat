-- 2차 키워드 + 선택적 발동. 기존 행은 빈 2차·selective=0 이라 1차 매칭만 유지.
ALTER TABLE lore_entries ADD COLUMN secondary_keys_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE lore_entries ADD COLUMN selective INTEGER NOT NULL DEFAULT 0;
