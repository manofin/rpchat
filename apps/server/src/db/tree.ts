import { type DB, many, nowIso, one, parseJson, run, uid } from './index.js';
import type { ConversationRow, MessageMeta, MessageRow, MessageStatus } from '../types.js';

export interface MessageOut extends Omit<MessageRow, 'meta_json' | 'bookmarked'> {
  meta: MessageMeta;
  bookmarked: boolean;
  siblings: { index: number; count: number; ids: string[] };
}

export function messageOut(db: DB, m: MessageRow): MessageOut {
  const ids = many<{ id: string }>(
    db,
    'SELECT id FROM messages WHERE conversation_id = ? AND parent_id IS ? ORDER BY created_at, id',
    m.conversation_id, m.parent_id,
  ).map((r) => r.id);
  const { meta_json, bookmarked, ...rest } = m;
  return { ...rest, meta: parseJson<MessageMeta>(meta_json, {}), bookmarked: !!bookmarked, siblings: { index: Math.max(0, ids.indexOf(m.id)), count: ids.length, ids } };
}

/** head 에서 루트까지 거슬러 올라간 활성 경로 (시간순) */
export function getPath(db: DB, conv: ConversationRow): MessageRow[] {
  const out: MessageRow[] = [];
  let cur: string | null = conv.head_message_id;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    const m = one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', cur);
    if (!m) break;
    out.push(m);
    cur = m.parent_id;
  }
  return out.reverse();
}

/** 주어진 메시지에서 "가장 최근 자식" 을 따라 내려간 잎 */
export function deepestLeaf(db: DB, messageId: string): string {
  let cur = messageId;
  for (let i = 0; i < 10_000; i++) {
    const child = one<{ id: string }>(db, 'SELECT id FROM messages WHERE parent_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', cur);
    if (!child) return cur;
    cur = child.id;
  }
  return cur;
}

export function setHead(db: DB, convId: string, headId: string | null): void {
  run(db, 'UPDATE conversations SET head_message_id = ?, updated_at = ? WHERE id = ?', headId, nowIso(), convId);
}

export function insertMessage(
  db: DB,
  convId: string,
  parentId: string | null,
  role: 'user' | 'assistant',
  content: string,
  status: MessageStatus,
  meta: MessageMeta,
): MessageRow {
  const id = uid();
  const t = nowIso();
  run(
    db,
    'INSERT INTO messages (id, conversation_id, parent_id, role, content, status, meta_json, bookmarked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)',
    id, convId, parentId, role, content, status, JSON.stringify(meta), t,
  );
  run(db, 'UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?', t, t, convId);
  return one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', id)!;
}

export function updateMessage(db: DB, id: string, patch: { content?: string; status?: MessageStatus; meta?: MessageMeta; bookmarked?: boolean }): void {
  const cur = one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', id);
  if (!cur) return;
  const meta = patch.meta ? { ...parseJson<MessageMeta>(cur.meta_json, {}), ...patch.meta } : parseJson<MessageMeta>(cur.meta_json, {});
  run(
    db,
    'UPDATE messages SET content = ?, status = ?, meta_json = ?, bookmarked = ? WHERE id = ?',
    patch.content ?? cur.content, patch.status ?? cur.status, JSON.stringify(meta), patch.bookmarked === undefined ? cur.bookmarked : patch.bookmarked ? 1 : 0, id,
  );
}
