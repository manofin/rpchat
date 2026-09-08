/**
 * 승인 요약 워터마크 → 최근 대화 창 컴팩션.
 * 경로 순서는 메시지 id / created_at 이 아니라 호출자가 넘긴 getPath 인덱스를 쓴다.
 */
import { SCENE_RECENT_GUARD } from './summaryBudget.js';

export interface CompactionPathMessage {
  id: string;
  conversation_id: string;
}

export interface CompactionSummaryInput {
  status: string;
  conversation_id: string;
  covers_until_message_id: string | null;
  covers_from_message_id: string | null;
}

/**
 * 현재 경로에서 가장 멀리 진행된 유효 covers_until 인덱스.
 * 유효 워터마크가 없으면 null — 호출자는 기존 조립을 그대로 둔다.
 */
export function resolveWatermarkIndex(
  path: CompactionPathMessage[],
  summaries: CompactionSummaryInput[],
  conversationId: string,
): number | null {
  const indexById = new Map<string, number>();
  for (let i = 0; i < path.length; i++) {
    const m = path[i];
    if (m.conversation_id !== conversationId) continue;
    indexById.set(m.id, i);
  }

  let best: number | null = null;
  for (const s of summaries) {
    if (s.status !== 'approved') continue;
    if (s.conversation_id !== conversationId) continue;
    const untilId = s.covers_until_message_id;
    if (!untilId) continue;
    const untilIdx = indexById.get(untilId);
    if (untilIdx === undefined) continue;
    const fromId = s.covers_from_message_id;
    if (fromId) {
      const fromIdx = indexById.get(fromId);
      if (fromIdx === undefined) continue;
      if (fromIdx > untilIdx) continue;
    }
    if (best === null || untilIdx > best) best = untilIdx;
  }
  return best;
}

/**
 * 최근 대화에서 제외할 마지막 경로 인덱스 (inclusive).
 * effective = min(워터마크, 최근 보호선 직전).
 * 보호 구간(history.slice(-SCENE_RECENT_GUARD))은 원문으로 남긴다.
 */
export function effectiveCompactionEndIndex(
  watermarkIndex: number | null,
  pathLength: number,
  recentGuard: number = SCENE_RECENT_GUARD,
): number | null {
  if (watermarkIndex == null || watermarkIndex < 0 || pathLength <= 0) return null;
  const lastCompactable = pathLength - recentGuard - 1;
  if (lastCompactable < 0) return null;
  const end = Math.min(watermarkIndex, lastCompactable);
  return end < 0 ? null : end;
}
