/**
 * ADR-F8h Slice 2 (story-ending-eval-rule): rule-only ending evaluator.
 *
 * - Eligibility only. This module never writes `ended_at` (V1/V3).
 * - LLM 0회: `narrative_hint` is NOT evaluated here (slice 3 owns it).
 * - Turn = active-path (`getPath`) `role='user'` messages, OOC excluded.
 *   `scene.turn_no` is never read (§4.1) — dialog/hunter render counter,
 *   absent on beat rooms.
 * - Undefined stat = unmet (never 0 — 0 would accidentally pass `lte`).
 * - Pure function of (snapshot, scene, path, head): same
 *   (room, turn, ending, version) always yields the same suggestion, so
 *   duplicate jobs cannot produce duplicates (v1 stores nothing — §5.1:
 *   no 410 exists because past eligibility is unknowable).
 */
import type { DB } from './db/index.js';
import { parseJson } from './db/index.js';
import { getPath } from './db/tree.js';
import type { ConversationRow, MessageRow, Scene } from './types.js';
import type { StoryEnding, StoryEndingConditions } from './routes/stories.js';

/** D2: server constant, bumped only when evaluator logic changes. */
export const EVALUATION_VERSION = 1;

export interface RuleDetail {
  min_turns?: { need: number; have: number; pass: boolean };
  required_stats?: Record<string, { pass: boolean; missing: boolean }>;
  required_flags?: Record<string, { pass: boolean }>;
}

export interface RuleResult {
  /** false when the ending has no `conditions` (not a candidate — 제약 3). */
  candidate: boolean;
  pass: boolean;
  /** rule 충족 수 — ranking key. confidence는 정렬·권한에 사용 금지 (제약 5). */
  ruleCount: number;
  userTurns: number;
  detail: RuleDetail;
}

export interface EndingSuggestion {
  ending_id: string;
  title: string;
  turn_id: string | null;
  evaluation_version: number;
  rule_count: number;
}

export interface EndingSuggestions {
  turn_id: string | null;
  evaluation_version: number;
  suggestions: EndingSuggestion[];
}

/** Active-path user turns, OOC (`meta.ooc`) excluded. Format-independent. */
export function countUserTurns(path: MessageRow[]): number {
  let n = 0;
  for (const m of path) {
    if (m.role !== 'user') continue;
    const meta = parseJson<{ ooc?: boolean }>(m.meta_json, {});
    if (meta.ooc) continue;
    n++;
  }
  return n;
}

export function evalEndingRules(
  scene: Scene,
  userTurns: number,
  conditions: StoryEndingConditions | undefined,
): RuleResult {
  const empty: RuleResult = { candidate: false, pass: false, ruleCount: 0, userTurns, detail: {} };
  if (!conditions) return empty;
  const detail: RuleDetail = {};
  let count = 0;
  let pass = true;

  if (conditions.min_turns !== undefined) {
    const ok = userTurns >= conditions.min_turns;
    detail.min_turns = { need: conditions.min_turns, have: userTurns, pass: ok };
    count++;
    if (!ok) pass = false;
  }
  if (conditions.required_stats !== undefined) {
    const stats = scene.stats ?? {};
    const per: Record<string, { pass: boolean; missing: boolean }> = {};
    for (const [statId, bound] of Object.entries(conditions.required_stats)) {
      // Missing key = unmet, never 0 (§4.1).
      if (!(statId in stats)) {
        per[statId] = { pass: false, missing: true };
        pass = false;
        continue;
      }
      const v = stats[statId];
      const ok =
        (bound.gte === undefined || v >= bound.gte) && (bound.lte === undefined || v <= bound.lte);
      per[statId] = { pass: ok, missing: false };
      if (!ok) pass = false;
    }
    detail.required_stats = per;
    count++;
  }
  if (conditions.required_flags !== undefined) {
    const have = new Set((scene.flags ?? []).map((f) => f.key));
    const per: Record<string, { pass: boolean }> = {};
    for (const flag of conditions.required_flags) {
      const ok = have.has(flag);
      per[flag] = { pass: ok };
      if (!ok) pass = false;
    }
    detail.required_flags = per;
    count++;
  }
  // narrative_hint is slice-3 territory: never a rule gate, never re-checked
  // at confirm time (§5.1).
  return { candidate: true, pass, ruleCount: count, userTurns, detail };
}

/**
 * Confirm-time re-validation input: the room's live scene + live user-turn
 * count. The suggestion is never trusted (§5.1) — this is recomputed here.
 */
export function evalRoomEnding(
  db: DB,
  conv: ConversationRow,
  conditions: StoryEndingConditions | undefined,
): RuleResult {
  const scene = parseJson<Scene>(conv.scene_json, {});
  return evalEndingRules(scene, countUserTurns(getPath(db, conv)), conditions);
}

/**
 * Ranked candidates for one room at its current head. Pure: no writes,
 * no model, no clock. Ended rooms and non-story rooms yield [] (제약 1).
 */
export function suggestEndings(db: DB, conv: ConversationRow, endings: StoryEnding[]): EndingSuggestions {
  const turnId = conv.head_message_id;
  const base: EndingSuggestions = { turn_id: turnId, evaluation_version: EVALUATION_VERSION, suggestions: [] };
  if (conv.ended_at) return base;
  if (!conv.story_id) return base;
  const scene = parseJson<Scene>(conv.scene_json, {});
  const path = getPath(db, conv);
  const userTurns = countUserTurns(path);
  const ranked: EndingSuggestion[] = [];
  for (const e of endings) {
    const r = evalEndingRules(scene, userTurns, e.conditions);
    if (!r.candidate || !r.pass) continue;
    ranked.push({
      ending_id: e.id,
      title: e.title,
      turn_id: turnId,
      evaluation_version: EVALUATION_VERSION,
      rule_count: r.ruleCount,
    });
  }
  // Ranking: rule 충족 수 내림차순. confidence 미사용 (제약 5).
  ranked.sort((a, b) => b.rule_count - a.rule_count || (a.ending_id < b.ending_id ? -1 : 1));
  base.suggestions = ranked;
  return base;
}
