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

/**
 * regenerate-turn-boundary: which generation a message belongs to.
 *
 * A 1:1 turn is one assistant row, so "regenerate this message" and "regenerate
 * this turn" are the same sentence. A beat / dialog / hunter turn is five or six
 * rows chained under one another, and there the two sentences come apart: the
 * `parent_id` of the last row is the middle of its own turn. Regenerating from it
 * left the first four rows on the active path and appended a second header,
 * narration, line and thought after them — one user input answered twice, in one
 * unbroken path (reproduced against the real routes; see
 * `bench/regenerateTurnBoundary.test.ts`).
 *
 * So the parent for a regeneration is the parent of the turn's *first* block, and
 * this resolves which row that is. It walks the ancestor chain rather than
 * querying for the newest `beat_seq = 0` in the conversation: after any
 * regenerate there are several such rows, and only one of them is on the caller's
 * own branch.
 */
export type TurnStart =
  /** 1:1 — no block_kind, so the row is the whole turn. Existing behaviour. */
  | { kind: 'single'; parentId: string | null }
  /** Multi-row — `startId` carries `beat_seq: 0`; regenerate hangs off its parent. */
  | { kind: 'multi'; startId: string; parentId: string | null }
  /** The chain does not describe a turn this function is willing to guess at. */
  | { kind: 'unresolved'; reason: string };

/** A turn is 5–6 rows; this only has to be larger than that, not generous. */
const TURN_WALK_LIMIT = 64;

export function resolveTurnStart(db: DB, target: MessageRow): TurnStart {
  if (target.role !== 'assistant') return { kind: 'unresolved', reason: 'not_assistant' };
  const meta = parseJson<MessageMeta>(target.meta_json, {});
  // The 1:1 writer sets generation_id but never block_kind, so its absence is the
  // discriminator — not the presence of beat_seq, which a 1:1 row could never have
  // but a partially-written multi-row row might also lack.
  if (!meta.block_kind) return { kind: 'single', parentId: target.parent_id };

  const generation = meta.generation_id;
  const seen = new Set<string>();
  let cur: MessageRow | null = target;
  for (let hops = 0; hops < TURN_WALK_LIMIT; hops++) {
    if (!cur) return { kind: 'unresolved', reason: 'chain_broken' };
    if (seen.has(cur.id)) return { kind: 'unresolved', reason: 'cycle' };
    seen.add(cur.id);
    if (cur.conversation_id !== target.conversation_id) return { kind: 'unresolved', reason: 'crossed_conversation' };
    if (cur.role !== 'assistant') return { kind: 'unresolved', reason: 'crossed_user_message' };
    const m = parseJson<MessageMeta>(cur.meta_json, {});
    // Crossing into another generation before finding a start means this row's own
    // first block is not among its ancestors — the corrupted shape this slice
    // exists to stop making. Refuse rather than pick the neighbouring turn's start.
    if (generation && m.generation_id && m.generation_id !== generation) {
      return { kind: 'unresolved', reason: 'crossed_generation' };
    }
    if (m.beat_seq === 0) return { kind: 'multi', startId: cur.id, parentId: cur.parent_id };
    if (!cur.parent_id) return { kind: 'unresolved', reason: 'no_turn_start' };
    cur = one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', cur.parent_id) ?? null;
  }
  return { kind: 'unresolved', reason: 'walk_limit' };
}
