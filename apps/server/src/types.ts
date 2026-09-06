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

export interface StoryRow {
  id: string;
  name: string;
  tagline: string;
  setting: string;
  minor_cast: string;
  /** f9-place-catalog: JSON SceneCatalog. '{}' = no catalog (every delta key rejected). */
  scene_catalog: string;
  archived: number;
  created_at: string;
  updated_at: string;
}

export interface StoryCharacterRow {
  story_id: string;
  character_id: string;
  role: string;
  sort_order: number;
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
  clock_minutes?: number;
  weather?: string;
  location?: string;
  stage?: string;
  arc?: string;
  flags?: Array<{ key: string; owner_stage?: string }>;
  /** f9-presence-model: who is actually in the scene. Scene-owned, not character-owned. */
  present_ids?: string[];
  scene_version?: number;
  /**
   * f9-beat-render (0012): server-owned beat state. Every key is optional, so a
   * conversation that has never run a beat keeps byte-identical scene_json.
   * None of these is in applySceneDelta's APPLY_KEYS — the model cannot propose them.
   */
  day_index?: number;
  weekday?: string;
  beat_goal?: string;
  roster?: Record<string, { emotion?: string; outfit?: string; note?: string }>;
  user_sheet?: {
    hp?: number | null;
    money?: number | null;
    gear?: string[];
    inventory?: string[];
    traits?: string[];
  };
  last_beat?: { focus_id: string | null; extra_ids: string[]; unresolved: string[] };
  /**
   * dialog-format — the Dialog.txt-class output shape (INFO 상태 블록 + `이름 | 대사`
   * 스크립트). Absent means `'beat'`: every conversation that predates this slice
   * renders exactly as before, and `scene_json` stays byte-identical until someone
   * opts in. The switch is scene state, so it is per-conversation and never a
   * global flag.
   *
   * hunter-format — the Huntt.txt-class shape: `『』` 서술 + `💬 이름│"대사"` +
   * 턴 끝의 INFO 패널. Same opt-in rule, same byte-stability guarantee.
   */
  format?: 'beat' | 'dialog' | 'hunter';
  /** The `[T-n]` counter. Server-incremented, one per committed dialog beat. */
  turn_no?: number;
  /** `[이틀 뒤·오전 11시 35분]` — a written phrase, not a clock the server can do math on. */
  time_phrase?: string;
  /**
   * The INFO status block. Free text by design: the fields a given world needs
   * (계약, 침식, 성흔 …) are not knowable in advance, so the labels are data.
   * Server/user-owned — none of this is in applySceneDelta's APPLY_KEYS.
   */
  info?: {
    /** `[정보]` segments after the protagonist's name: 신분 · 전투상태 · 소속 … */
    status?: string[];
    /** `[계약]` */
    contract?: string;
    /** `[침식]` */
    erosion?: string;
    /** `[목표]` — rendered ` / `-joined. */
    goals?: string[];
    /** Extra labeled rows, appended in order after 목표. */
    extra?: Array<{ label: string; value: string }>;
  };
  /**
   * hunter-format — the identity half of the INFO panel. Server/user-owned: none
   * of this is in applySceneDelta's APPLY_KEYS, so the model can never promote
   * itself a grade, a patron or a skill. The panel's written half (표정·감정·
   * 속마음·일정·상황) is not stored here at all — it is produced per turn by
   * `hunterScript.parseHunterState` and lives only in the rendered panel block,
   * which keeps `scene_json` free of per-turn churn.
   *
   * 💼/💰 deliberately have no field here: they are `user_sheet.inventory` and
   * `user_sheet.money`, so the existing `inventory_add`/`money_delta` deltas keep
   * working in this format instead of being forked.
   */
  hunter?: {
    /** `🗓 26.03.02.` — a written date. The weekday comes from `scene.weekday`. */
    date?: string;
    /** `🪪` row: 남 / 여 / … */
    gender?: string;
    /** `🪪` row: 무소속, 방주 길드 … */
    affiliation?: string;
    /** `✨️ 금강불괴│-│육체 강도·정신 내성 극대화` */
    trait?: { name?: string; grade?: string; note?: string };
    /** `💠 달마│골수 통찰·요마 제도의 가호` */
    patron?: { name?: string; note?: string };
    /** `📚: [나한복마인]` */
    skills?: string[];
    /** `🎯퀘스트` — survives turns, so it is state and not a per-turn field. */
    quest?: string;
    /** `📝일정` fallback for a turn whose state block proposed none. */
    schedule?: string;
    /** `📖상황` fallback. */
    situation?: string;
    /** `💬`/`⚔️` default mark. MODE_ICONS is the allow-list. */
    mode?: string;
  };
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
  user_note: string | null;
  persona_name_snapshot: string | null;
  persona_address_snapshot: string | null;
  persona_appearance_snapshot: string | null;
  persona_personality_snapshot: string | null;
  persona_relationship_snapshot: string | null;
  persona_applied_at: string | null;
  story_id: string | null;
  story_applied_at: string | null;
  story_name_snapshot: string | null;
  story_setting_snapshot: string | null;
  story_minor_cast_snapshot: string | null;
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
  speaker_character_id?: string;
  speaker_name?: string;
  speaker_avatar?: string | null;
  /**
   * f9-swap-passes: which §6 slot this row is. Absent on every 1:1 message and on
   * every row written before the beat engine, so the client keeps rendering those
   * as ordinary bubbles.
   */
  block_kind?: 'header' | 'narration' | 'line' | 'thought' | 'ui' | 'info' | 'panel' | 'system';
  /** Position within the beat. The client sorts on this, not on arrival order. */
  beat_seq?: number;
  /** Server-chosen local asset path, or absent. Never a model-written URL. */
  image_url?: string;
  /**
   * scene-branch-snapshot: on a turn's first block (`beat_seq: 0`) only — the scene
   * this generation planned against and the scene it committed (validated delta
   * plus server-owned `last_beat` / `turn_no`). Stamped after a successful finish,
   * so an interrupted turn has none. Absent on every 1:1 row, every later block,
   * and every turn written before that slice, all of which fall back to
   * `conversations.scene_json`.
   *
   * Shape is validated on read (`db/sceneBase.ts`), not by this type: these rows
   * come back from a JSON column that older builds also wrote to.
   */
  scene_state?: {
    schema_version: number;
    before_delta: Scene;
    after_delta: Scene;
  };
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
  covers_from_message_id: string | null;
  rolled_up_into: string | null;
  tier: 'scene' | 'episode' | 'whole' | 'state';
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
  // kind: 출처 라벨(선택). 인스펙터 표시 전용 메타 — 프롬프트 바이트에는 들어가지 않는다.
  sections: Array<{ name: string; est_tokens: number; budget: number; note?: string; kind?: 'system' | 'story' | 'lore' | 'memory' | 'summary' | 'recent' }>;
  est_total: number;
  dropped_messages: number;
  included_messages: number;
  active_lore: string[];
  dropped_lore: string[];
  included_memories: string[];
  dropped_memories: string[];
  summary_used: boolean;
  summary_preview: string | null;
  recent_from_id: string | null;
  recent_to_id: string | null;
  diagnostics?: BudgetDiagnostics;
}

export interface BudgetDiagnostics {
  lore: Array<{ title: string; alwaysOn: boolean; matched: string[]; tokens: number; included: boolean; status: 'active' | 'dropped-budget' | 'no-match' }>;
  memories: Array<{ content: string; status: 'included' | 'dropped-budget'; importance: number; tokens: number }>;
  summaries: Array<{ tier: 'state' | 'whole' | 'scene' | 'episode'; used: boolean; tokens: number; note?: string }>;
}
