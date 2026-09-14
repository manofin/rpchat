import { post } from './api';
import { FIELD_LIMITS } from './characterFieldLimits';

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

export const AUTHORING_FIELD_LABELS: Record<AuthoringTargetField, string> = {
  tagline: '한 줄 소개',
  description: '설명 / 배경',
  personality: '성격',
  speech_style: '말투',
  scenario: '기본 장면 / 시나리오',
  first_message: '첫 메시지',
  example_dialogue: '예시 대화',
  taboos: '금기 / 하지 말 것',
  play_guide: '플레이 가이드',
};

export type GenerateFieldRequest = {
  targetField: AuthoringTargetField;
  prompt: string;
  name?: string;
  characterId?: string;
  context?: Partial<Record<AuthoringTargetField, string>>;
};

export type GenerateFieldResponse = {
  targetField: AuthoringTargetField;
  text: string;
  profile: 'authoring';
  finish_reason: string;
  usage: { prompt_tokens: number; completion_tokens: number };
};

export function generateCharacterField(req: GenerateFieldRequest): Promise<GenerateFieldResponse> {
  return post<GenerateFieldResponse>('/api/characters/generate', req);
}

export function applyAndClipGeneratedField(
  field: AuthoringTargetField,
  current: string,
  generated: string,
  mode: 'replace' | 'append',
): string {
  const base = current ?? '';
  const next = mode === 'replace' ? generated : (base.trim() ? `${base}\n${generated}` : generated);
  const max = FIELD_LIMITS[field];
  return next.length > max ? next.slice(0, max) : next;
}
