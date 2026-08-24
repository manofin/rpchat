import { many, type DB } from './index.js';
import { updateMessage } from './tree.js';

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
