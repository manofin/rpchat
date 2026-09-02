import { applyPresenceDelta, presentIds, resolvePresencePatch } from './presence.js';
import type { CastRef } from './presence.js';
import type { Scene } from '../types.js';

/** Per-turn cap on GM `advance_minutes` (24h). Fail → clock unchanged. */
export const ADVANCE_MINUTES_MAX = 1440;

export type PartyCatalog = {
  weathers: string[];
  locations: string[];
  arcs: string[];
  stagesByArc: Record<string, string[]>;
  flags: Record<string, { owner_stage?: string; owner_duty?: string }>;
  /** Roster allow-list for presence tokens. Absent → presence keys fail-closed. */
  cast?: CastRef[];
  /** f9-beat-render: full place rows (id + default_focus). Validation still uses `locations`. */
  places?: Array<{ id: string; name?: string; tags?: string[]; default_focus?: string }>;
  /** f9-beat-render: allowed outfit tokens. Absent/empty → no image. */
  outfits?: string[];
  /** f9-beat-render: emotion → asset index n. Absent/empty → no image. */
  emotions?: Record<string, number>;
  /** f9-beat-render: stage id → closing duty (hard_event owner). */
  stages?: Record<string, { closer_duty?: string }>;
  /** f9-extra-approve: duties that share one function slot. Unlisted = own slot. */
  dutySlots?: Record<string, string>;
};

export type ApplyIgnore = { key: string; reason: string };

/**
 * f9-beat-render: which stage/flag actually transitioned this turn. Additive to
 * `applied` (whose string contract is unchanged) because `hard_event` needs the
 * transitioned *id*, not just the key name. Only real changes are recorded — a
 * flag re-set to the value it already had produces no event.
 */
export type AppliedEvent = { kind: 'stage' | 'flag'; id: string };

export type ApplySceneDeltaResult = {
  state: Scene;
  discarded: boolean;
  applied: string[];
  ignored: ApplyIgnore[];
  archiveSnapshot: Scene | null;
  approvalCandidates: Record<string, unknown>;
  appliedEvents: AppliedEvent[];
};

const APPLY_KEYS = new Set([
  'advance_minutes',
  'weather',
  'location',
  'stage',
  'arc',
  'flags',
  // f9-presence-id-resolve: occupancy tokens resolve against catalog.cast.
  'present_ids',
  'present_ids_add',
  'present_ids_remove',
]);

