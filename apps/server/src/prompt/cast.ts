/**
 * f9-focus-eligible — the cast row, extracted from the retired F9C router.
 *
 * `pickSpeaker.ts` used to host these types, which made every consumer depend on
 * a scoring module they did not use. The beat contract
 * (`Notes_260902_210901.txt` §4) replaces scoring with a server-decided focus, so
 * the shared shape lives here and the router is gone.
 *
 * `role` survives because background NPCs still never get a dialogue slot (§4.2).
 * What does not survive is the idea that a role or a score decides who speaks.
 *
 * **`background` is not a fourth exclusion set.** The eligibility cuts of §4.2 are
 * user / focus / locked / out-of-room; `background` sits beside them as a property
 * of the cast row, and its real job is the opposite one — it is an *ambient weight
 * input*, marking someone who exists in narration and never in a slot. Reading it
 * as "another way to be ineligible" is what makes approval too permissive, because
 * it invites a second, looser definition of who is in the room. One tag
 * (`party:role=`), parsed in one place (`tagsCatalog.parsePartyTags`), read through
 * one predicate (`canSpeak` / `isBackground`) — nowhere else.
 *
 * Pure types plus one predicate. No DB, no fetch, no model.
 */

export type CastRole = 'main' | 'secondary' | 'background';

export type CastMember = {
  id: string;
  name: string;
  aliases: string[];
  duties: string[];
  place: string;
  /** f9-presence-model: default placement. Routing does not read this; presence.ts does. */
  home_places?: string[];
  role: CastRole;
  /**
   * §4.4 ambient weight, 0..1. Drives narration gestures ONLY — never a dialogue
   * slot. ST's Talkativeness in its correct place.
   */
  talkativeness?: number;
  /** UI 🔒 and an eligibility cut: a locked character is not a conversation target. */
  locked?: boolean;
  /** Default outfit token; the per-turn value lives in `scene_json.roster[id].outfit`. */
  outfit?: string;
};

export const DEFAULT_TALKATIVENESS = 0.3;

/**
 * Background NPCs exist in narration and on the roster, never in a dialogue slot.
 *
 * `canSpeak` and `isBackground` are the ONLY readers of the role tag outside
 * `tagsCatalog`. Comparing `role === 'background'` inline anywhere else forks the
 * definition, which is how a background NPC ends up eligible on one code path and
 * ambient on another.
 */
export function canSpeak(m: Pick<CastMember, 'role'>): boolean {
  return !isBackground(m);
}

/** True for a cast row that may be narrated but never given a line. */
export function isBackground(m: Pick<CastMember, 'role'>): boolean {
  return m.role === 'background';
}

/** The ambient weight actually used, with the declared default filled in. */
export function talkativenessOf(m: CastMember): number {
  const v = m.talkativeness;
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_TALKATIVENESS;
  return Math.min(1, Math.max(0, v));
}
