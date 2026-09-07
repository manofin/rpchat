/**
 * clock-advance-observe (ADR-F9c §8.2)
 *
 * Record the model's `advance_minutes` proposal. Do not apply it. The clock stays
 * frozen until `clock-advance` ships a chosen default (1 / 2 / 3 / 5).
 *
 * Classification is the B-3 matrix: missing vs explicit 0 vs valid positive vs
 * invalid. `applied` is always false in this slice — `applySceneDelta` still
 * honours the key when a caller passes it, so benches of the apply function stay
 * honest; the product generate path strips the key before `planBeat`.
 *
 * Pure: no DB, no fetch, no model.
 */
import { ADVANCE_MINUTES_MAX } from './applySceneDelta.js';

/** Prompt framing in force while this slice is live. Reframing is a later compare. */
export const CLOCK_OBSERVE_FRAMING = 'pre-reframe' as const;

/**
 * Tokens the ADR used to count explicit time language in live user turns.
 * Presence is a boolean, not a parsed duration — the model may still omit the key.
 */
export const USER_TIME_EXPRESSION = /분|시간|뒤|후|이따|나중/;

export type ClockObserveKind = 'unparsed' | 'missing' | 'zero' | 'positive' | 'invalid';

export type ClockObserve = {
  framing: typeof CLOCK_OBSERVE_FRAMING;
  kind: ClockObserveKind;
  raw_type: string;
  value: number | null;
  user_time_expression: boolean;
  /** Set after apply: true when the rest of the patch was discarded (stale version). */
  discarded: boolean;
  applied: false;
};

export function hasUserTimeExpression(userText: string): boolean {
  return USER_TIME_EXPRESSION.test(userText);
}

function rawTypeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export function classifyClockObserve(
  patch: Record<string, unknown> | null,
  userText: string,
): ClockObserve {
  const base = {
    framing: CLOCK_OBSERVE_FRAMING,
    user_time_expression: hasUserTimeExpression(userText),
    discarded: false,
    applied: false as const,
  };
  if (patch === null) {
    return { ...base, kind: 'unparsed', raw_type: 'absent', value: null };
  }
  if (!Object.prototype.hasOwnProperty.call(patch, 'advance_minutes')) {
    return { ...base, kind: 'missing', raw_type: 'absent', value: null };
  }
  const v = patch.advance_minutes;
  const raw_type = rawTypeOf(v);
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= ADVANCE_MINUTES_MAX) {
    return { ...base, kind: v === 0 ? 'zero' : 'positive', raw_type, value: v };
  }
  return {
    ...base,
    kind: 'invalid',
    raw_type,
    value: typeof v === 'number' && Number.isFinite(v) ? v : null,
  };
}

/** Drop the time key so apply cannot move the clock. Other keys pass through. */
export function stripAdvanceMinutes(
  patch: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (patch === null) return null;
  if (!Object.prototype.hasOwnProperty.call(patch, 'advance_minutes')) return patch;
  const { advance_minutes: _drop, ...rest } = patch;
  return rest;
}

export function holdClockProposal(
  parsed: Record<string, unknown> | null,
  userText: string,
): { patch: Record<string, unknown> | undefined; observe: ClockObserve } {
  return {
    observe: classifyClockObserve(parsed, userText),
    patch: stripAdvanceMinutes(parsed) ?? undefined,
  };
}