const APPROVAL_KEYS = new Set(['relationship', 'memories']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function cloneScene(s: Scene): Scene {
  const out: Scene = {
    ...s,
    flags: s.flags ? s.flags.map((f) => ({ ...f })) : undefined,
    present_ids: s.present_ids ? [...s.present_ids] : undefined,
  };
  // f9-beat-render: the 0012 keys are nested. A shallow spread would let a caller
  // mutate the *input* scene through the returned clone, which is exactly the bug
  // that makes an archive snapshot silently equal the post-apply state.
  if (s.roster) {
    const roster: NonNullable<Scene['roster']> = {};
    for (const [id, row] of Object.entries(s.roster)) roster[id] = { ...row };
    out.roster = roster;
  }
  if (s.user_sheet) {
    out.user_sheet = {
      ...s.user_sheet,
      gear: s.user_sheet.gear ? [...s.user_sheet.gear] : undefined,
      inventory: s.user_sheet.inventory ? [...s.user_sheet.inventory] : undefined,
      traits: s.user_sheet.traits ? [...s.user_sheet.traits] : undefined,
    };
  }
  if (s.last_beat) {
    out.last_beat = {
      focus_id: s.last_beat.focus_id,
      extra_ids: [...s.last_beat.extra_ids],
      unresolved: [...s.last_beat.unresolved],
    };
  }
  return out;
}

function discard(state: Scene): ApplySceneDeltaResult {
  return {
    state: cloneScene(state),
    discarded: true,
    applied: [],
    ignored: [],
    archiveSnapshot: null,
    approvalCandidates: {},
    appliedEvents: [],
  };
}

export function applySceneDelta(
  state: Scene,
  patch: unknown,
  catalog: PartyCatalog,
  currentVersion: number,
): ApplySceneDeltaResult {
  if (!isPlainObject(patch)) return discard(state);
  if (patch.base_version !== currentVersion) return discard(state);

  const next = cloneScene(state);
  const applied: string[] = [];
  const ignored: ApplyIgnore[] = [];
  const approvalCandidates: Record<string, unknown> = {};
  const appliedEvents: AppliedEvent[] = [];
  let archiveSnapshot: Scene | null = null;

  for (const key of Object.keys(patch)) {
    if (key === 'base_version') continue;
    if (APPROVAL_KEYS.has(key)) {
      approvalCandidates[key] = patch[key];
      ignored.push({ key, reason: 'user_approval_required' });
      continue;
    }
    if (!APPLY_KEYS.has(key)) {
      ignored.push({ key, reason: 'not_in_allowlist' });
    }
  }

  if ('arc' in patch) {
    const v = patch.arc;
    if (typeof v === 'string' && catalog.arcs.includes(v)) {
      if (v !== next.arc) {
        archiveSnapshot = cloneScene(next);
        next.arc = v;
        delete next.stage;
        next.flags = [];
      } else {
        next.arc = v;
      }
      applied.push('arc');
    } else {
      ignored.push({ key: 'arc', reason: 'not_in_allowlist' });
    }
  }

  if ('stage' in patch) {
    const v = patch.stage;
    const allowed = next.arc ? (catalog.stagesByArc[next.arc] ?? []) : [];
    if (typeof v === 'string' && allowed.includes(v)) {
      const left = next.stage;
      if (left && left !== v) {
        next.flags = (next.flags ?? []).filter((f) => f.owner_stage !== left);
      }
      if (left !== v) appliedEvents.push({ kind: 'stage', id: v });
      next.stage = v;
      applied.push('stage');
    } else {
      ignored.push({ key: 'stage', reason: 'not_in_arc' });
    }
  }

  if ('weather' in patch) {
    const v = patch.weather;
    if (typeof v === 'string' && catalog.weathers.includes(v)) {
      next.weather = v;
      applied.push('weather');
    } else {
      ignored.push({ key: 'weather', reason: 'not_in_allowlist' });
    }
  }

  if ('location' in patch) {
    const v = patch.location;
    if (typeof v === 'string' && catalog.locations.includes(v)) {
      next.location = v;
      applied.push('location');
    } else {
      ignored.push({ key: 'location', reason: 'not_in_allowlist' });
    }
  }

  if ('advance_minutes' in patch) {
    const v = patch.advance_minutes;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= ADVANCE_MINUTES_MAX) {
      next.clock_minutes = (next.clock_minutes ?? 0) + v;
      applied.push('advance_minutes');
    } else {
      ignored.push({ key: 'advance_minutes', reason: 'out_of_range' });
    }
  }

  if ('flags' in patch) {
    const v = patch.flags;
    if (!isPlainObject(v)) {
      ignored.push({ key: 'flags', reason: 'type' });
    } else {
      const flags = [...(next.flags ?? [])];
      let any = false;
      for (const [k, val] of Object.entries(v)) {
        const def = catalog.flags[k];
        if (!def) {
          ignored.push({ key: `flags.${k}`, reason: 'not_in_allowlist' });
          continue;
        }
        if (typeof val !== 'boolean') {
          ignored.push({ key: `flags.${k}`, reason: 'type' });
          continue;
        }
        any = true;
        if (val) {
          if (!flags.some((f) => f.key === k)) {
            const row: { key: string; owner_stage?: string } = { key: k };
            if (def.owner_stage) row.owner_stage = def.owner_stage;
            flags.push(row);
            appliedEvents.push({ kind: 'flag', id: k });
          }
        } else {
          const idx = flags.findIndex((f) => f.key === k);
          if (idx >= 0) {
            flags.splice(idx, 1);
            appliedEvents.push({ kind: 'flag', id: k });
          }
        }
      }
      next.flags = flags;
      if (any) applied.push('flags');
    }
  }

  const touchesPresence =
    'present_ids' in patch || 'present_ids_add' in patch || 'present_ids_remove' in patch;
  if (touchesPresence) {
    const { delta, ignored: presenceIgnored } = resolvePresencePatch(
      patch as Parameters<typeof applyPresenceDelta>[1],
      catalog.cast,
    );
    ignored.push(...presenceIgnored);
    const hasDelta =
      ('present_ids' in delta && Array.isArray(delta.present_ids))
      || (Array.isArray(delta.present_ids_add) && delta.present_ids_add.length > 0)
      || (Array.isArray(delta.present_ids_remove) && delta.present_ids_remove.length > 0);
    if (hasDelta) {
      const before = presentIds(next);
      const after = applyPresenceDelta(before, delta);
      const changed = after.length !== before.length || after.some((id, i) => id !== before[i]);
      if (changed) {
        next.present_ids = after;
        applied.push('presence');
      }
    }
  }

  if (applied.length > 0) next.scene_version = currentVersion + 1;

  return {
    state: next,
    discarded: false,
    applied,
    ignored,
    archiveSnapshot,
    approvalCandidates,
    appliedEvents,
  };
}
