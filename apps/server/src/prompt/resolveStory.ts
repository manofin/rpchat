import type { ConversationRow } from '../types.js';

export function resolveStory(
  conv: ConversationRow,
): { name: string; setting: string; minorCast: unknown[] } | null {
  if (!conv.story_applied_at) return null;
  let minorCast: unknown[] = [];
  try {
    minorCast = JSON.parse(conv.story_minor_cast_snapshot ?? '[]');
  } catch {
    console.warn('[resolveStory] damaged story_minor_cast_snapshot');
  }
  return {
    name: conv.story_name_snapshot ?? '',
    setting: conv.story_setting_snapshot ?? '',
    minorCast,
  };
}
