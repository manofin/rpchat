/**
 * f9-place-catalog — the Story layer of the three-layer scene model.
 *
 *   Story     → scene_catalog (this file): what MAY exist
 *   Scene     → conversations.scene_json: where the scene currently IS
 *   Character → `party:home=` tags: where an NPC normally stands (presence only)
 *
 * Pure: parsing and shaping only. No DB, no fetch, no model. Nothing here trusts
 * its input; a damaged catalog degrades to the empty catalog, which makes
 * applySceneDelta reject every proposed key rather than invent one.
 */
import type { PartyCatalog } from './applySceneDelta.js';
import { parsePartyTags, type PartyTagRow } from './tagsCatalog.js';

export type CatalogPlace = {
  id: string;
  name?: string;
  tags?: string[];
  /** f9-beat-render: focus priority 3. Who speaks here when nobody is named. */
  default_focus?: string;
};

export type SceneCatalog = {
  places: CatalogPlace[];
  weathers: string[];
  arcs: string[];
  stagesByArc: Record<string, string[]>;
  flags: Record<string, { owner_stage?: string; owner_duty?: string }>;
  /** f9-beat-render: allowed outfit tokens. Anything else yields no image. */
  outfits: string[];
  /** f9-beat-render: emotion → asset index n. Anything else yields no image. */
  emotions: Record<string, number>;
  /** f9-beat-render: stage id → the duty that closes it (hard_event owner). */
  stages: Record<string, { closer_duty?: string }>;
  /**
   * f9-extra-approve §4.3: distinct duties that fill the same function slot, so
   * 세라 and 하연 both saying "조용히 해" yields one line, not two.
   * Unlisted duties are their own slot.
   */
  dutySlots: Record<string, string>;
};

export const SCENE_CATALOG_EMPTY: PartyCatalog = {
  weathers: [],
  locations: [],
  arcs: [],
  stagesByArc: {},
  flags: {},
  places: [],
  outfits: [],
  emotions: {},
  stages: {},
  dutySlots: {},
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) if (typeof x === 'string' && x && !out.includes(x)) out.push(x);
  return out;
}

/** Parses the stored JSON into a shaped catalog. Never throws. */
export function parseSceneCatalog(raw: string): SceneCatalog {
  let doc: unknown;
  try {
    doc = JSON.parse(raw || '{}');
  } catch {
    doc = {};
  }
  if (!isPlainObject(doc)) doc = {};
  const src = doc as Record<string, unknown>;

  const places: CatalogPlace[] = [];
  if (Array.isArray(src.places)) {
    for (const p of src.places) {
      if (!isPlainObject(p)) continue;
      const id = p.id;
      if (typeof id !== 'string' || !id) continue;
      if (places.some((q) => q.id === id)) continue;
      const place: CatalogPlace = { id };
      if (typeof p.name === 'string' && p.name) place.name = p.name;
      const tags = strings(p.tags);
      if (tags.length) place.tags = tags;
      if (typeof p.default_focus === 'string' && p.default_focus) place.default_focus = p.default_focus;
      places.push(place);
    }
  }

  const stagesByArc: Record<string, string[]> = {};
  if (isPlainObject(src.stagesByArc)) {
    for (const [arc, stages] of Object.entries(src.stagesByArc)) {
      const list = strings(stages);
      if (list.length) stagesByArc[arc] = list;
    }
  }

  const flags: Record<string, { owner_stage?: string; owner_duty?: string }> = {};
  if (isPlainObject(src.flags)) {
    for (const [key, def] of Object.entries(src.flags)) {
      if (!isPlainObject(def)) {
        flags[key] = {};
        continue;
      }
      const row: { owner_stage?: string; owner_duty?: string } = {};
      if (typeof def.owner_stage === 'string' && def.owner_stage) row.owner_stage = def.owner_stage;
      if (typeof def.owner_duty === 'string' && def.owner_duty) row.owner_duty = def.owner_duty;
      flags[key] = row;
    }
  }

  // f9-beat-render: emotion → asset index. Only finite non-negative integers count;
  // anything else is dropped, which makes assetPathFor return null for that emotion.
  const emotions: Record<string, number> = {};
  if (isPlainObject(src.emotions)) {
    for (const [key, n] of Object.entries(src.emotions)) {
      if (!key) continue;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) continue;
      emotions[key] = n;
    }
  }

  const stages: Record<string, { closer_duty?: string }> = {};
  if (isPlainObject(src.stages)) {
    for (const [id, def] of Object.entries(src.stages)) {
      if (!id) continue;
      stages[id] = isPlainObject(def) && typeof def.closer_duty === 'string' && def.closer_duty
        ? { closer_duty: def.closer_duty }
        : {};
    }
  }

  const dutySlots: Record<string, string> = {};
  if (isPlainObject(src.duties)) {
    for (const [duty, def] of Object.entries(src.duties)) {
      if (!duty || !isPlainObject(def)) continue;
      if (typeof def.slot === 'string' && def.slot) dutySlots[duty] = def.slot;
    }
  }

  return {
    places,
    weathers: strings(src.weathers),
    arcs: strings(src.arcs),
    stagesByArc,
    flags,
    outfits: strings(src.outfits),
    emotions,
    stages,
    dutySlots,
  };
}

/**
 * The allow-list applySceneDelta validates against. `locations` is the place-id
 * list, which is exactly what a character-derived catalog could not produce.
 */
export function catalogFromStory(raw: string): PartyCatalog {
  const c = parseSceneCatalog(raw);
  return {
    weathers: c.weathers,
    locations: c.places.map((p) => p.id),
    arcs: c.arcs,
    stagesByArc: c.stagesByArc,
    flags: c.flags,
    places: c.places,
    outfits: c.outfits,
    emotions: c.emotions,
    stages: c.stages,
    dutySlots: c.dutySlots,
  };
}

/** Character layer: where this NPC normally stands. Presence only — never a catalog source. */
export function homePlacesOf(row: PartyTagRow): string[] {
  let tags: unknown = [];
  try {
    tags = JSON.parse(row.tags_json || '[]');
  } catch {
    tags = [];
  }
  return parsePartyTags(tags).home_places;
}
