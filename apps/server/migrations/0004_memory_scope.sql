-- §4.2 갭 컬럼 추가 (ADD COLUMN only). 값 도메인 변경 없음. 기존 행 신규4컬럼 NULL.
ALTER TABLE memories ADD COLUMN replaces_memory_id TEXT REFERENCES memories(id);
ALTER TABLE memories ADD COLUMN valid_from TEXT;
ALTER TABLE memories ADD COLUMN valid_until TEXT;
ALTER TABLE memories ADD COLUMN world_id TEXT;
