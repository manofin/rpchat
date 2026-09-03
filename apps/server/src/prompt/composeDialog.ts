/**
 * dialog-format — one Dialog.txt-class turn, planned and finished.
 *
 * Deliberately a sibling of `composeBeat.ts` rather than a branch inside it. The
 * beat pipeline is sealed (STATUS F9) and its shape is load-bearing for the party
 * path that is live; this module reuses its decision steps and replaces only the
 * generation and serialization halves.
 *
 *   shared with the beat        1 scene apply · 2 focus · 6 ambient
 *   replaced here               speaker allow-list · one script pass · script serialize
 *
 * The one substantive rule change is who may speak. `approveExtras` opens a slot
 * only on a hard_event, so a story with no duty catalog yields exactly one voice —
 * correct for the school beat, wrong for this transcript, whose ordinary turn has
 * two people talking. Measured over Dialog.txt's 42 turns: 19 turns with one
 * speaker, 15 with two, 5 with three, 3 with none. So the allow-list here is
 * "everyone present, capped at 3", and Pass S chooses who inside it actually
 * speaks — the cap is the server's, the silence is the writer's. Nobody is forced
 * to speak, which is the SillyTavern failure the beat engine exists to avoid.
 *
 * Pure: no DB, no fetch, no model.
 */
import { applySceneDelta, type ApplySceneDeltaResult, type PartyCatalog } from './applySceneDelta.js';
import { ambientPicks, ambientSeed, type AmbientPick } from './ambient.js';
import { resolveFocus, type FocusResult } from './resolveFocus.js';
import { parseScript, renderPassS, type ParseScriptResult, type SpeakerSlot } from './dialogScript.js';
import { assetPathFor, type BeatBlock, type BeatCastMember } from './renderBeat.js';
import { renderDialogHeader, renderInfoBlock, serializeDialogBeat } from './renderDialog.js';
import type { PassCard } from './passes.js';
import { canSpeak, type CastMember } from './cast.js';
import type { Scene } from '../types.js';

/**
 * Speakers allowed to hold a line in one turn, focus included.
 * 3 = the maximum observed across Dialog.txt's 42 turns.
 */
export const MAX_DIALOG_SPEAKERS = 3;

export type DialogPlanInput = {
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

export type DialogPlan = {
  applied: ApplySceneDeltaResult;
  focus: FocusResult;
  /** Who may hold a line this turn: focus first, then the rest of the room. */
  speakers: SpeakerSlot[];
  ambient: AmbientPick[];
  header: string | null;
  info: string | null;
  pass_s: string;
  called_model: false;
};

function userNameOf(input: DialogPlanInput): string {
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
 * Focus first so Pass S reads it as the turn's centre, then everyone else who is
 * present and unlocked, in cast order. Ambient picks are excluded: the server has
 * already decided they are here-but-quiet this turn, and letting them into the
 * allow-list would make that decision decorative.
 */
export function dialogSpeakers(input: {
  cast: CastMember[];
  scene: Scene;
  focus_id: string | null;
  ambient_ids?: string[];
  cards?: Record<string, PassCard>;
}): SpeakerSlot[] {
  const present = Array.isArray(input.scene.present_ids) ? input.scene.present_ids : null;
  const ambient = new Set(input.ambient_ids ?? []);

  const eligible = input.cast.filter((m) => {
    // §4.2: a background row is narrated, never given a line. `canSpeak` is the
    // only sanctioned reader of the role tag — comparing the string here would
    // fork the definition.
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

  return ordered.slice(0, MAX_DIALOG_SPEAKERS).map((m) => ({
    id: m.id,
    name: m.name,
    aliases: m.aliases,
    card: input.cards?.[m.id],
  }));
}

/** Steps 1-2-6 plus the Pass S prompt. No model has run yet. */
export function planDialogBeat(input: DialogPlanInput): DialogPlan {
  const catalog: PartyCatalog = { ...input.catalog, cast: input.cast };

  // 1. Scene first. Everything below reads `applied.state`, never `input.scene`.
  const applied = input.patch !== undefined
    ? applySceneDelta(input.scene, input.patch, catalog, input.current_version)
    : noopApply(input.scene);
  const scene = applied.state;

  // 2. Focus. Server only — same resolver as the beat path, no randomness, no model.
  const focus = resolveFocus({
    user_text: input.user_text,
    scene,
    cast: input.cast,
    catalog,
    main_character_id: input.main_character_id,
  });

  // 3. The speaker allow-list, then ambient from whoever is left over.
  //
  // The beat path picks ambient first because its slot count is 1 + at most two
  // hard-earned extras, so the rest of the room is ambient by definition. Here the
  // cap is the only limit, and picking ambient first would let a two-person scene
  // lose its second voice to a gesture — which is precisely the turn Dialog.txt
  // has 15 times. So the floor is assigned first and ambient describes the excess.
  const speakers = dialogSpeakers({
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

  const cast = beatCast(input.cast, scene);
  const header = renderDialogHeader(scene);
  const info = renderInfoBlock({ scene, cast, userName: userNameOf(input) });

  return {
    applied,
    focus,
    speakers,
    ambient,
    header,
    info,
    pass_s: renderPassS({
      speakers,
      cast: input.cast,
      scene,
      header,
      info,
      userName: userNameOf(input),
      userText: input.user_text,
      ambientNames: ambient.map((a) => a.name),
      contentPolicy: input.content_policy,
    }),
    called_model: false,
  };
}

export type FinishedDialog = {
  blocks: BeatBlock[];
  parsed: ParseScriptResult;
  /** The scene to persist: turn_no advanced, last_beat committed. */
  scene: Scene;
};

/**
 * Serialize the script and compute the scene to persist.
 *
 * `turn_no` is incremented here and nowhere else, so the `[T-n]` a reader sees is
 * always the count of committed dialog turns — the model cannot skip, repeat or
 * invent one. A turn that produced no script at all does not advance it.
 */
export function finishDialogBeat(
  input: DialogPlanInput,
  plan: DialogPlan,
  scriptText: string,
): FinishedDialog {
  const scene = plan.applied.state;
  const parsed = parseScript(scriptText, plan.speakers);

  const blocks = serializeDialogBeat({
    header: plan.header,
    info: plan.info,
    script: parsed.items,
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
    scene: {
      ...scene,
      ...(parsed.items.length ? { turn_no: turnNo + 1 } : {}),
      last_beat: {
        focus_id: plan.focus.focus_id,
        extra_ids: parsed.spoke_ids.filter((id) => id !== plan.focus.focus_id),
        // The beat path pins the next focus on an unresolved question. A script
        // ends on whoever spoke last, so continuity is already carried by the
        // transcript itself and pinning would fight it.
        unresolved: [],
      },
    },
  };
}
