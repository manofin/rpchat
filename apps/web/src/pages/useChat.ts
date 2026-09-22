import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { abortGeneration, ApiError, get, patch, post, del, sendOkForComposer, streamPost } from '../lib/api';
import type { ConversationDetail, Message, SseEvent } from '../types';
import { initialChatState, reduceChatEvent, type ChatState } from '../lib/chatStreamState';

export type { ChatState } from '../lib/chatStreamState';

export function useChat(conversationId: string) {
  const [state, setState] = useState<ChatState>(initialChatState);
  const [streamConnected, setStreamConnected] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const genIdRef = useRef<string | null>(null);
  const scope = useMemo(() => ({ conversationId, revision: 0, reloadSequence: 0 }), [conversationId]);
  const scopeRef = useRef<typeof scope | null>(scope);
  scopeRef.current = scope;

  const patchState = useCallback((patch: Partial<ChatState>) => {
    if (scopeRef.current === scope) setState((current) => ({ ...current, ...patch }));
  }, [scope]);

  const reload = useCallback(async () => {
    if (scopeRef.current !== scope) return null;
    const sequence = ++scope.reloadSequence;
    const revision = scope.revision;
    try {
      const detail = await get<ConversationDetail>(`/api/conversations/${conversationId}`);
      // A response from an old room or before a newer stream snapshot is stale.
      if (scopeRef.current !== scope || sequence !== scope.reloadSequence || revision !== scope.revision) return null;
      if (detail.activeGeneration) genIdRef.current = detail.activeGeneration.id;
      else if (!abortRef.current) genIdRef.current = null;
      setState((current) => ({ ...current, detail, messages: detail.messages, loading: false, error: null,
        generating: !!detail.activeGeneration, streamingId: detail.activeGeneration?.messageId ?? null }));
      return detail;
    } catch (error) {
      if (sequence === scope.reloadSequence && revision === scope.revision) {
        patchState({ loading: false, error: (error as Error).message });
      }
      return null;
    }
  }, [conversationId, patchState, scope]);

  useEffect(() => {
    scopeRef.current = scope;
    setState(initialChatState);
    setStreamConnected(false);
    genIdRef.current = null;
    void reload();
    return () => {
      const controller = abortRef.current;
      controller?.abort();
      if (abortRef.current === controller) abortRef.current = null;
      if (scopeRef.current === scope) scopeRef.current = null;
    };
  }, [reload, scope]);

  // Polling resumes when the transport closes while the server is still generating.
  useEffect(() => {
    if (!state.generating || streamConnected) return;
    let cancelled = false;
    let timer: number;
    const poll = async () => {
      await reload();
      // Overlapping polls invalidate each other's responses on slow connections.
      if (!cancelled) timer = window.setTimeout(poll, 700);
    };
    timer = window.setTimeout(poll, 700);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [state.generating, streamConnected, reload]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !abortRef.current) void reload();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [reload]);

  const applyEvent = useCallback((event: SseEvent) => {
    if (scopeRef.current !== scope) return;
    scope.revision++;
    if (event.type === 'start') genIdRef.current = event.generationId;
    setState((current) => reduceChatEvent(current, event, conversationId));
  }, [conversationId, scope]);

  const runStream = useCallback(async (path: string, body: unknown) => {
    if (state.generating || abortRef.current) return;
    if (scopeRef.current !== scope) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    scope.revision++;
    setStreamConnected(true);
    patchState({ error: null, generating: true });
    genIdRef.current = null;
    let failed = false;
    let resync = false;
    let result = true;
    let requestError: string | null = null;
    try {
      await streamPost(path, body, (event) => {
        if (scopeRef.current !== scope || abortRef.current !== ctrl) return;
        if (event.type === 'error') {
          failed = true;
          requestError = event.message;
        }
        applyEvent(event);
      }, ctrl.signal);
      if (failed) {
        result = false;
        resync = true;
      }
    } catch (error) {
      const aborted = ctrl.signal.aborted || (error instanceof ApiError && error.status === 499);
      if (!aborted) requestError = (error as Error).message;
      resync = true;
      // Network drops and explicit stop retain the already submitted composer.
      result = sendOkForComposer(error, ctrl.signal.aborted);
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      if (scopeRef.current === scope) {
        setStreamConnected(false);
        if (resync) patchState({ generating: false, streamingId: null, error: requestError });
      }
    }
    if (resync && scopeRef.current === scope) {
      await reload();
      if (requestError) patchState({ error: requestError });
    }
    return scopeRef.current === scope ? result : true;
  }, [state.generating, applyEvent, patchState, reload, scope]);

  const send = useCallback((content: string, opts?: { inject_instruction?: string }) => {
    const body: { content: string; inject_instruction?: string } = { content };
    if (opts?.inject_instruction != null && opts.inject_instruction !== '') {
      body.inject_instruction = opts.inject_instruction;
    }
    return runStream(`/api/conversations/${conversationId}/messages`, body);
  }, [runStream, conversationId]);
  const regenerate = useCallback((messageId: string) => runStream(`/api/conversations/${conversationId}/regenerate`, { messageId }), [runStream, conversationId]);
  const branchEdit = useCallback((messageId: string, content: string) => runStream(`/api/conversations/${conversationId}/branch`, { messageId, content }), [runStream, conversationId]);

  const stop = useCallback(async () => {
    if (scopeRef.current !== scope) return;
    const controller = abortRef.current;
    let gid = genIdRef.current;
    // start SSE is after scene-delta; stop before that still has to reach the server job.
    if (!gid) {
      try {
        const d = await get<ConversationDetail>(`/api/conversations/${conversationId}`);
        gid = d.activeGeneration?.id ?? null;
      } catch { /* POST 중단은 아래에서 시도 */ }
    }
    if (gid) {
      try {
        await abortGeneration(gid);
      } catch { /* 이미 끝났을 수 있음 */ }
    }
    controller?.abort();
    // done(interrupted) 이벤트가 오지 않는 경우 대비해 잠시 후 재동기화
    setTimeout(() => reload(), 500);
  }, [reload, conversationId, scope]);

  const selectSibling = useCallback(async (messageId: string) => {
    const r = await post<{ messages: Message[] }>(`/api/messages/${messageId}/select`, {});
    scope.revision++;
    patchState({ messages: r.messages });
  }, [patchState, scope]);

  const editMessage = useCallback(async (messageId: string, content: string) => {
    const updated = await patch<Message>(`/api/messages/${messageId}`, { content });
    if (scopeRef.current !== scope) return;
    scope.revision++;
    setState((s) => ({ ...s, messages: s.messages.map((m) => (m.id === messageId ? updated : m)) }));
  }, [scope]);

  const deleteMessage = useCallback(async (messageId: string) => {
    const r = await del<{ messages: Message[] }>(`/api/messages/${messageId}`);
    scope.revision++;
    patchState({ messages: r.messages });
  }, [patchState, scope]);

  const toggleBookmark = useCallback(async (messageId: string, val: boolean) => {
    const updated = await patch<Message>(`/api/messages/${messageId}`, { bookmarked: val });
    if (scopeRef.current !== scope) return;
    scope.revision++;
    setState((s) => ({ ...s, messages: s.messages.map((m) => (m.id === messageId ? updated : m)) }));
  }, [scope]);

  const updateConversation = useCallback(async (body: Record<string, unknown>) => {
    const conv = await patch<ConversationDetail['conversation']>(`/api/conversations/${conversationId}`, body);
    if (scopeRef.current !== scope) return;
    scope.revision++;
    setState((s) => (s.detail ? { ...s, detail: { ...s.detail, conversation: conv } } : s));
  }, [conversationId, scope]);

  return {
    ...state,
    loading: state.loading || (!!state.detail && state.detail.conversation.id !== conversationId),
    generating: state.generating || streamConnected,
    reload, send, regenerate, branchEdit, stop, selectSibling, editMessage, deleteMessage, toggleBookmark, updateConversation,
  };
}
