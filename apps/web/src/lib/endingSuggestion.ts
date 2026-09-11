import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, get, post } from './api';
import type { ConversationDetail, EndingSuggestion, EndingSuggestionsResponse } from '../types';

/**
 * ADR-F8h Slice 4 (story-ending-suggestion-ui): V3 제안형 배너용 훅.
 *
 * - 턴 완료(generating true→false) 후 GET ending-suggestions 조회.
 * - 배너는 강제 잠금 없이 표시만; 닫기/무시 가능, 진행 방해 금지.
 * - 확정은 사용자 클릭 + confirm 경유, POST /end { endingId, turnId }.
 * - 409 stale → 배너 닫고 최신 재조회 유도. 403 → 토스트 후 닫기.
 * - ended 방·story가 아닌 방에서는 조회 자체를 하지 않는다.
 */

export type EndConfirmResult =
  | { ok: true }
  | { ok: false; reason: 'stale' | 'forbidden' | 'other'; message: string };

/** HTTP 상태 → 확정 실패 분류 (순수 함수 — 벤치 대상). */
export function classifyEndError(status: number): 'stale' | 'forbidden' | 'other' {
  if (status === 409) return 'stale';
  if (status === 403) return 'forbidden';
  return 'other';
}

/** 노출 대상 제안: 닫기한 항목 제외. 서버 상한 N=2 그대로, 클라에서 더 늘리지 않는다 (순수 함수 — 벤치 대상). */
export function visibleEndingSuggestions(
  data: EndingSuggestionsResponse | null,
  dismissed: ReadonlySet<string>,
): EndingSuggestion[] {
  if (!data) return [];
  return data.suggestions.filter((s) => !dismissed.has(s.ending_id));
}

/** stale 후 재조회 유도 여부: 409일 때만 true (순수 함수 — 벤치 대상). */
export function shouldRefetchAfterEndError(reason: EndConfirmResult): boolean {
  return !reason.ok && reason.reason === 'stale';
}

export interface EndingBanner {
  data: EndingSuggestionsResponse | null;
  visible: EndingSuggestion[];
  loading: boolean;
  confirmingId: string | null;
  refresh: () => Promise<void>;
  dismiss: (endingId: string) => void;
  confirm: (s: EndingSuggestion) => Promise<EndConfirmResult>;
}

export function useEndingSuggestions(
  conversationId: string,
  opts: { detail: ConversationDetail | null; generating: boolean; loading: boolean },
): EndingBanner {
  const { detail, generating, loading } = opts;
  const conv = detail?.conversation ?? null;
  const eligible = !!conv && !conv.ended_at && !!conv.story_id;
  const [data, setData] = useState<EndingSuggestionsResponse | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [fetching, setFetching] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const prevGenerating = useRef(generating);
  const turnRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!eligible) {
      setData(null);
      return;
    }
    setFetching(true);
    try {
      const res = await get<EndingSuggestionsResponse>(`/api/conversations/${conversationId}/ending-suggestions`);
      // 턴이 바뀌면 닫기 상태 초기화 (새 턴의 새 제안).
      if (res.turn_id !== turnRef.current) {
        turnRef.current = res.turn_id;
        setDismissed(new Set());
      }
      setData(res);
    } catch {
      // 조회 실패는 조용히 무시 — 본류 대화에 영향 없음.
    } finally {
      setFetching(false);
    }
  }, [conversationId, eligible]);

  // 방 교체 시 상태 초기화.
  useEffect(() => {
    turnRef.current = null;
    setData(null);
    setDismissed(new Set());
  }, [conversationId]);

  // 턴 완료 후 1회 조회 (streaming 중에는 조회하지 않는다).
  useEffect(() => {
    const was = prevGenerating.current;
    prevGenerating.current = generating;
    if (was && !generating && eligible && !loading) void refresh();
  }, [generating, eligible, loading, refresh]);

  const dismiss = useCallback((endingId: string) => {
    setDismissed((prev) => new Set(prev).add(endingId));
  }, []);

  const confirm = useCallback(
    async (s: EndingSuggestion): Promise<EndConfirmResult> => {
      if (!data) return { ok: false, reason: 'other', message: '제안 정보가 없습니다.' };
      setConfirmingId(s.ending_id);
      try {
        await post(`/api/conversations/${conversationId}/end`, { endingId: s.ending_id, turnId: data.turn_id });
        setData(null);
        return { ok: true };
      } catch (e) {
        const status = e instanceof ApiError ? e.status : 0;
        const reason = classifyEndError(status);
        const message = e instanceof Error ? e.message : '완결 요청 실패';
        if (reason === 'stale') {
          // 턴 어긋남: 배너 닫고 최신 재조회 유도 (호출자가 refresh 수행).
          setData(null);
          turnRef.current = null;
        } else if (reason === 'forbidden') {
          setData(null);
        }
        return { ok: false, reason, message };
      } finally {
        setConfirmingId(null);
      }
    },
    [conversationId, data],
  );

  return {
    data,
    visible: visibleEndingSuggestions(data, dismissed),
    loading: fetching,
    confirmingId,
    refresh,
    dismiss,
    confirm,
  };
}
