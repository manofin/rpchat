-- rpchat 초기 스키마 (SQLite, WAL). 모든 시각은 ISO-8601 UTC 문자열.

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0,
  user_agent TEXT
);

-- 용도별 샘플링 프로필 (rp-balanced / rp-creative / summary / memory-extract)
CREATE TABLE IF NOT EXISTS model_profiles (
  name        TEXT PRIMARY KEY,
  model       TEXT,                          -- NULL 이면 MODEL_NAME 사용
  temperature REAL NOT NULL DEFAULT 0.8,
  top_p       REAL NOT NULL DEFAULT 0.95,
  max_tokens  INTEGER NOT NULL DEFAULT 400,
  stop_json   TEXT NOT NULL DEFAULT '[]',    -- 추가 stop 시퀀스
  system_mode TEXT NOT NULL DEFAULT 'system',-- 'system' | 'merge' (system 역할 미지원 템플릿: 첫 user 턴에 병합)
  notes       TEXT
);

CREATE TABLE IF NOT EXISTS characters (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  tagline          TEXT NOT NULL DEFAULT '',
  avatar           TEXT,                     -- media 상대경로 (선택)
  description      TEXT NOT NULL DEFAULT '',
  personality      TEXT NOT NULL DEFAULT '',
  speech_style     TEXT NOT NULL DEFAULT '',
  scenario         TEXT NOT NULL DEFAULT '',
  first_message    TEXT NOT NULL DEFAULT '',
  example_dialogue TEXT NOT NULL DEFAULT '',
  taboos           TEXT NOT NULL DEFAULT '',
  tags_json        TEXT NOT NULL DEFAULT '[]',
  scene_background TEXT,                     -- 선택 (향후)
  voice_profile    TEXT,                     -- 선택 (향후)
  archived         INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS personas (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  address_as   TEXT NOT NULL DEFAULT '',     -- 캐릭터가 부르는 호칭
  appearance   TEXT NOT NULL DEFAULT '',
  personality  TEXT NOT NULL DEFAULT '',
  relationship TEXT NOT NULL DEFAULT '',     -- 관계·배경
  is_default   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- character_id NULL = 전역 로어북
CREATE TABLE IF NOT EXISTS lorebooks (
  id           TEXT PRIMARY KEY,
  character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lore_entries (
  id            TEXT PRIMARY KEY,
  lorebook_id   TEXT NOT NULL REFERENCES lorebooks(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  keywords_json TEXT NOT NULL DEFAULT '[]',
  content       TEXT NOT NULL,
  priority      INTEGER NOT NULL DEFAULT 0,  -- 높을수록 먼저 삽입
  always_on     INTEGER NOT NULL DEFAULT 0,
  token_cap     INTEGER NOT NULL DEFAULT 300,
  enabled       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  character_id    TEXT NOT NULL REFERENCES characters(id),
  persona_id      TEXT REFERENCES personas(id),
  title           TEXT NOT NULL DEFAULT '',
  mode            TEXT NOT NULL DEFAULT 'chat',      -- 'chat' | 'story'
  profile_name    TEXT NOT NULL DEFAULT 'rp-balanced',
  scene_json      TEXT NOT NULL DEFAULT '{}',        -- {place,time,goal,genre,conflict,mood}
  head_message_id TEXT,                              -- 현재 활성 분기의 마지막 메시지
  prompt_version  TEXT NOT NULL,
  favorite        INTEGER NOT NULL DEFAULT 0,
  archived        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_message_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_conversations_char ON conversations(character_id, last_message_at);

-- 메시지는 트리. parent_id 가 같은 형제 = swipe 변형 / 수정 분기.
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_id       TEXT REFERENCES messages(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,                     -- 'user' | 'assistant'
  content         TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'complete',  -- 'streaming' | 'complete' | 'interrupted' | 'error'
  meta_json       TEXT NOT NULL DEFAULT '{}',        -- {usage,finish_reason,choices,ooc,profile,prompt_version,generation_id}
  bookmarked      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(conversation_id, parent_id, created_at);

-- 후보 기억함 → 사용자 승인 → 고정 기억
CREATE TABLE IF NOT EXISTS memories (
  id                        TEXT PRIMARY KEY,
  conversation_id           TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  character_id              TEXT REFERENCES characters(id) ON DELETE CASCADE,
  content                   TEXT NOT NULL,
  source                    TEXT NOT NULL DEFAULT 'user',         -- 'user' | 'model'
  status                    TEXT NOT NULL DEFAULT 'pinned',       -- 'candidate' | 'pinned' | 'rejected'
  importance                INTEGER NOT NULL DEFAULT 3,           -- 1~5
  scope                     TEXT NOT NULL DEFAULT 'conversation', -- 'conversation' | 'character'
  evidence_message_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_conv ON memories(conversation_id, status);
CREATE INDEX IF NOT EXISTS idx_memories_char ON memories(character_id, status);

CREATE TABLE IF NOT EXISTS summaries (
  id                      TEXT PRIMARY KEY,
  conversation_id         TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  content                 TEXT NOT NULL,
  covers_until_message_id TEXT,
  status                  TEXT NOT NULL DEFAULT 'draft',          -- 'draft' | 'approved'
  created_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_summaries_conv ON summaries(conversation_id, created_at);

-- 토큰 예산·지연 로그 (추정 vs 실제 보정의 근거)
CREATE TABLE IF NOT EXISTS generation_log (
  id                   TEXT PRIMARY KEY,
  conversation_id      TEXT NOT NULL,
  message_id           TEXT,
  profile_name         TEXT NOT NULL,
  prompt_version       TEXT NOT NULL,
  est_prompt_tokens    INTEGER,
  actual_prompt_tokens INTEGER,
  completion_tokens    INTEGER,
  ttft_ms              INTEGER,
  total_ms             INTEGER,
  finish_reason        TEXT,
  status               TEXT NOT NULL,
  budget_json          TEXT NOT NULL DEFAULT '{}',
  created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_genlog_conv ON generation_log(conversation_id, created_at);
