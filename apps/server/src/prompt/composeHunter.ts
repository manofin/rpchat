/**
 * hunter-format — one Huntt.txt-class turn, planned and finished.
 *
 * A sibling of `composeBeat.ts` and `composeDialog.ts`, not a branch inside either.
 * The beat pipeline is sealed (STATUS F9) and the dialog path is its own contract;
 * this module reuses their decision steps and replaces the generation and
 * serialization halves:
 *
 *   shared with the beat        1 scene apply · 2 focus · 6 ambient
 *   replaced here               speaker allow-list · one script pass · panel-last serialize
 *
 * Two rules differ from both siblings:
 *
 *   - Who may speak. `approveExtras` opens a slot only on a hard_event; measured
 *     over Huntt.txt's 12 turns, 11 have exactly one speaker and 1 has none, and
 *     nobody is ever forced to talk. So the allow-list is "everyone present, capped
 *     at 3" and Pass H decides who inside it actually speaks — the cap is the
 *     server's, the silence is the writer's.
 *   - Where the panel goes. It is serialized last, because `📖상황` reports the turn
 *     that just happened. `planHunterBeat` still renders an identity-only panel up
 *     front: that copy is Pass H's context (and what the reader sees while the turn
 *     streams), never the one that gets stored.
 *
 * Pure: no DB, no fetch, no model.
 */
import { applySceneDelta, type ApplySceneDeltaResult, type PartyCatalog } from './applySceneDelta.js';
import { ambientPicks, ambientSeed, type AmbientPick } from './ambient.js';
import { resolveFocus, type FocusResult } from './resolveFocus.js';
import {
  extractHunterState, parseHunterScript, parseHunterState, renderPassH,
  type HunterSpeakerSlot, type ParseHunterScriptResult,
} from './hunterScript.js';
import { assetPathFor, type BeatBlock, type BeatCastMember } from './renderBeat.js';
import { renderHunterPanel, serializeHunterBeat, type HunterState } from './renderHunter.js';
import { extractChoices } from './templates.js';
import type { PassCard } from './passes.js';
import { canSpeak, type CastMember } from './cast.js';
import type { Scene } from '../types.js';

/**
 * Speakers allowed to hold a line in one turn, focus included.
 * Huntt.txt never exceeds one; the cap is 3 because `[💬 등장 중 인물: …]` is a list
 * and a party scene in this format is legal — the room, not the transcript, is the
 * limit. Presence is still server-owned, so this only bounds an already-bounded set.
 */
export const MAX_HUNTER_SPEAKERS = 3;

export type HunterPlanInput = {
  conversation_id?: string;
  scene: Scene;
  patch?: unknown;
  catalog: PartyCatalog;
  current_version: number;
  user_text: string;
  user_name?: string;
  cast: CastMember[];
  cards?: Record<string, PassCard>;
  main_character_id: string;
  message_id?: string | null;
  content_policy?: string;
};

export type HunterPlan = {
  applied: ApplySceneDeltaResult;
  focus: FocusResult;
  /** Who may hold a line this turn: focus first, then the rest of the room. */
  speakers: HunterSpeakerSlot[];
  ambient: AmbientPick[];
  /** Identity-only panel — Pass H context and the streaming placeholder. */
  panel_preview: string;
  pass_h: string;
  called_model: false;
};

function userNameOf(input: HunterPlanInput): string {
  return input.user_name || '나';
}

