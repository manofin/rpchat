// PROD_IMPORT_FORBIDDEN — frozen evidence for a closed measurement.
// Nothing under apps/** may import this file. See bench/retiredFreeze.test.ts.
/**
 * FROZEN COPY of the retired product module `apps/server/src/prompt/auxGate.ts`,
 * as it stood when the `f9-trigger-supply` measurements were run (2026-09-02).
 *
 * f9-extra-approve deleted it: §4.3 states plainly that `trigger_exists` must not
 * be a model field, and `approveExtras` replaces the whole gate with a
 * server-derived hard_event opener. The measurements in this directory are closed
 * and their results are on disk, so pointing them at the new module would make the
 * scripts report numbers that do not match the recorded run.
 *
 * Do not import this from apps/**. Do not "fix" it to match the beat contract.
 *
 * ── original header ───────────────────────────────────────────────────────────
 *
 * f9-aux-speaker-gate — decides who is *allowed* to speak as a secondary.
 *
 * This module answers eligibility only. It never generates speech and never
 * calls a model; producing the aux line is f9-aux-speaker-generate.
 *
 *   eligible = present && trigger_exists && reason_non_empty
 *
 * Every clause fails closed. A missing, malformed, or unresolvable trigger
 * yields silence, which is the safe direction: the failure mode of this feature
 * is "nobody interrupts", never "every NPC talks at once".
 *
 * `secondary_triggers` rides along in the flat delta JSON but is *not* scene
 * state — applySceneDelta drops it as not_in_allowlist (default-deny), and this
 * gate reads it from the raw patch instead. Eligibility is computed against the
 * post-apply occupancy so that a patch which moves someone in or out of the
 * scene decides, in the same turn, whether they may speak.
 *
 * Pure: no DB, no fetch, no model.
 */
import type { CastMember } from '../../../apps/server/src/prompt/cast.ts';
import type { Scene } from '../../../apps/server/src/types.ts';

// Frozen copies of the two runtime values this module used at measurement time.
// Importing the live `presence.isPresent` / `assignSpeakers.MAX_EXTRAS` would mean
// a later change to either silently re-scores a closed run — which is exactly what
// freezing this file is for. Types above stay imported: they are compile-time only
// and cannot alter a result.
const MAX_EXTRAS = 2;

function isPresent(member: CastMember & { home_places?: string[] }, scene: Scene): boolean {
  const declared = (scene as { present_ids?: unknown }).present_ids;
  if (Array.isArray(declared)) {
    return declared.filter((x): x is string => typeof x === 'string').includes(member.id);
  }
  const here = scene.location ?? scene.place ?? '';
  if (!here) return false;
  const homes = member.home_places && member.home_places.length
    ? member.home_places
    : member.place
      ? [member.place]
      : [];
  return homes.includes(here);
}

export type SecondaryTrigger = { character: string; reason: string };

export type EligibleSecondary = {
  character_id: string;
  name: string;
  reason: string;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Pulls `secondary_triggers` out of the flat delta object.
 * Entries without a non-empty character AND a non-empty reason are dropped here,
 * so the reason_non_empty clause is enforced before eligibility even runs.
 */
export function parseSecondaryTriggers(patch: unknown): SecondaryTrigger[] {
  if (!isPlainObject(patch)) return [];
  const raw = patch.secondary_triggers;
  if (!Array.isArray(raw)) return [];

  const out: SecondaryTrigger[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const character = typeof entry.character === 'string' ? entry.character.trim() : '';
    const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
    if (!character || !reason) continue;
    out.push({ character, reason });
  }
  return out;
}

/** Resolves a model-written name or alias to a cast id. Unknown names return null. */
function resolveCastId(token: string, cast: CastMember[]): CastMember | null {
  const needle = token.trim();
  if (!needle) return null;
  return (
    cast.find((c) => c.name === needle) ??
    cast.find((c) => (c.aliases ?? []).includes(needle)) ??
    null
  );
}

/**
 * The eligible secondary set for this turn, capped at MAX_EXTRAS.
 * `scene` must be the post-apply state; occupancy is read from it.
 */
export function eligibleSecondaries(input: {
  triggers: SecondaryTrigger[];
  cast: CastMember[];
  scene: Scene;
  mainId: string;
}): EligibleSecondary[] {
  const { triggers, cast, scene, mainId } = input;
  const out: EligibleSecondary[] = [];
  const seen = new Set<string>();

  for (const trigger of triggers) {
    const member = resolveCastId(trigger.character, cast);
    if (!member) continue;                       // unknown name → silence
    if (member.id === mainId) continue;          // the main speaker is not a secondary
    if (member.role === 'background') continue;  // background never speaks (F9D)
    if (seen.has(member.id)) continue;
    if (!isPresent(member, scene)) continue;     // not in the room → silence

    seen.add(member.id);
    out.push({ character_id: member.id, name: member.name, reason: trigger.reason });
    if (out.length >= MAX_EXTRAS) break;
  }

  return out;
}
