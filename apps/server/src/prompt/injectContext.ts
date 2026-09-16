/**
 * inject-macro-api — optional per-turn instruction carrier.
 * This slice accepts + bounds only; attach happens in later slices.
 */

/** 800 = input-validation ceiling (abuse bound), NOT a guarantee that party multi-pass prepend is budget-safe */
export const INJECT_INSTRUCTION_MAX = 800;

export type InjectContext = {
  instruction: string | null;
};

/**
 * Parse optional `inject_instruction` from a request body field.
 * - absent / empty (after trim) → instruction null
 * - present → trim; hard max INJECT_INSTRUCTION_MAX (JS string `.length`)
 * - over max → reject (never silent truncate)
 */
export function parseInjectInstruction(
  raw: unknown,
): { ok: true; ctx: InjectContext } | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, ctx: { instruction: null } };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: 'inject_instruction must be a string' };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, ctx: { instruction: null } };
  }
  if (trimmed.length > INJECT_INSTRUCTION_MAX) {
    return {
      ok: false,
      error: `inject_instruction exceeds max length ${INJECT_INSTRUCTION_MAX} (got ${trimmed.length})`,
    };
  }
  return { ok: true, ctx: { instruction: trimmed } };
}
