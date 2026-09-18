/**
 * PartyChannel B-1-full — shared planning core for party turns.
 *
 * This module applies the scene and resolves focus. It does not choose a
 * speaker policy, does not place ambient, and does not compute unresolved.
 * Callers inject speaker slots, leftover ambient, and unresolved after this
 * core returns.
 *
 * Pure: no DB, no fetch, no model.
 */
import { applySceneDelta, type ApplySceneDeltaResult, type PartyCatalog } from './applySceneDelta.js';
import { resolveFocus, type FocusResult } from './resolveFocus.js';
import type { BeatCastMember } from './renderBeat.js';
import type { CastMember } from './cast.js';
import type { Scene } from '../types.js';

export type PartyCoreInput = {
  scene: Scene;
  patch?: unknown;
  catalog: PartyCatalog;
  current_version: number;
  user_text: string;
  cast: CastMember[];
  main_character_id: string;
  story_room?: boolean;
  participant_ids?: string[] | null;
};

export type PartyCore = {
  catalog: PartyCatalog;
  applied: ApplySceneDeltaResult;
  scene: Scene;
  focus: FocusResult;
};

export function userNameOf(input: { user_name?: string }): string {
  return input.user_name || '나';
}

export function noopApply(scene: Scene): ApplySceneDeltaResult {
  return {
    state: scene,
    discarded: false,
    applied: [],
    ignored: [],
    archiveSnapshot: null,
    approvalCandidates: {},
    appliedEvents: [],
  };
}

/** Cast rows as the renderers want them — name, lock state, outfit. */
export function beatCast(cast: CastMember[], scene: Scene): BeatCastMember[] {
  return cast.map((m) => ({
    id: m.id,
    name: m.name,
    locked: m.locked,
    outfit: scene.roster?.[m.id]?.outfit,
  }));
}

/**
 * Steps 1-2 only. Speaker slots, ambient, and unresolved stay in the caller
 * so this core cannot silently pick a speaker policy.
 */
export function planPartyCore(input: PartyCoreInput): PartyCore {
  const catalog: PartyCatalog = { ...input.catalog, cast: input.cast };

  // 1. The scene is settled first. Everything downstream reads `applied.state`,
  //    never `input.scene` — that is the A-5 invariant in one line.
  const applied = input.patch !== undefined
    ? applySceneDelta(input.scene, input.patch, catalog, input.current_version)
    : noopApply(input.scene);
  const scene = applied.state;

  // 2. Focus. Server only, no draw, no model.
  const focus = resolveFocus({
    user_text: input.user_text,
    scene,
    cast: input.cast,
    catalog,
    main_character_id: input.main_character_id,
    story_room: input.story_room,
    participant_ids: input.participant_ids,
  });

  return { catalog, applied, scene, focus };
}
