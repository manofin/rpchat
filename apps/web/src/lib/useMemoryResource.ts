import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

/** Memory screens must recheck the selected branch when returning from another tab. */
export function useMemoryResource<T>(url: string, headMessageId?: string | null) {
  const scope = `${url}:${headMessageId ?? ''}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const [state, setState] = useState<{ scope: string; data: T | null; loading: boolean; error: string | null }>({
    scope, data: null, loading: true, error: null,
  });
  const refresh = useCallback(async () => {
    const sequence = ++request.current;
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setState(previous => ({ scope, data: previous.scope === scope ? previous.data : null, loading: true, error: null }));
    try {
      const data = await api<T>(url, { signal: nextController.signal, cache: 'no-store' });
      if (request.current === sequence && currentScope.current === scope) {
        setState({ scope, data, loading: false, error: null });
        return data;
      }
    } catch (error) {
      if (request.current === sequence && currentScope.current === scope) {
        setState({ scope, data: null, loading: false, error: error instanceof Error ? error.message : '기억 정보를 불러오지 못했습니다.' });
      }
    }
  }, [url, scope]);
  useEffect(() => {
    void refresh();
    const onFocus = () => { void refresh(); };
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      request.current++;
      controller.current?.abort();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);
  return {
    data: state.scope === scope ? state.data : null,
    loading: state.scope !== scope || state.loading,
    error: state.scope === scope ? state.error : null,
    refresh,
  };
}
