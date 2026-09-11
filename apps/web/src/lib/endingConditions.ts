import type { StoryEnding } from '../types';

/**
 * ADR-F8h 후속 "엔딩 조건 저작 UI (StoryEditor 확장)".
 * 폼 드래프트 ⇄ wire `conditions` 변환 (순수 함수, React 없음 — 벤치에서 직접 import).
 *
 * 정제 규칙 (서버 PUT 400과 보조를 맞춤):
 * - min_turns: 1 이상 정수만 송신. 0/음수/NaN은 생략 (서버가 0·음수를 400으로 거부).
 * - required_stats: 빈 Key·NaN min 행은 버린다. UI는 최소치(gte)만 저작하고,
 *   API経由 등 외부에서 들어온 lte는 드래프트에 carrying해 유실 없이 되돌린다.
 * - required_flags: trim 후 빈 문자열 제거 + 중복 제거.
 * - narrative_hint: trim 후 빈 문자열은 생략.
 * - 전부 비면 `conditions` 자체를 undefined (빈 객체 `{}` 송신 금지 —
 *   서버 read 경로가 `{}`를 "통과할 규칙 없음"으로 읽기 때문이다, stories.ts).
 */

export type EndingConditions = NonNullable<StoryEnding['conditions']>;

export interface StatRow {
  key: string;
  /** 폼 문자열. wire로는 number(gte). */
  min: string;
  /** UI 미표시 carrying 값: 외부 저작 lte 보존용. */
  lte?: string;
}

export interface ConditionsDraft {
  minTurns: string;
  stats: StatRow[];
  flags: string[];
  hint: string;
}

export function emptyConditionsDraft(): ConditionsDraft {
  return { minTurns: '', stats: [], flags: [], hint: '' };
}

/** wire → 폼. damaged/partial 입력에도 절대 throw하지 않는다. */
export function conditionsToDraft(c: EndingConditions | undefined): ConditionsDraft {
  if (!c || typeof c !== 'object') return emptyConditionsDraft();
  const stats: StatRow[] = [];
  const raw = c.required_stats;
  if (raw && typeof raw === 'object') {
    for (const [key, bound] of Object.entries(raw)) {
      if (typeof key !== 'string' || !key) continue;
      const gte = (bound as { gte?: unknown } | null)?.gte;
      const lte = (bound as { lte?: unknown } | null)?.lte;
      stats.push({
        key,
        min: typeof gte === 'number' && Number.isFinite(gte) ? String(gte) : '',
        ...(typeof lte === 'number' && Number.isFinite(lte) ? { lte: String(lte) } : {}),
      });
    }
  }
  const flags = Array.isArray(c.required_flags) ? c.required_flags.filter((f): f is string => typeof f === 'string') : [];
  return {
    minTurns: typeof c.min_turns === 'number' && Number.isInteger(c.min_turns) ? String(c.min_turns) : '',
    stats,
    flags,
    hint: typeof c.narrative_hint === 'string' ? c.narrative_hint : '',
  };
}

/** 폼 → wire. 전부 비면 undefined. */
export function buildConditions(d: ConditionsDraft): EndingConditions | undefined {
  const out: EndingConditions = {};
  const n = Number(d.minTurns);
  if (Number.isInteger(n) && n >= 1) out.min_turns = n;
  const stats: Record<string, { gte?: number; lte?: number }> = {};
  for (const row of d.stats) {
    const key = row.key.trim();
    const min = Number(row.min);
    if (!key || !Number.isFinite(min)) continue;
    if (key in stats) continue;
    const bound: { gte?: number; lte?: number } = { gte: min };
    const lte = row.lte !== undefined ? Number(row.lte) : NaN;
    if (Number.isFinite(lte)) bound.lte = lte;
    stats[key] = bound;
  }
  if (Object.keys(stats).length > 0) out.required_stats = stats;
  const flags = [...new Set(d.flags.map((f) => f.trim()).filter((f) => f.length > 0))];
  if (flags.length > 0) out.required_flags = flags;
  const hint = d.hint.trim();
  if (hint) out.narrative_hint = hint;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 비용 고지 조건: hint가 비어 있지 않으면 백그라운드 LLM 판정 비용 발생. */
export function hasNarrativeHint(d: ConditionsDraft): boolean {
  return d.hint.trim().length > 0;
}
