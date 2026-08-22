-- 대화 전문 검색 (FTS5). contentless 없이 messages.content 스냅샷을 별도 보관해
-- 메시지 수정/삭제 시 트리거로 동기화. 한국어는 토크나이저 한계가 있어
-- trigram 으로 부분 일치를 보장한다.
CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  message_id UNINDEXED,
  conversation_id UNINDEXED,
  role UNINDEXED,
  content,
  tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS trg_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO message_fts (message_id, conversation_id, role, content)
  VALUES (new.id, new.conversation_id, new.role, new.content);
END;

CREATE TRIGGER IF NOT EXISTS trg_fts_delete AFTER DELETE ON messages BEGIN
  DELETE FROM message_fts WHERE message_fts.message_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_fts_update AFTER UPDATE OF content ON messages BEGIN
  UPDATE message_fts SET content = new.content
  WHERE message_fts.message_id = new.id;
END;

-- 기존 메시지 백필 (트리거는 이후 쓰기만 잡음)
INSERT INTO message_fts (message_id, conversation_id, role, content)
SELECT id, conversation_id, role, content FROM messages
WHERE id NOT IN (SELECT message_id FROM message_fts);
