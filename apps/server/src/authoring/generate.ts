import type { ChatMessage } from '../types.js';

/** Code constant — not a model_profiles row. Do not loadProfile('authoring'). */
export const AUTHORING_PROFILE = {
  name: 'authoring' as const,
  temperature: 0.7,
  top_p: 0.9,
  max_tokens: 1500,
  model: null as string | null,
  stop: [] as string[],
  system_mode: 'system' as const,
};

export const AUTHORING_TARGET_FIELDS = [
  'tagline',
  'description',
  'personality',
  'speech_style',
  'scenario',
  'first_message',
  'example_dialogue',
  'taboos',
  'play_guide',
] as const;

export type AuthoringTargetField = (typeof AUTHORING_TARGET_FIELDS)[number];

/** Matches characterSchema .max and web characterFieldLimits (authoring targets only). */
export const AUTHORING_FIELD_LIMITS: Record<AuthoringTargetField, number> = {
  tagline: 200,
  description: 20000,
  personality: 10000,
  speech_style: 10000,
  scenario: 10000,
  first_message: 10000,
  example_dialogue: 20000,
  taboos: 5000,
  play_guide: 500,
};

export const AUTHORING_FIELD_MAX_TOKENS: Record<AuthoringTargetField, number> = {
  tagline: 80,
  description: 400,
  personality: 400,
  speech_style: 400,
  taboos: 400,
  first_message: 500,
  scenario: 600,
  example_dialogue: 600,
  play_guide: 600,
};

export const AUTHORING_CONTEXT_KEYS = [...AUTHORING_TARGET_FIELDS, 'name'] as const;
export type AuthoringContextKey = (typeof AUTHORING_CONTEXT_KEYS)[number];
export type AuthoringContext = Partial<Record<AuthoringContextKey, string | null | undefined>>;

export const AUTHORING_SYSTEM =
  'AUTHORING_ISOLATED v1. Unrelated to chat sessions. ' +
  'Write only the requested character-card field as plain text. ' +
  'Do not roleplay a turn. Do not emit JSON wrappers.';

export function overlayAuthoringContext(
  dbRow: AuthoringContext | null | undefined,
  draft: AuthoringContext | null | undefined,
  name: string | null | undefined,
): Record<string, string> {
  const merged: Record<string, string> = {};
  if (dbRow) {
    for (const k of AUTHORING_CONTEXT_KEYS) {
      const v = dbRow[k];
      if (v != null && v !== '') merged[k] = String(v);
    }
  }
  if (draft) {
    for (const k of AUTHORING_CONTEXT_KEYS) {
      const v = draft[k];
      if (v != null) merged[k] = String(v);
    }
  }
  if (name != null && name.trim() !== '') merged.name = name;
  return merged;
}

export function assembleAuthoringMessages(
  targetField: AuthoringTargetField,
  prompt: string,
  merged: Record<string, string>,
): ChatMessage[] {
  const lines = [`targetField: ${targetField}`, `name: ${merged.name ?? ''}`, 'existing:'];
  for (const k of AUTHORING_TARGET_FIELDS) {
    if (k === targetField) continue;
    const val = (merged[k] ?? '').trim();
    if (val) lines.push(`- ${k}: ${val}`);
  }
  lines.push('instruction:', prompt);
  return [
    { role: 'system', content: AUTHORING_SYSTEM },
    { role: 'user', content: lines.join('\n') },
  ];
}

export function truncateAuthoringText(targetField: AuthoringTargetField, text: string): string {
  const limit = AUTHORING_FIELD_LIMITS[targetField];
  return text.length > limit ? text.slice(0, limit) : text;
}
