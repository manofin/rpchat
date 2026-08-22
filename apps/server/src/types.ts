export interface ModelProfile {
  name: string;
  model: string | null;
  temperature: number;
  top_p: number;
  max_tokens: number;
  stop_json: string;
  system_mode: 'system' | 'merge';
  notes: string | null;
}

export interface CharacterRow {
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
  tags_json: string;
  scene_background: string | null;
  voice_profile: string | null;
  archived: number;
  created_at: string;
  updated_at: string;
}

export interface PersonaRow {
  id: string;
  name: string;
  address_as: string;
  appearance: string;
  personality: string;
  relationship: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

export interface LoreEntryRow {
  id: string;
  lorebook_id: string;
  title: string;
  keywords_json: string;
  secondary_keys_json: string;
  content: string;
  priority: number;
  always_on: number;
  token_cap: number;
  enabled: number;
  selective: number;
}

export interface Scene {
  place?: string;
  time?: string;
  goal?: string;
  genre?: string;
  conflict?: string;
  mood?: string;
}

export interface ConversationRow {
  id: string;
  character_id: string;
  persona_id: string | null;
  title: string;
  mode: 'chat' | 'story';
  profile_name: string;
  scene_json: string;
  head_message_id: string | null;
  prompt_version: string;
  favorite: number;
  archived: number;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
}

export type MessageStatus = 'streaming' | 'complete' | 'interrupted' | 'error';

export interface MessageMeta {
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  finish_reason?: string | null;
  choices?: string[];
  ooc?: boolean;
  profile?: string;
  prompt_version?: string;
  generation_id?: string;
  error?: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  parent_id: string | null;
  role: 'user' | 'assistant';
  content: string;
  status: MessageStatus;
  meta_json: string;
  bookmarked: number;
  created_at: string;
}

export interface MemoryRow {
  id: string;
  conversation_id: string | null;
  character_id: string | null;
  content: string;
  source: 'user' | 'model';
  status: 'candidate' | 'pinned' | 'rejected' | 'superseded';
  importance: number;
  scope: 'conversation' | 'character';
  evidence_message_ids_json: string;
  created_at: string;
  updated_at: string;
}

export interface SummaryRow {
  id: string;
  conversation_id: string;
  content: string;
  covers_until_message_id: string | null;
  status: 'draft' | 'approved';
  created_at: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// 프롬프트 빌더가 반환하는 예산 보고서 (화면의 "프롬프트 미리보기"에 그대로 표시)
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