function noopApply(scene: Scene): ApplySceneDeltaResult {
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
function beatCast(cast: CastMember[], scene: Scene): BeatCastMember[] {
  return cast.map((m) => ({
    id: m.id,
    name: m.name,
    locked: m.locked,
    outfit: scene.roster?.[m.id]?.outfit,
  }));
}

/**
 * The turn's speaker allow-list.
 *
 * Focus first so Pass H reads it as the turn's centre, then everyone else present
 * and unlocked, in cast order. Ambient picks are excluded: the server has already
 * decided they are here-but-quiet, and letting them in would make that decorative.
 */
export function hunterSpeakers(input: {
  cast: CastMember[];
  scene: Scene;
  focus_id: string | null;
  ambient_ids?: string[];
  cards?: Record<string, PassCard>;
}): HunterSpeakerSlot[] {
  const present = Array.isArray(input.scene.present_ids) ? input.scene.present_ids : null;
  const ambient = new Set(input.ambient_ids ?? []);

  const eligible = input.cast.filter((m) => {
    // §4.2: a background row is narrated, never given a line. `canSpeak` is the
    // only sanctioned reader of the role tag.
    if (!canSpeak(m)) return false;
    if (m.locked) return false;
    if (present && !present.includes(m.id)) return false;
    if (m.id === input.focus_id) return true;
    return !ambient.has(m.id);
  });

  const ordered = [
    ...eligible.filter((m) => m.id === input.focus_id),
    ...eligible.filter((m) => m.id !== input.focus_id),
  ];

  return ordered.slice(0, MAX_HUNTER_SPEAKERS).map((m) => ({
    id: m.id,
    name: m.name,
    aliases: m.aliases,
    card: input.cards?.[m.id],
  }));
}

/** Steps 1-2-6 plus the Pass H prompt. No model has run yet. */
export function planHunterBeat(input: HunterPlanInput): HunterPlan {
  const catalog: PartyCatalog = { ...input.catalog, cast: input.cast };

  // 1. Scene first. Everything below reads `applied.state`, never `input.scene`.
  const applied = input.patch !== undefined
    ? applySceneDelta(input.scene, input.patch, catalog, input.current_version)
    : noopApply(input.scene);
  const scene = applied.state;

  // 2. Focus. Server only — same resolver as the other two paths, no randomness.
  const focus = resolveFocus({
    user_text: input.user_text,
    scene,
    cast: input.cast,
    catalog,
    main_character_id: input.main_character_id,
  });

  // 3. Speakers first, then ambient from whoever is left over — the dialog path's
  // ordering, and for its reason: picking ambient first would let a two-person
  // scene lose its second voice to a gesture.
  const speakers = hunterSpeakers({
    cast: input.cast,
    scene,
    focus_id: focus.focus_id,
    cards: input.cards,
  });

  const ambient = ambientPicks({
    cast: input.cast,
    scene,
    focus_id: focus.focus_id,
    extra_ids: speakers.map((sp) => sp.id).filter((id) => id !== focus.focus_id),
    seed: ambientSeed(input.conversation_id ?? '', scene, input.message_id),
  });

  const panelPreview = renderHunterPanel({
    scene,
    cast: beatCast(input.cast, scene),
    userName: userNameOf(input),
    state: null,
  });

  return {
    applied,
    focus,
    speakers,
    ambient,
    panel_preview: panelPreview,
    pass_h: renderPassH({
      speakers,
      scene,
      panel: panelPreview,
      userName: userNameOf(input),
      userText: input.user_text,
      ambientNames: ambient.map((a) => a.name),
      contentPolicy: input.content_policy,
    }),
    called_model: false,
  };
}

export type FinishedHunter = {
  blocks: BeatBlock[];
  parsed: ParseHunterScriptResult;
  /** The panel's written half, after the allow-list. */
  state: HunterState;
  /** Names the state block tried to give a panel row to and the server refused. */
  state_rejected: string[];
  /** The scene to persist: turn_no advanced, last_beat committed. */
  scene: Scene;
  /** The turn's next-input drafts, or null if Pass H emitted none (A-6: not a failure). */
  choices: string[] | null;
};

/**
 * Serialize the turn and compute the scene to persist.
 *
 * Strip order is fixed and load-bearing: `<choices>` first, then `<상태>`, then the
 * script. A name inside a draft answer or a panel row can therefore never be read
 * as a speaker line.
 *
 * `turn_no` is incremented here and nowhere else, so the `⏳️-n` a reader sees is
 * always the count of committed hunter turns — the model cannot skip, repeat or
 * invent one. A turn that produced no script does not advance it.
 */
export function finishHunterBeat(
  input: HunterPlanInput,
  plan: HunterPlan,
  passText: string,
): FinishedHunter {
  const scene = plan.applied.state;
  const { content, choices } = extractChoices(passText);
  const { content: scriptText, state: stateBody } = extractHunterState(content);
  const parsed = parseHunterScript(scriptText, plan.speakers);
  const { state, rejected_names } = parseHunterState(stateBody, plan.speakers);

  const panel = renderHunterPanel({
    scene,
    cast: beatCast(input.cast, scene),
    userName: userNameOf(input),
    state,
  });

  const blocks = serializeHunterBeat({
    script: parsed.items,
    panel,
    lineMeta: (id) => {
      const row = scene.roster?.[id];
      const emotion = row?.emotion ?? null;
      const outfit = row?.outfit ?? null;
      return {
        asset_path: assetPathFor({ characterId: id, outfit, emotion }, input.catalog),
        emotion,
        outfit,
      };
    },
  });

  const turnNo = typeof scene.turn_no === 'number' && Number.isFinite(scene.turn_no)
    ? Math.trunc(scene.turn_no)
    : 0;

  return {
    blocks,
    parsed,
    state,
    state_rejected: rejected_names,
    choices,
    scene: {
      ...scene,
      ...(parsed.items.length ? { turn_no: turnNo + 1 } : {}),
      last_beat: {
        focus_id: plan.focus.focus_id,
        extra_ids: parsed.spoke_ids.filter((id) => id !== plan.focus.focus_id),
        // A script ends on whoever spoke last, so continuity is carried by the
        // transcript itself; pinning the next focus would fight it.
        unresolved: [],
      },
    },
  };
}
