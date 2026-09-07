/**
 * clock-advance-observe (ADR-F9c §8.2, token `clock-advance-observe-implement`)
 *
 * Record the model's `advance_minutes` proposal. Do not apply it. The clock stays
 * frozen; the delta prompt stays byte-identical to the pre-reframe judge.
 *
 * `CANDIDATE_SERVER_DEFAULT_MINUTES = 2` is an evaluation-only prior. Missing keys
 * do not receive it. Aggregation later compares the live distribution to 1 / 2 /
 * 3 / 5; this module never writes a default into the scene.
 *
 * The payload is derived flags only: no user text, no model text, no scene blob,
 * no line/thought. `applySceneDelta` still honours the key when a caller passes
 * it; the product generate path strips the key before `planBeat`.
 *
 * Pure: no DB, no fetch, no model.
 */
import { ADVANCE_MINUTES_MAX } from './applySceneDelta.js';

/** Prompt framing in force while this slice is live. Reframing is a later compare. */
export const CLOCK_OBSERVE_FRAMING = 'pre-reframe' as const;

/** Evaluation-only prior. Not applied. */
export const CANDIDATE_SERVER_DEFAULT_MINUTES = 2;

export const CLOCK_OBSERVE_TARGET_N = 100;
export const CLOCK_OBSERVE_MIN_N = 50;
export const CLOCK_OBSERVE_WINDOW_DAYS = 14;

/**
 * Tokens the ADR used to count explicit time language in live user turns.
 * Presence is a boolean, not a parsed duration — the model may still omit the key.
 */
export const USER_TIME_EXPRESSION = /분|시간|뒤|후|이따|나중/;

/** Throwaway rooms used for live proof. Their turns are logged but not in_sample. */
export const CANARY_TITLE = /CANARY/i;

export type ClockObserveKind = 'unparsed' | 'missing' | 'zero' | 'positive' | 'invalid';
export type ClockParseStatus = 'ok' | 'null' | 'fail';
export type ClockObservePath = 'beat' | 'dialog' | 'hunter';
export type ClockObserveOutcome = 'success' | 'fail' | 'interrupt';
export type ClockInvalidReason = 'type' | 'range' | null;

export type ClockObserveCore = {
  framing: typeof CLOCK_OBSERVE_FRAMING;
  candidate_default: typeof CANDIDATE_SERVER_DEFAULT_MINUTES;
  parse: ClockParseStatus;
  key_present: boolean;
  raw_type: string;
  kind: ClockObserveKind;
  value: number | null;
  invalid_reason: ClockInvalidReason;
  user_time_expression: boolean;
  applied: false;
};

export type ClockObserve = ClockObserveCore & {
  path: ClockObservePath;
  stage: string | null;
  discarded: boolean;
  regenerate: boolean;
  canary: boolean;
  outcome: ClockObserveOutcome;
  /** Default-duration sample: successful, not regen, not canary. */
  in_sample: boolean;
};

export function hasUserTimeExpression(userText: string): boolean {
  return USER_TIME_EXPRESSION.test(userText);
}

export function isCanaryTitle(title: string | null | undefined): boolean {
  return CANARY_TITLE.test(title ?? '');
}

function rawTypeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export function classifyClockObserve(
  patch: Record<string, unknown> | null,
  userText: string,
  parse: ClockParseStatus = patch === null ? 'null' : 'ok',
): ClockObserveCore {
  const base = {
    framing: CLOCK_OBSERVE_FRAMING,
    candidate_default: 2 as const,
    parse,
    user_time_expression: hasUserTimeExpression(userText),
    applied: false as const,
  };
  if (parse !== 'ok' || patch === null) {
    return {
      ...base,
      key_present: false,
      raw_type: 'absent',
      kind: 'unparsed',
      value: null,
      invalid_reason: null,
    };
  }
  if (!Object.prototype.hasOwnProperty.call(patch, 'advance_minutes')) {
    return {
      ...base,
      key_present: false,
      raw_type: 'absent',
      kind: 'missing',
      value: null,
      invalid_reason: null,
    };
  }
  const v = patch.advance_minutes;
  const raw_type = rawTypeOf(v);
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= ADVANCE_MINUTES_MAX) {
    return {
      ...base,
      key_present: true,
      raw_type,
      kind: v === 0 ? 'zero' : 'positive',
      value: v,
      invalid_reason: null,
    };
  }
  const rangeLike = typeof v === 'number' && Number.isFinite(v);
  return {
    ...base,
    key_present: true,
    raw_type,
    kind: 'invalid',
    value: rangeLike ? v : null,
    invalid_reason: rangeLike ? 'range' : 'type',
  };
}

export function decorateClockObserve(
  core: ClockObserveCore,
  d: {
    path: ClockObservePath;
    stage: string | null;
    discarded: boolean;
    regenerate: boolean;
    canary: boolean;
    outcome: ClockObserveOutcome;
  },
): ClockObserve {
  return {
    ...core,
    path: d.path,
    stage: d.stage,
    discarded: d.discarded,
    regenerate: d.regenerate,
    canary: d.canary,
    outcome: d.outcome,
    in_sample: d.outcome === 'success' && !d.regenerate && !d.canary,
    applied: false,
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
  parse: ClockParseStatus = parsed === null ? 'null' : 'ok',
): { patch: Record<string, unknown> | undefined; observe: ClockObserveCore } {
  return {
    observe: classifyClockObserve(parsed, userText, parse),
    patch: stripAdvanceMinutes(parsed) ?? undefined,
  };
}
