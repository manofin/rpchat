/**
 * f9-focus-eligible — ambient presence (§4.4). Talkativeness put back where it
 * belongs.
 *
 * ST's Talkativeness is a *speech* probability. §2 keeps the parameter and throws
 * away that use of it: here it weights **narration points only**. 루나 at 0.8 gets
 * "눈을 반짝였다"; she does not get a dialogue slot, and no weight ever promotes
 * anyone into one. The output of this module is a list of characters for the
 * narrator to mention, never a `이름|""` block.
 *
 * Selection is deterministic. A turn re-rendered from the same scene picks the
 * same gestures, so a bench can assert on it and a retry cannot quietly reshuffle
 * who was noticed. `Math.random` is deliberately absent.
 *
 * Pure: no DB, no fetch, no model.
 */
import { talkativenessOf, type CastMember } from './cast.js';
import type { Scene } from '../types.js';

/** Ambient mentions per beat. Enough to populate a room, too few to become a chorus. */
export const AMBIENT_MAX = 3;

export type AmbientPick = {
  character_id: string;
  name: string;
  weight: number;
};

/**
 * FNV-1a over the turn seed. Small, dependency-free, and stable across processes —
 * the properties `Math.random` lacks and a crypto hash does not need to beat.
 */
export function seedHash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The per-candidate draw: a stable pseudo-random value in [0,1) for this turn. */
function draw(seed: string, id: string): number {
  return seedHash(`${seed}:${id}`) / 0x100000000;
}

/**
 * §4.4. Candidates are people who are present, unlocked, not the focus and not an
 * approved extra — i.e. exactly the characters who exist in the scene this turn
 * but have no line. Each is weighted by talkativeness and the top `AMBIENT_MAX`
 * draws are returned in descending weight, ties broken by id for determinism.
 *
 * The caller renders these as narrator sentences. Nothing here produces a speaker
 * header, and `AmbientPick` deliberately carries no text field — the shape itself
 * refuses to become a line.
 */
export function ambientPicks(input: {
  cast: CastMember[];
  scene: Scene;
  focus_id: string | null;
  extra_ids?: string[];
  seed: string;
  max?: number;
}): AmbientPick[] {
  const { cast, scene } = input;
  const extras = input.extra_ids ?? [];
  const present = Array.isArray(scene.present_ids) ? scene.present_ids : null;
  const max = Math.max(0, input.max ?? AMBIENT_MAX);

  const scored = cast
    .filter((m) => {
      // Background NPCs are INCLUDED here on purpose — narration is where they
      // exist. This is the one place the role tag widens a set instead of
      // narrowing one, which is precisely why it is not a §4.2 eligibility cut.
      // Deliberately no canSpeak/isBackground call: filtering on it here would be
      // the fork those predicates exist to prevent.
      if (m.locked) return false;
      if (input.focus_id && m.id === input.focus_id) return false;
      if (extras.includes(m.id)) return false;
      return present ? present.includes(m.id) : true;
    })
    .map((m) => ({
      member: m,
      // Weight × draw: a talkative character is noticed more often across turns,
      // but never every turn, and a quiet one is never impossible.
      score: talkativenessOf(m) * draw(input.seed, m.id),
      weight: talkativenessOf(m),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => (b.score - a.score) || a.member.id.localeCompare(b.member.id));

  return scored.slice(0, max).map((row) => ({
    character_id: row.member.id,
    name: row.member.name,
    weight: row.weight,
  }));
}

/**
 * The turn seed. Built from identifiers the server already owns, so it is stable
 * for a given beat and different for the next one.
 */
export function ambientSeed(conversationId: string, scene: Scene, messageId?: string | null): string {
  return [conversationId, messageId ?? '', scene.scene_version ?? 0, scene.clock_minutes ?? 0].join(':');
}
