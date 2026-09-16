/**
 * inject-macro — optional per-turn instruction carrier.
 * api = accept + bound; 1to1 attaches on buildPrompt; party IC passes attach via
 * attachInjectToIcPass → prependInjectToRules (N/F/E/S/H). Pass C / scene delta /
 * plan stay untouched.
 *
 * Budget: INJECT_INSTRUCTION_MAX (800) is validation-only at the API — not a
 * guarantee that party multi-pass prepend is budget-safe. The instruction is
 * prepended **in full on every IC pass** (pass-multiplication cost). Under
 * pressure, attachInjectToIcPass shrinks the Pass N recent-narrations section
 * (`## 앞서 이미 서술된 것`) first — never truncate/cut inject. If inject +
 * protected fixed parts still exceed the pass prompt budget → explicit throw.
 */

import { estimateTokens } from './tokens.js';

/** 800 = input-validation ceiling (abuse bound), NOT a guarantee that party multi-pass prepend is budget-safe */
export const INJECT_INSTRUCTION_MAX = 800;

/** Heading prefix for the only shrinkable party-IC section (Pass N recent narrations). */
const RECENT_NARRATIONS_HEADING = '## 앞서 이미 서술된 것';

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
 * dialog S, and hunter H all reach this via attachInjectToIcPass; do not
 * copy-paste a second attach path.
 *
 * - null / empty → return prompt unchanged (byte-stable omit)
 * - non-null → full string, never silent-truncated
 * - missing `## 규칙` → throw (IC passes today all have the header; do not invent
 *   a fallback attach site)
 *
 * Budget: INJECT_INSTRUCTION_MAX (800) is validation-only at the API. The
 * instruction is prepended **in full on every IC pass** (pass-multiplication
 * cost). Do not truncate here and do not change INJECT_INSTRUCTION_MAX. Recent
 * narrations shrink under pressure in attachInjectToIcPass — never cut the inject.
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

/**
 * Drop the oldest content line under `## 앞서 이미 서술된 것` (Pass N recent
 * narrations). Newest stays — same priority as 1:1 recent packing (build from
 * the end / keep newest). When the last content line is dropped, remove the
 * whole section (header + trailing blanks) so the prompt matches the
 * "no recent" shape from renderPassN.
 *
 * Returns null when there is no shrinkable section / nothing left to drop.
 * Does not touch: ## 방금 서술된 것, ## 방금 일어난 일, cast/roster/scene,
 * ## 규칙 base rules, or inject text.
 */
function dropOldestRecentNarrationLine(prompt: string): string | null {
  const lines = prompt.split('\n');
  const headerIdx = lines.findIndex((l) => l.startsWith(RECENT_NARRATIONS_HEADING));
  if (headerIdx < 0) return null;

  let endIdx = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      endIdx = i;
      break;
    }
  }

  const contentIndices: number[] = [];
  for (let i = headerIdx + 1; i < endIdx; i++) {
    if (lines[i].trim() !== '') contentIndices.push(i);
  }
  if (contentIndices.length === 0) return null;

  if (contentIndices.length === 1) {
    // Last recent line → drop the whole section (header..before next ##).
    return [...lines.slice(0, headerIdx), ...lines.slice(endIdx)].join('\n');
  }

  const dropAt = contentIndices[0]; // oldest first
  return [...lines.slice(0, dropAt), ...lines.slice(dropAt + 1)].join('\n');
}

export type AttachInjectToIcPassOpts = {
  /** Prompt-side token budget for this IC pass (context − completion max − margin). */
  promptTokenBudget: number;
  /** Token calibration (default 1.0; callers may pass getCalibration(db)). */
  calibration?: number;
};

/**
 * Thin party-IC wrapper around prependInjectToRules:
 * 1. null/empty instruction → byte-stable `{ prompt, droppedRecent: 0 }`
 * 2. else prepend full instruction under `## 규칙`
 * 3. if est ≤ budget → as-is (short inject: no unnecessary shrink)
 * 4. if over → drop oldest lines under `## 앞서 이미 서술된 것` until under budget
 * 5. if still over after all recent gone → throw (never truncate inject)
 */
export function attachInjectToIcPass(
  prompt: string,
  instruction: string | null | undefined,
  opts: AttachInjectToIcPassOpts,
): { prompt: string; droppedRecent: number } {
  if (instruction == null || instruction === '') {
    return { prompt, droppedRecent: 0 };
  }

  const cal = opts.calibration ?? 1.0;
  const budget = opts.promptTokenBudget;
  let current = prependInjectToRules(prompt, instruction);
  let droppedRecent = 0;

  while (estimateTokens(current, cal) > budget) {
    const next = dropOldestRecentNarrationLine(current);
    if (next == null) {
      const est = estimateTokens(current, cal);
      throw new Error(
        `attachInjectToIcPass: inject_instruction exceeds pass prompt budget ` +
          `(est=${est} budget=${budget}); inject is never truncated`,
      );
    }
    current = next;
    droppedRecent++;
  }

  return { prompt: current, droppedRecent };
}
