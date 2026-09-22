import type { ConversationDetail, Message, SseBudget, SseEvent } from '../types';
import { EVENT_CONTRACT_UNAVAILABLE } from './chatEvents';

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

export const initialChatState: ChatState = {
  detail: null, messages: [], loading: true, error: null, generating: false,
  streamingId: null, lastBudget: null, budgetAtHead: null,
};

function upsert(messages: Message[], message: Message, selectBranch = false): Message[] {
  if (messages.some((entry) => entry.id === message.id)) {
    return messages.map((entry) => entry.id === message.id ? message : entry);
  }
  if (selectBranch) {
    if (message.parent_id === null) return [message];
    const parentIndex = messages.findIndex((entry) => entry.id === message.parent_id);
    if (parentIndex >= 0) return [...messages.slice(0, parentIndex + 1), message];
  }
  return [...messages, message];
}

export function reduceChatEvent(state: ChatState, event: SseEvent, conversationId: string): ChatState {
  switch (event.type) {
    case 'start': {
      if (event.message && event.message.conversation_id !== conversationId) return state;
      const existing = state.messages.find((message) => message.id === event.messageId);
      // A replayed start must not clear a snapshot or reopen a completed response.
      if (existing) return state;
      const messages = event.userMessage ? upsert(state.messages, event.userMessage, true) : state.messages;
      const placeholder: Message = event.message ?? {
        id: event.messageId, conversation_id: conversationId,
        parent_id: event.userMessage?.id ?? state.detail?.conversation.head_message_id ?? null,
        role: 'assistant', content: '', status: 'streaming', meta: {}, bookmarked: false,
        created_at: new Date().toISOString(), siblings: { index: 0, count: 1, ids: [event.messageId] },
        eventVersion: event.eventVersion, events: [],
      };
      return { ...state, messages: upsert(messages, placeholder, true), generating: true, streamingId: event.messageId };
    }
    case 'token': {
      if (event.eventVersion !== 1 || !Array.isArray(event.events)) {
        return { ...state, error: EVENT_CONTRACT_UNAVAILABLE };
      }
      if (event.messageId !== state.streamingId) return state;
      return { ...state, messages: state.messages.map((message) => message.id === event.messageId && message.status === 'streaming'
        ? { ...message, eventVersion: 1, events: event.events } : message) };
    }
    case 'done': {
      if (event.message.conversation_id !== conversationId) return state;
      const complete = event.message.status === 'complete';
      const settlesActive = !state.streamingId || state.streamingId === event.message.id;
      return {
        ...state, messages: upsert(state.messages, event.message),
        generating: settlesActive ? false : state.generating,
        streamingId: settlesActive ? null : state.streamingId,
        lastBudget: settlesActive && complete && event.budget ? event.budget : state.lastBudget,
        budgetAtHead: settlesActive && complete && event.budget ? event.message.id : state.budgetAtHead,
      };
    }
    case 'aux':
      if (event.message.conversation_id !== conversationId) return state;
      return { ...state, messages: upsert(state.messages, event.message, true) };
    case 'error': {
      const id = event.messageId ?? state.streamingId;
      const settlesActive = !state.streamingId || id === state.streamingId;
      return {
        ...state,
        messages: state.messages.map((message) => message.id === id
          ? { ...message, status: 'error', meta: { ...message.meta, error: event.message } } : message),
        generating: settlesActive ? false : state.generating,
        streamingId: settlesActive ? null : state.streamingId, error: event.message,
      };
    }
  }
}
