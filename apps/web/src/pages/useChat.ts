import { useCallback, useEffect, useRef, useState } from 'react';
import { abortGeneration, get, patch, post, put, del, streamPost } from '../lib/api';
import type { ConversationDetail, Message, SseBudget, SseEvent } from '../types';

export interface ChatState {
  detail: ConversationDetail | null;
  messages: Message[];
  loading: boolean;
  error: string | null;
  generating: boolean;
  streamingId: string | null;
  lastBudget: SseBudget | null;
  budgetAtHead: string | null;
}

export function useChat(conversationId: string) {
  const [state, setState] = useState<ChatState>({ detail: null, messages: [], loading: true, error: null, generating: false, streamingId: null, lastBudget: null, budgetAtHead: null });
  const abortRef = useRef<AbortController | null>(null);
  const genIdRef = useRef<string | null>(null);
  const streamBuf = useRef<Map<string, string>>(new Map());

  const patchState = (p: Partial<ChatState>) => setState((s) => ({ ...s, ...p }));

  const reload = useCallback(async () => {
    try {
      const d = await get<ConversationDetail>(`/api/conversations/${conversationId}`);
      setState((s) => ({ ...s, detail: d, messages: d.messages, loading: false, error: null, generating: !!d.activeGeneration, streamingId: d.activeGeneration?.messageId ?? null }));
      return d;
    } catch (e) {
      patchState({ loading: false, error: (e as Error).message });
      return null;
    }
  }, [conversationId]);

  useEffect(() => {
    patchState({ loading: true, lastBudget: null, budgetAtHead: null });
    reload();
    return () => abortRef.current?.abort();
  }, [conversationId, reload]);

  const applyEvent = useCallback((e: SseEvent) => {
    setState((s) => {
      switch (e.type) {
        case 'start': {
          genIdRef.current = e.generationId;
          const msgs = [...s.messages];
          if (e.userMessage && !msgs.find((m) => m.id === e.userMessage!.id)) msgs.push(e.userMessage);
          streamBuf.current.set(e.messageId, '');
          const placeholder: Message = { id: e.messageId, conversation_id: conversationId, parent_id: e.userMessage?.id ?? s.detail?.conversation.head_message_id ?? null, role: 'assistant', content: '', status: 'streaming', meta: {}, bookmarked: false, created_at: new Date().toISOString(), siblings: { index: 0, count: 1, ids: [e.messageId] } };
          return { ...s, messages: [...msgs, placeholder], generating: true, streamingId: e.messageId };
        }
        case 'token': {
          const id = s.streamingId;
          if (!id) return s;
          const prev = streamBuf.current.get(id) ?? '';
          const next = prev + e.text;
          streamBuf.current.set(id, next);
          return { ...s, messages: s.messages.map((m) => (m.id === id ? { ...m, content: next } : m)) };
        }
        case 'done': {
          streamBuf.current.delete(e.message.id);
          const complete = e.message.status === 'complete';
          return {
            ...s,
            messages: s.messages.map((m) => (m.id === e.message.id ? e.message : m)),
            generating: false,
            streamingId: null,
            lastBudget: complete && e.budget ? e.budget : s.lastBudget,
            budgetAtHead: complete && e.budget ? e.message.id : s.budgetAtHead,
          };
        }
        case 'error': {
          const id = e.messageId ?? s.streamingId;
          return {
            ...s,
            messages: s.messages.map((m) => (m.id === id ? { ...m, status: 'error', meta: { ...m.meta, error: e.message } } : m)),
            generating: false,
            streamingId: null,
            error: e.message,
          };
        }
        default:
          return s;
      }
    });
  }, [conversationId]);

  const runStream = useCallback(async (path: string, body: unknown) => {
    if (state.generating) return;
    patchState({ error: null });
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    genIdRef.current = null;
    try {
      await streamPost(path, body, applyEvent, ctrl.signal);
    } catch (e) {
      if (!ctrl.signal.aborted) {
        // 네트워크 단절: 서버는 계속 생성 중일 수 있으므로 상태를 재동기화
        patchState({ error: (e as Error).message, generating: false, streamingId: null });
        setTimeout(() => reload(), 400);
      }
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  }, [state.generating, applyEvent, reload]);

  const send = useCallback((content: string) => runStream(`/api/conversations/${conversationId}/messages`, { content }), [runStream, conversationId]);
  const regenerate = useCallback((messageId: string) => runStream(`/api/conversations/${conversationId}/regenerate`, { messageId }), [runStream, conversationId]);
  const branchEdit = useCallback((messageId: string, content: string) => runStream(`/api/conversations/${conversationId}/branch`, { messageId, content }), [runStream, conversationId]);

  const stop = useCallback(async () => {
    const gid = genIdRef.current;
    if (gid) {
      try {
        await abortGeneration(gid);
      } catch { /* 이미 끝났을 수 있음 */ }
    }
    abortRef.current?.abort();
    // done(interrupted) 이벤트가 오지 않는 경우 대비해 잠시 후 재동기화
    setTimeout(() => reload(), 500);
  }, [reload]);

  const selectSibling = useCallback(async (messageId: string) => {
    const r = await post<{ messages: Message[] }>(`/api/messages/${messageId}/select`, {});
    patchState({ messages: r.messages });
  }, []);

  const editMessage = useCallback(async (messageId: string, content: string) => {
    const updated = await patch<Message>(`/api/messages/${messageId}`, { content });
    setState((s) => ({ ...s, messages: s.messages.map((m) => (m.id === messageId ? updated : m)) }));
  }, []);

  const deleteMessage = useCallback(async (messageId: string) => {
    const r = await del<{ messages: Message[] }>(`/api/messages/${messageId}`);
    patchState({ messages: r.messages });
  }, []);

  const toggleBookmark = useCallback(async (messageId: string, val: boolean) => {
    const updated = await patch<Message>(`/api/messages/${messageId}`, { bookmarked: val });
    setState((s) => ({ ...s, messages: s.messages.map((m) => (m.id === messageId ? updated : m)) }));
  }, []);

  const updateConversation = useCallback(async (body: Record<string, unknown>) => {
    const conv = await patch<ConversationDetail['conversation']>(`/api/conversations/${conversationId}`, body);
    setState((s) => (s.detail ? { ...s, detail: { ...s.detail, conversation: conv } } : s));
  }, [conversationId]);

  return { ...state, reload, send, regenerate, branchEdit, stop, selectSibling, editMessage, deleteMessage, toggleBookmark, updateConversation };
}
