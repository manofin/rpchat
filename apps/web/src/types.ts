export interface Character {
  id: string;
  name: string;
  tagline: string;
  avatar: string | null;
  description: string;
  personality: string;
  speech_style: string;
  scenario: string;
  first_message: string;
  example_dialogue: string;
  taboos: string;
  tags: string[];
  archived: boolean;
  created_at: string;
  updated_at: string;
  conversation_count?: number;
  last_chat_at?: string | null;
}

export interface Persona {
  id: string;
  name: string;
  address_as: string;
  appearance: string;
  personality: string;
  relationship: string;
  is_default: boolean;
}

export interface Scene {
  place?: string;
  time?: string;
  goal?: string;
  genre?: string;
  conflict?: string;
  mood?: string;
}

export interface Conversation {
  id: string;
  character_id: string;
  persona_id: string | null;
  title: string;
  mode: 'chat' | 'story';
  profile_name: string;
  scene: Scene;
  head_message_id: string | null;
  prompt_version: string;
  favorite: boolean;
  archived: boolean;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  character_name?: string;
  preview?: string;
}

export type MessageStatus = 'streaming' | 'complete' | 'interrupted' | 'error';

export interface Message {
  id: string;
  conversation_id: string;
  parent_id: string | null;
  role: 'user' | 'assistant';
  content: string;
  status: MessageStatus;
  meta: {
    usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
    finish_reason?: string | null;
    choices?: string[];
    ooc?: boolean;
    error?: string;
  };
  bookmarked: boolean;
  created_at: string;
  siblings: { index: number; count: number; ids: string[] };
}

export interface ConversationDetail {
  conversation: Conversation;
  character: Character;
  persona: Persona | null;
  messages: Message[];
  activeGeneration: { id: string; messageId: string; startedAt: string } | null;
}

export interface Memory {
  id: string;
  conversation_id: string | null;
  character_id: string | null;
  content: string;
  source: 'user' | 'model';
  status: 'candidate' | 'pinned' | 'rejected';
  importance: number;
  scope: 'conversation' | 'character';
  created_at: string;
}

export interface Summary {
  id: string;
  conversation_id: string;
  content: string;
  status: 'draft' | 'approved';
  created_at: string;
}

export interface ModelProfile {
  name: string;
  model: string | null;
  temperature: number;
  top_p: number;
  max_tokens: number;
  stop: string[];
  system_mode: 'system' | 'merge';
  notes: string | null;
}

export interface BudgetReport {
  context_tokens: number;
  reply_reserve: number;
  available: number;
  calibration: number;
  sections: Array<{ name: string; est_tokens: number; budget: number; note?: string }>;
  est_total: number;
  dropped_messages: number;
  included_messages: number;
  active_lore: string[];
  dropped_lore: string[];
}

export interface PromptPreview {
  messages: Array<{ role: string; content: string }>;
  budget: BudgetReport;
  model: string;
  profile: ModelProfile & { stop_json?: string };
  stop: string[];
  isOoc: boolean;
}

export interface Health {
  ok: boolean;
  time: string;
  db: string;
  model: { ok: boolean; checkedAt: string; latencyMs: number | null; models: string[]; error?: string; resolvedModel: string; contextTokens: number };
  generation: { active: Array<{ id: string; conversationId: string; messageId: string; startedAt: string }>; queued: number };
  promptVersion: string;
  authMode: 'tailscale' | 'token' | 'none';
}

export type SseBudget = {
  dropped_messages: number;
  included_messages: number;
  est_total: number;
  available: number;
};

export type SseEvent =
  | { type: 'start'; generationId: string; messageId: string; userMessage?: Message }
  | { type: 'token'; text: string }
  | { type: 'done'; message: Message; usage: unknown; ttftMs: number | null; totalMs: number; budget?: SseBudget }
  | { type: 'error'; message: string; messageId?: string };
