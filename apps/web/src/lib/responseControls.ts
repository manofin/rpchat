import type { Message, ResponseLength } from '../types';

export type SideMode = 'summary' | 'community';

export const RESPONSE_LENGTHS: ReadonlyArray<{ value: ResponseLength; label: string }> = [
  { value: 'short', label: '짧게' },
  { value: 'normal', label: '보통' },
  { value: 'long', label: '길게' },
];

export function buildResponseLengthPatch(value: string): { scene: { response_length: ResponseLength } } | null {
  if (value !== 'short' && value !== 'normal' && value !== 'long') return null;
  return { scene: { response_length: value } };
}

export function parseSideModeCommand(draft: string): { mode: SideMode; prompt?: string } | null {
  const command = draft.trim().match(/^\/(요약|심층갤)(?:\s+([\s\S]*))?$/);
  if (!command) return null;
  const prompt = command[2]?.trim();
  return { mode: command[1] === '요약' ? 'summary' : 'community', ...(prompt ? { prompt } : {}) };
}

export function sideModeLabel(mode: SideMode): string {
  return mode === 'summary' ? '이야기 요약' : '심층갤';
}

export function continuationTarget(messages: Message[]): Message | null {
  const last = messages.at(-1);
  if (!last || last.role !== 'assistant' || !['complete', 'interrupted'].includes(last.status) || last.meta.side_mode) return null;
  return last;
}
