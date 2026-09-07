/**
 * Client-side character card field max lengths.
 * Keep in sync with `characterSchema` in apps/server/src/routes/characters.ts (zod .max).
 */
export const FIELD_LIMITS = {
  name: 80,
  tagline: 200,
  avatar: 300,
  description: 20000,
  personality: 10000,
  speech_style: 10000,
  scenario: 10000,
  first_message: 10000,
  example_dialogue: 20000,
  taboos: 5000,
} as const;

export type LimitedField = keyof typeof FIELD_LIMITS;

export function fieldCountTone(length: number, max: number): 'ok' | 'warn' | 'err' {
  if (length >= max) return 'err';
  if (length >= Math.floor(max * 0.9)) return 'warn';
  return 'ok';
}

export function formatFieldCount(length: number, max: number): string {
  return `${length}/${max}`;
}

/** Fields that exceed their limit (e.g. legacy/imported drafts). */
export function overLimitFields(
  draft: Partial<Record<LimitedField, string | null | undefined>>,
): LimitedField[] {
  return (Object.keys(FIELD_LIMITS) as LimitedField[]).filter((k) => {
    const v = draft[k];
    return typeof v === 'string' && v.length > FIELD_LIMITS[k];
  });
}
