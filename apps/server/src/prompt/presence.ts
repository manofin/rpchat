/**
 * f9-presence-model — who is actually in the scene right now.
 *
 * Presence is owned by the Scene, not by the Character:
 *   Character.home_places  = where an NPC normally stands (initial placement)
 *   Scene.present_ids      = who is actually here this turn (canonical)
 *
 * Before this, presence was inferred from a character's static `party:place`
 * tag, so a single location change (lobby → evaluation room) made the entire
 * cast absent and no NPC could ever escort the player.
 *
 * Rule (f9-focus-eligible, `Notes_260902_210901.txt` §4.1–4.2): presence gates
 * BOTH the focus and the extras. This module used to be documented as gating aux
 * speakers only, because `assignSpeakers` fell back to the conversation's main
 * character no matter where they were — an absent main still spoke. The beat
 * contract removes that fallback: a character who is not in the room does not get
 * a dialogue slot, and a beat with nobody selectable is narration, not a turn
 * salvaged by putting words in an absent character's mouth.
 *
 * Pure: no DB, no fetch, no model.
 */
import type { CastMember } from './cast.js';
import type { Scene } from '../types.js';

/** Upper bound on scene occupancy. Keeps a bad patch from unbounded growth. */
export const PRESENCE_MAX = 12;

export type PresenceMember = CastMember & { home_places?: string[] };

export type PresenceDelta = {
  present_ids?: string[];
  present_ids_add?: string[];
  present_ids_remove?: string[];
};

/** Roster row used as the presence allow-list. Subset of CastMember. */
export type CastRef = {
  id: string;
  name: string;
  aliases?: string[];
};

export type PresenceResolveIgnore = { key: string; reason: string };

const PRESENCE_KEYS = ['present_ids', 'present_ids_add', 'present_ids_remove'] as const;

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) if (typeof x === 'string' && x && !out.includes(x)) out.push(x);
  return out;
}

/** The scene's occupancy list. `[]` when the scene has never declared one. */
export function presentIds(scene: Scene): string[] {
  return stringList((scene as { present_ids?: unknown }).present_ids);
}

/**
 * True when this member is in the current scene.
 *
 * If the scene declares `present_ids` (even empty), that list is canonical —
 * an empty list means nobody is here, not "fall back to tags". Only a scene
 * that has never declared occupancy falls back to home_places, so existing
 * conversations keep working unchanged.
 */
export function isPresent(member: PresenceMember, scene: Scene): boolean {
  const declared = (scene as { present_ids?: unknown }).present_ids;
  if (Array.isArray(declared)) return presentIds(scene).includes(member.id);

  const here = scene.location ?? scene.place ?? '';
  if (!here) return false;
  const homes = member.home_places && member.home_places.length
    ? member.home_places
    : member.place
      ? [member.place]
      : [];
  return homes.includes(here);
}

/**
 * f9-focus-eligible §4.2 helpers. The candidate set is a difference of lists, and
 * these give it its two halves plus the user cut. A scene that never declared
 * occupancy treats `home_places` as the fallback (see `isPresent`), so existing
 * conversations keep working.
 */
export function inRoom(cast: PresenceMember[], scene: Scene): PresenceMember[] {
  return cast.filter((m) => isPresent(m, scene));
}

export function outOfRoom(cast: PresenceMember[], scene: Scene): PresenceMember[] {
  return cast.filter((m) => !isPresent(m, scene));
}

/**
 * The user is not a cast member, but a roster built from story participants can
 * contain their persona row. Cutting them here keeps §4.2's `- user` honest
 * without every caller re-checking.
 */
export function excludeUser<T extends { id: string }>(cast: T[], userId: string | null | undefined): T[] {
  return userId ? cast.filter((m) => m.id !== userId) : cast.slice();
}

/**
 * Applies presence keys to an occupancy list. `present_ids` replaces wholesale;
 * add/remove adjust. Always capped at PRESENCE_MAX. Never throws.
 */
export function applyPresenceDelta(current: string[], patch: PresenceDelta): string[] {
  let next = stringList(current);

  if ('present_ids' in patch && Array.isArray(patch.present_ids)) {
    next = stringList(patch.present_ids);
  }
  if ('present_ids_add' in patch && Array.isArray(patch.present_ids_add)) {
    for (const id of stringList(patch.present_ids_add)) {
      if (!next.includes(id)) next.push(id);
    }
  }
  if ('present_ids_remove' in patch && Array.isArray(patch.present_ids_remove)) {
    const drop = new Set(stringList(patch.present_ids_remove));
    next = next.filter((id) => !drop.has(id));
  }

  return next.slice(0, PRESENCE_MAX);
}

/**
 * Map a model token to a unique cast id.
 * Order: exact id, then name, then non-empty aliases.
 * 0 matches or 2+ matches → null (caller drops that token only).
 */
export function resolveCastToken(token: string, cast: CastRef[]): string | null {
  if (!token) return null;

  const byId = cast.filter((m) => m.id === token);
  if (byId.length === 1) return byId[0].id;
  if (byId.length > 1) return null;

  const byName = cast.filter((m) => m.name === token);
  if (byName.length === 1) return byName[0].id;
  if (byName.length > 1) return null;

  const byAlias = cast.filter((m) =>
    (m.aliases ?? []).some((a) => a.length > 0 && a === token),
  );
  if (byAlias.length === 1) return byAlias[0].id;
  return null;
}

function resolveList(
  key: (typeof PRESENCE_KEYS)[number],
  raw: unknown,
  cast: CastRef[],
  ignored: PresenceResolveIgnore[],
): string[] {
  const ids: string[] = [];
  for (const token of stringList(raw)) {
    const id = resolveCastToken(token, cast);
    if (!id) {
      ignored.push({ key: `${key}.${token}`, reason: 'not_in_cast' });
      continue;
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Normalize presence keys against the cast allow-list before applyPresenceDelta.
 * Missing cast → every presence key is ignored (fail-closed). Tokens that do
 * not resolve uniquely are dropped one-by-one; a wholesale replace whose
 * every token fails does not become an empty occupancy wipe.
 */
export function resolvePresencePatch(
  patch: PresenceDelta,
  cast: CastRef[] | undefined,
): { delta: PresenceDelta; ignored: PresenceResolveIgnore[] } {
  const ignored: PresenceResolveIgnore[] = [];
  const delta: PresenceDelta = {};

  if (!cast) {
    for (const k of PRESENCE_KEYS) {
      if (k in patch) ignored.push({ key: k, reason: 'not_in_cast' });
    }
    return { delta, ignored };
  }

  if ('present_ids' in patch && Array.isArray(patch.present_ids)) {
    if (patch.present_ids.length === 0) {
      delta.present_ids = [];
    } else {
      const ids = resolveList('present_ids', patch.present_ids, cast, ignored);
      if (ids.length > 0) delta.present_ids = ids;
    }
  }
  if ('present_ids_add' in patch && Array.isArray(patch.present_ids_add)) {
    const ids = resolveList('present_ids_add', patch.present_ids_add, cast, ignored);
    if (ids.length > 0) delta.present_ids_add = ids;
  }
  if ('present_ids_remove' in patch && Array.isArray(patch.present_ids_remove)) {
    const ids = resolveList('present_ids_remove', patch.present_ids_remove, cast, ignored);
    if (ids.length > 0) delta.present_ids_remove = ids;
  }

  return { delta, ignored };
}
