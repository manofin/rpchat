/**
 * inject-macro — optional per-turn instruction carrier.
 * api = accept + bound; 1to1 attaches on buildPrompt; party IC passes prepend via
 * prependInjectToRules (N/F/E/S/H). Pass C / scene delta / plan stay untouched.
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

/**
 * Party IC-pass attach: insert `instruction` immediately after the `## 규칙`
 * header (before existing rule bullets). One format-agnostic hook — beat N/F/E,
 * dialog S, and hunter H all call this; do not copy-paste a second attach path.
 *
 * - null / empty → return prompt unchanged (byte-stable omit)
 * - non-null → full string, never silent-truncated
 * - missing `## 규칙` → throw (IC passes today all have the header; do not invent
 *   a fallback attach site)
 *
 * Budget: INJECT_INSTRUCTION_MAX (800) is validation-only at the API. The
 * instruction is prepended **in full on every IC pass** (pass-multiplication
 * cost). Do not truncate here and do not change INJECT_INSTRUCTION_MAX. If a
 * pass already shrinks recent/other slices under pressure, keep that behavior
 * and never cut the inject.
 *
 * Party IC passes apply inject regardless of 1:1 isOoc (party has no isOoc gate today).
 */
export function prependInjectToRules(prompt: string, instruction: string | null | undefined): string {
  if (instruction == null || instruction === '') return prompt;
  const header = '## 규칙';
  // Prefer the canonical `## 규칙\n` form every IC pass emits today.
  const withNl = `${header}\n`;
  let at = prompt.indexOf(withNl);
  if (at >= 0) {
    const insertAt = at + withNl.length;
    return prompt.slice(0, insertAt) + instruction + '\n' + prompt.slice(insertAt);
  }
  // Header as the final line (no trailing newline) — still fail closed if absent.
  if (prompt === header || prompt.endsWith(`\n${header}`)) {
    return `${prompt}\n${instruction}`;
  }
  throw new Error('prependInjectToRules: missing ## 규칙 header');
}
