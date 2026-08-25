/**
 * summarize 계약 헬퍼. memory.ts 가 import 한다 (04a8f1e+).
 * isSummarizeBlocked / evidenceIdsForSlice / sceneCoverRange.
 * 스키마 변경 없음. 이 파일만의 테스트가 라이브 잠금이 되려면
 * memory.ts import + 재빌드된 dist + 재기동된 유닛이 필요하다.
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
