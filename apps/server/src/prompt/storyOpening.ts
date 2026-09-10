/**
 * ADR-F8d story opening. Parse / PUT-validate / POST-apply.
 * Pure: no DB, no fetch, no model. resolveOpening reads only the conversation row.
 */
import type { ConversationRow, Scene } from '../types.js';
import type { PartyCatalog } from './applySceneDelta.js';

export type StoryOpeningScene = {
  place_id?: string;
  weather?: string;
  day_index?: number;
  clock_minutes?: number;
  beat_goal?: string;
};

export type StoryOpening = {
  scenario: string;
  greeting: string;
  scene: StoryOpeningScene;
  present_ids: string[];
};

export const EMPTY_OPENING: StoryOpening = {
  scenario: '',
  greeting: '',
  scene: {},
  present_ids: [],
};

export type OpeningFieldError = { field: string; message: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function intOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

/** Empty / whitespace / missing / [] — ADR-F8d §7 absent(). */
export function openingFieldAbsent(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

export function parseOpening(raw: string | null | undefined): StoryOpening {
  if (raw == null || raw === '') return { ...EMPTY_OPENING, scene: {}, present_ids: [] };
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    console.warn('[resolveOpening] damaged story_opening_snapshot');
    return { ...EMPTY_OPENING, scene: {}, present_ids: [] };
  }
  if (!isPlainObject(doc)) return { ...EMPTY_OPENING, scene: {}, present_ids: [] };

  const sceneIn = isPlainObject(doc.scene) ? doc.scene : {};
  const scene: StoryOpeningScene = {};
  const placeId = str(sceneIn.place_id).trim();
  if (placeId) scene.place_id = placeId;
  const weather = str(sceneIn.weather).trim();
  if (weather) scene.weather = weather;
  const day = intOrUndef(sceneIn.day_index);
  if (day !== undefined) scene.day_index = day;
  const clock = intOrUndef(sceneIn.clock_minutes);
  if (clock !== undefined) scene.clock_minutes = clock;
  const goal = str(sceneIn.beat_goal).trim();
  if (goal) scene.beat_goal = goal;

  const present: string[] = [];
  if (Array.isArray(doc.present_ids)) {
    const seen = new Set<string>();
    for (const id of doc.present_ids) {
      if (typeof id !== 'string' || !id || seen.has(id)) continue;
      seen.add(id);
      present.push(id);
      if (present.length >= 12) break;
    }
  }

  return {
    scenario: str(doc.scenario),
    greeting: str(doc.greeting),
    scene,
    present_ids: present,
  };
}

/** DB 0. story_applied_at is the freeze gate (F8b). Damaged JSON → empty opening. */
export function resolveOpening(conv: ConversationRow): StoryOpening | null {
  if (!conv.story_applied_at) return null;
  return parseOpening(conv.story_opening_snapshot);
}

export function storedOpening(opening: StoryOpening): string {
  const scene: Record<string, unknown> = {};
  if (opening.scene.place_id) scene.place_id = opening.scene.place_id;
  if (opening.scene.weather) scene.weather = opening.scene.weather;
  if (opening.scene.day_index !== undefined) scene.day_index = opening.scene.day_index;
  if (opening.scene.clock_minutes !== undefined) scene.clock_minutes = opening.scene.clock_minutes;
  if (opening.scene.beat_goal) scene.beat_goal = opening.scene.beat_goal;
  return JSON.stringify({
    scenario: opening.scenario,
    greeting: opening.greeting,
    scene,
    present_ids: opening.present_ids,
  });
}

/**
 * PUT authorship. Invalid values are rejected (400), not stored.
 * POST start uses applyOpeningOverlay instead (drop the bad field, do not block).
 */
export function validateOpeningPut(
  opening: StoryOpening,
  catalog: { places?: Array<{ id: string }>; weathers?: string[] },
  hostedIds: string[],
): OpeningFieldError[] {
  const errors: OpeningFieldError[] = [];
  const places = catalog.places ?? [];
  const weathers = catalog.weathers ?? [];
  const hosted = new Set(hostedIds);

  const placeId = (opening.scene.place_id ?? '').trim();
  if (placeId) {
    if (!places.some((p) => p.id === placeId)) {
      errors.push({ field: 'scene.place_id', message: 'catalog place id required' });
    }
  }
  const weather = (opening.scene.weather ?? '').trim();
  if (weather) {
    if (!weathers.includes(weather)) {
      errors.push({ field: 'scene.weather', message: 'catalog weather required' });
    }
  }
  if (opening.scene.clock_minutes !== undefined) {
    const c = opening.scene.clock_minutes;
    if (!Number.isInteger(c) || c < 0 || c > 1439) {
      errors.push({ field: 'scene.clock_minutes', message: 'must be 0..1439' });
    }
  }
  if (opening.scene.day_index !== undefined) {
    const d = opening.scene.day_index;
    if (!Number.isInteger(d) || d < 1) {
      errors.push({ field: 'scene.day_index', message: 'must be >= 1' });
    }
  }
  for (const id of opening.present_ids) {
    if (!hosted.has(id)) {
      errors.push({ field: 'present_ids', message: 'hosted mains only' });
      break;
    }
  }
  if (opening.present_ids.length > 12) {
    errors.push({ field: 'present_ids', message: 'max 12' });
  }
  return errors;
}

/**
 * POST start: field-by-field overlay. Invalid values are dropped (4-A).
 * Does not invent catalog defaults — initialBeatScene still owns those for party.
 */
export function applyOpeningOverlay(input: {
  opening: StoryOpening;
  catalog: PartyCatalog;
  hostedIds: string[];
  ownerId: string;
  overlay: Scene;
}): Scene {
  const { opening, catalog, ownerId } = input;
  const overlay: Scene = { ...input.overlay };
  const places = catalog.places ?? [];
  const weathers = catalog.weathers ?? [];
  const hosted = new Set(input.hostedIds);

  const placeId = (opening.scene.place_id ?? '').trim();
  if (placeId) {
    const place = places.find((p) => p.id === placeId);
    if (place) {
      overlay.location = place.id;
      if (place.name) overlay.place = place.name;
    }
  }

  const weather = (opening.scene.weather ?? '').trim();
  if (weather && weathers.includes(weather)) overlay.weather = weather;

  const clock = opening.scene.clock_minutes;
  if (typeof clock === 'number' && Number.isInteger(clock) && clock >= 0 && clock <= 1439) {
    overlay.clock_minutes = clock;
  }

  const day = opening.scene.day_index;
  if (typeof day === 'number' && Number.isInteger(day) && day >= 1) {
    overlay.day_index = day;
  }

  const goal = (opening.scene.beat_goal ?? '').trim();
  if (goal) overlay.beat_goal = goal.slice(0, 500);

  if (opening.present_ids.length) {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const id of opening.present_ids) {
      if (!hosted.has(id) || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    if (!seen.has(ownerId)) ids.unshift(ownerId);
    overlay.present_ids = ids;
  }

  return overlay;
}
