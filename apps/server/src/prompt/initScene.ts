/**
 * Starting scene for a story-hosted party conversation.
 *
 * StoryPage POSTs `{ characterId, storyId, mode }` with an empty scene, so without
 * this fill the beat header/UI have nothing to template (no clock, no place, no
 * user_sheet). Overlay keys the client actually sent always win.
 *
 * Pure: no DB, no fetch, no model. Cast length < 2 means this is not a party
 * roster, so the overlay is returned unchanged (1:1 story rows stay sparse).
 *
 * A 1:1 `first_message` is a different opening world (cliff, reading room).
 * When this module seeds a party scene, that greeting must not be inserted —
 * otherwise the user plays the card opening and the beat answers from the
 * catalog place (로비에서 밧줄을 잡자).
 */
import type { PartyCatalog } from './applySceneDelta.js';
import type { CastMember } from './cast.js';
import type { Scene } from '../types.js';

/** Morning bell. Matches the Notes §7 classroom sample clock (09:38). */
export const DEFAULT_STORY_CLOCK_MINUTES = 9 * 60 + 38;

const DEFAULT_SHEET: NonNullable<Scene['user_sheet']> = {
  hp: 100,
  money: 0,
  gear: [],
  inventory: [],
  traits: [],
};

function defined<T>(v: T | undefined): v is T {
  return v !== undefined;
}

/** True when the seeded scene is a party beat, so 1:1 first_message stays off. */
export function partySuppressesGreeting(cast: CastMember[]): boolean {
  return cast.length >= 2;
}

/**
 * Seed a playable beat scene from the story catalog + closed cast.
 * Overlay (the request scene) wins field-by-field. Never invents a location the
 * catalog does not list. Clock / day_index / user_sheet are server defaults so
 * the header and UI have something to render on turn 1.
 */
export function initialBeatScene(input: {
  catalog: PartyCatalog;
  cast: CastMember[];
  overlay?: Scene;
}): Scene {
  const overlay = input.overlay ?? {};
  if (input.cast.length < 2) return { ...overlay };

  const places = input.catalog.places ?? [];
  const locations = input.catalog.locations ?? places.map((p) => p.id);
  const location =
    overlay.location
    ?? (overlay.place && locations.includes(overlay.place) ? overlay.place : undefined)
    ?? places[0]?.id
    ?? locations[0];
  const weather = overlay.weather ?? input.catalog.weathers[0];
  const arc = overlay.arc ?? input.catalog.arcs[0];
  const stage = overlay.stage ?? (arc ? (input.catalog.stagesByArc[arc] ?? [])[0] : undefined);
  const clock = defined(overlay.clock_minutes) ? overlay.clock_minutes : DEFAULT_STORY_CLOCK_MINUTES;
  const dayIndex = defined(overlay.day_index) ? overlay.day_index : 1;

  const present = overlay.present_ids ?? input.cast
    .filter((m) => !m.place || !location || m.place === location)
    .map((m) => m.id);

  const defaultOutfit = (input.catalog.outfits ?? [])[0];
  const roster: NonNullable<Scene['roster']> = overlay.roster
    ? { ...overlay.roster }
    : {};
  if (!overlay.roster) {
    for (const m of input.cast) {
      const outfit = m.outfit || defaultOutfit;
      if (outfit) roster[m.id] = { outfit };
    }
  }

  const out: Scene = { ...overlay };
  if (location) out.location = location;
  if (weather) out.weather = weather;
  if (arc) out.arc = arc;
  if (stage) out.stage = stage;
  if (defined(clock)) out.clock_minutes = clock;
  if (defined(dayIndex)) out.day_index = dayIndex;
  if (overlay.weekday) out.weekday = overlay.weekday;
  out.present_ids = present;
  if (Object.keys(roster).length) out.roster = roster;
  out.user_sheet = overlay.user_sheet ?? { ...DEFAULT_SHEET, gear: [], inventory: [], traits: [] };
  return out;
}
