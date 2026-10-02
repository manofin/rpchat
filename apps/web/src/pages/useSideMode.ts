import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { abortGeneration, get, streamPost } from '../lib/api';
import { initialChatState, reduceChatEvent } from '../lib/chatStreamState';
import type { SideMode } from '../lib/responseControls';
import type { Message } from '../types';

export function useSideMode(conversationId: string, branchHead: string | null) {
  const [state, setState] = useState(initialChatState);
  const [connected, setConnected] = useState(false);
  const scope = useMemo(() => ({ conversationId, branchHead, revision: 0, sequence: 0 }), [conversationId, branchHead]);
  const scopeRef = useRef<typeof scope | null>(scope);
  scopeRef.current = scope;
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef<string | null>(null);

  const reload = useCallback(async () => {
    const sequence = ++scope.sequence;
    const revision = scope.revision;
    try {
      const messages = await get<Message[]>(`/api/conversations/${conversationId}/side-mode`);
      if (scopeRef.current !== scope || sequence !== scope.sequence || revision !== scope.revision) return null;
      const active = messages.find((message) => message.status === 'streaming');
      generationRef.current = active?.meta.generation_id ?? null;
      setState((current) => ({ ...current, messages, loading: false, generating: !!active, streamingId: active?.id ?? null }));
      return messages;
    } catch (error) {
      if (scopeRef.current === scope && sequence === scope.sequence && revision === scope.revision) {
        setState((current) => ({ ...current, loading: false, error: (error as Error).message }));
      }
      return null;
    }
  }, [conversationId, scope]);

  useEffect(() => {
    scopeRef.current = scope;
    setState(initialChatState);
    setConnected(false);
    generationRef.current = null;
    void reload();
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      if (scopeRef.current === scope) scopeRef.current = null;
    };
  }, [reload, scope]);

  useEffect(() => {
    if (!state.generating || connected) return;
    let cancelled = false;
    let timer: number;
    const poll = async () => {
      await reload();
      if (!cancelled) timer = window.setTimeout(poll, 700);
    };
    timer = window.setTimeout(poll, 700);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [state.generating, connected, reload]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !controllerRef.current) void reload();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [reload]);

  const generate = useCallback(async (mode: SideMode, prompt?: string) => {
    if (state.generating || controllerRef.current || scopeRef.current !== scope) return false;
    const controller = new AbortController();
    controllerRef.current = controller;
    generationRef.current = null;
    scope.revision++;
    setConnected(true);
    setState((current) => ({ ...current, generating: true, error: null }));
    let accepted = false;
    let errorMessage: string | null = null;
    try {
      await streamPost(`/api/conversations/${conversationId}/side-mode`, { mode, ...(prompt ? { prompt } : {}) }, (event) => {
        if (scopeRef.current !== scope || controllerRef.current !== controller) return;
        scope.revision++;
        if (event.type === 'start') { generationRef.current = event.generationId; accepted = true; }
        if (event.type === 'error') errorMessage = event.message;
        setState((current) => reduceChatEvent(current, event, conversationId));
      }, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) errorMessage = (error as Error).message;
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      if (scopeRef.current === scope) {
        setConnected(false);
        // A lost transport may leave the server running; reload resumes polling.
        setState((current) => ({ ...current, generating: accepted, error: errorMessage }));
        await reload();
      }
    }
    return accepted;
  }, [conversationId, reload, scope, state.generating]);

  const stop = useCallback(async () => {
    if (scopeRef.current !== scope) return;
    const controller = controllerRef.current;
    let generationId = generationRef.current;
    if (!generationId) {
      const messages = await reload();
      generationId = messages?.find((message) => message.status === 'streaming')?.meta.generation_id ?? null;
    }
    if (scopeRef.current !== scope) return;
    if (generationId) {
      try { await abortGeneration(generationId); } catch { /* completion can win the race */ }
    }
    controller?.abort();
    await reload();
  }, [reload, scope]);

  return { ...state, generating: state.generating || connected, generate, stop, reload };
}
