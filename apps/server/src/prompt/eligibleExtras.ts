/**
 * f9-focus-eligible — the closed candidate set for extra slots (§4.2).
 *
 *   eligible = in_room − user − focus − locked − 직전 extra 연속중복
 *
 * This module only *closes the list*. It never opens a slot: being eligible is a
 * necessary condition, and approval (§4.3, `approveExtras`) is the sufficient one.
 * Keeping the two apart is what makes "기본 전원 거절" expressible — an empty
 * approval on a non-empty eligible set is the normal outcome, not a bug.
 *
 * No name generation: the roster is the universe. A character who is not in the
 * cast cannot become a candidate no matter what any model wrote.
 *
 * Pure: no DB, no fetch, no model. Deterministic (input order is preserved).
 */
import { canSpeak, type CastMember } from './cast.js';
import type { Scene } from '../types.js';

export type ExtraRejectReason =
  | 'is_user'
  | 'is_focus'
  | 'locked'
  | 'background'   // not a §4.2 cut: a cast row that has no slot to begin with
  | 'place'        // not in the room this turn
  | 'self_repeat'; // spoke as an extra in the previous beat

export type ExtraRejection = { id: string; reason: ExtraRejectReason };

export type EligibleExtrasResult = {
  eligible_ids: string[];
  rejected: ExtraRejection[];
};

/** Who is actually in the room, or null when the scene never declared occupancy. */
function presentIds(scene: Scene): string[] | null {
  return Array.isArray(scene.present_ids) ? scene.present_ids : null;
}

/**
 * §4.2. Every exclusion is recorded with its reason so the S5 beat log can show
 * *why* a scene produced zero extras — the difference between "the room was
 * empty" and "everyone was eligible and nobody earned a slot" is the whole
 * measurement.
 *
 * `previous_extra_ids` implements ST's `Allow Self Responses = off`: whoever took
 * an extra slot last beat cannot take one again immediately. Without it a single
 * well-matched duty holder becomes a permanent second voice.
 */
export function eligibleExtras(input: {
  cast: CastMember[];
  scene: Scene;
  focus_id: string | null;
  user_id?: string | null;
  previous_extra_ids?: string[];
}): EligibleExtrasResult {
  const { cast, scene } = input;
  const present = presentIds(scene);
  const previous = input.previous_extra_ids ?? scene.last_beat?.extra_ids ?? [];

  const eligible_ids: string[] = [];
  const rejected: ExtraRejection[] = [];
  const seen = new Set<string>();

  for (const m of cast) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);

    if (input.user_id && m.id === input.user_id) {
      rejected.push({ id: m.id, reason: 'is_user' });
      continue;
    }
    if (input.focus_id && m.id === input.focus_id) {
      rejected.push({ id: m.id, reason: 'is_focus' });
      continue;
    }
    if (!canSpeak(m)) {
      rejected.push({ id: m.id, reason: 'background' });
      continue;
    }
    if (m.locked) {
      rejected.push({ id: m.id, reason: 'locked' });
      continue;
    }
    if (present && !present.includes(m.id)) {
      rejected.push({ id: m.id, reason: 'place' });
      continue;
    }
    if (previous.includes(m.id)) {
      rejected.push({ id: m.id, reason: 'self_repeat' });
      continue;
    }
    eligible_ids.push(m.id);
  }

  return { eligible_ids, rejected };
}
