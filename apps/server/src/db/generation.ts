import { many, type DB } from './index.js';
import { updateMessage } from './tree.js';

/** 409 body when DELETE would hit an in-flight generation (F2). */
export const DELETE_BLOCKED_BY_GENERATION = '생성 중에는 삭제할 수 없음';

export type GenerationDeleteRef = { conversationId: string; messageId: string };

/**
 * Target + descendants — the rows CASCADE would remove if `rootId` is deleted.
 */
export function descendantMessageIds(db: DB, rootId: string): string[] {
  const ids: string[] = [];
  const q = [rootId];
  while (q.length) {
    const id = q.pop()!;
    ids.push(id);
    for (const k of many<{ id: string }>(db, 'SELECT id FROM messages WHERE parent_id = ?', id)) {
      q.push(k.id);
    }
  }
  return ids;
}

/**
 * F1 `queue.activeList` is the SoT. beat/dialog may register with messageId ''
 * before a streaming row exists, so conversation-id match plus either a full
 * conversation delete, a subtree that contains the live head, or a subtree
 * that contains a registered messageId is overlap.
 */
export function generationBlocksDelete(opts: {
  gens: readonly GenerationDeleteRef[];
  conversationId: string;
  scope: 'conversation' | { deletedIds: ReadonlySet<string>; headMessageId: string | null };
}): boolean {
  const active = opts.gens.filter((g) => g.conversationId === opts.conversationId);
  if (active.length === 0) return false;
  if (opts.scope === 'conversation') return true;
  const { deletedIds, headMessageId } = opts.scope;
  if (headMessageId && deletedIds.has(headMessageId)) return true;
  return active.some((g) => g.messageId !== '' && deletedIds.has(g.messageId));
}

/**
 * In-process 큐에 없는 streaming 행을 interrupted 로 접는다.
 * 서버 재시작 후 큐는 비어 있으므로 부팅 시 전량 고아.
 * keepMessageIds = 현재 큐의 messageId. minAgeMs 는 GET 레이스 가드.
 */
export function interruptOrphanStreaming(
  db: DB,
  opts?: { keepMessageIds?: Iterable<string>; minAgeMs?: number },
): number {
  const keep = new Set(opts?.keepMessageIds ?? []);
  const minAgeMs = opts?.minAgeMs ?? 0;
  const cutoff = minAgeMs > 0 ? new Date(Date.now() - minAgeMs).toISOString() : null;
  const rows = cutoff
    ? many<{ id: string }>(db, `SELECT id FROM messages WHERE status = 'streaming' AND created_at < ?`, cutoff)
    : many<{ id: string }>(db, `SELECT id FROM messages WHERE status = 'streaming'`);
  let n = 0;
  for (const r of rows) {
    if (keep.has(r.id)) continue;
    updateMessage(db, r.id, { status: 'interrupted', meta: { finish_reason: 'orphan-streaming' } });
    n++;
  }
  return n;
}
