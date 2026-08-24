/**
 * summarize 계약 순수 헬퍼 — routes/memory.ts 에서 로직을 그대로 추출한 것.
 * 대응 관계 (memory.ts, 변경 없음):
 *   isSummarizeBlocked   ← 142행: ctx.queue.activeList.some(g => g.conversationId === conv.id) → 409
 *   evidenceIdsForSlice  ← 199행+228행: firstId = slice[0].id → memories.evidence_message_ids_json = JSON.stringify([firstId])
 *   sceneCoverRange      ← 198–199행+216행: covers_until=lastId, covers_from=firstId(scene tier만)
 * 스키마 변경 없음. live DB 쓰기 없음.
 */

export function isSummarizeBlocked(activeList: Array<{ conversationId: string }>, conversationId: string): boolean {
  return activeList.some((g) => g.conversationId === conversationId);
}

export function evidenceIdsForSlice(slice: Array<{ id: string }>): string[] {
  if (slice.length === 0) return [];
  const firstId = slice[0].id;
  return [firstId];
}

export function sceneCoverRange(slice: Array<{ id: string }>): { coversFrom: string; coversUntil: string } {
  return { coversFrom: slice[0].id, coversUntil: slice[slice.length - 1].id };
}
