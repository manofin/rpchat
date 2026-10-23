import { useCallback, useEffect, useState } from 'react';
import type { Summary } from '../types';
import { api } from './api';

export function useSummaryRows(conversationId: string, enabled: boolean, headMessageId: string | null | undefined, revision: string | number = 0) {
  const [reloadTick, setReloadTick] = useState(0);
  const key = JSON.stringify([conversationId, headMessageId, revision, reloadTick]);
  const [snapshot, setSnapshot] = useState<{ key: string; rows: Summary[] | null; error: string | null } | null>(null);
  const reload = useCallback(() => setReloadTick((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let active = true;
    setSnapshot({ key, rows: null, error: null });
    api<Summary[]>(`/api/conversations/${conversationId}/summaries`, { signal: controller.signal })
      .then((rows) => {
        if (!active) return;
        // GET classifies against the server head. A concurrent change in another
        // client must not make those classifications appear local to this view.
        if (headMessageId !== undefined && rows.some((row) => row.branch_head_id !== undefined && row.branch_head_id !== headMessageId)) {
          setSnapshot({ key, rows: null, error: '대화 분기가 바뀌었습니다. 대화를 새로고침해 주세요.' });
          return;
        }
        setSnapshot({ key, rows, error: null });
      })
      .catch((error: unknown) => {
        if (active) setSnapshot({ key, rows: null, error: error instanceof Error ? error.message : '요약을 불러오지 못했습니다.' });
      });
    return () => { active = false; controller.abort(); };
  }, [enabled, conversationId, headMessageId, key]);

  const current = enabled && snapshot?.key === key ? snapshot : null;
  return { summaries: current?.rows ?? null, error: current?.error ?? null, reload };
}
