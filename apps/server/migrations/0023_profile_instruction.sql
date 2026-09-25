-- 0023_profile_instruction.sql — 모델 프로필 서술 지침 + 캐릭터 기본 프로필
-- Runner wraps each file in a transaction.
-- instruction_text 는 비공개 런타임 데이터다(공개 repo 에는 원문을 두지 않는다).
-- instruction_enabled=0 이거나 text 가 공백뿐이면 프롬프트는 이 컬럼이 없던 때와 바이트 동일.
ALTER TABLE model_profiles ADD COLUMN instruction_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE model_profiles ADD COLUMN instruction_text TEXT;
ALTER TABLE characters ADD COLUMN default_profile_name TEXT REFERENCES model_profiles(name) ON DELETE SET NULL;
