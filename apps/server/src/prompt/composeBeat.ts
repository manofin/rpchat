/**
 * f9-swap-passes — the whole beat, assembled once (§4 파이프라인, §6 렌더 스키마).
 *
 *   1 장소·존재 확정   presence, from the post-apply scene
 *   2 포커스 확정      server only (resolveFocus)
 *   3 extra 후보 닫기  eligibleExtras
 *   4 extra 신호       optional model signal — shipped OFF
 *   5 extra 최종 승인  approveExtras, default 0
 *   6 ambient          narration points, never slots
 *   7 생성             Pass N / F / E — the caller runs these
 *   8 렌더             serializeBeat
 *   9 상태 커밋        last_beat, roster emotion
 *
 * This module is the plan for a turn, not the turn itself: it calls no model and
 * touches no DB. `chat.ts` executes the pass prompts it hands back and then calls
 * `finishBeat` with whatever the model actually produced. Splitting it this way is
 * what lets a bench assert the pipeline ORDER (A-5) without a live model — and
 * order is the thing that breaks silently, because routing on a stale scene
 * produces a plausible answer to the previous turn's world.
 *
 * Pure: no DB, no fetch, no model.
 */
import { applySceneDelta, type ApplySceneDeltaResult, type PartyCatalog } from './applySceneDelta.js';
import { approveExtras, type ApprovedExtra } from './approveExtras.js';
import { ambientPicks, ambientSeed, type AmbientPick } from './ambient.js';
import { assignSpeakers, type AssignSpeakersOutput } from './assignSpeakers.js';
import { resolveFocus, type FocusResult } from './resolveFocus.js';
import {
  renderPassE, renderPassF, renderPassN, splitFocusText, type PassCard,
} from './passes.js';
import {
  assetPathFor, renderHeader, renderUi, serializeBeat,
  type BeatBlock, type BeatLine, type BeatUi,
} from './renderBeat.js';
import { castFromCharacters, withConversationStarter, type PartyTagRow } from './tagsCatalog.js';
import type { CastMember } from './cast.js';
import type { Scene } from '../types.js';

export type BeatPlanInput = {
  /** Only used to seed ambient selection; absent is fine for an isolated plan. */
  conversation_id?: string;
  scene: Scene;
  patch?: unknown;
  catalog: PartyCatalog;
  current_version: number;
  user_text: string;
  /** Defaults to 나, matching the 1:1 builder's persona fallback. */
  user_name?: string;
  cast: CastMember[];
  /** Character sheets by id. A missing entry degrades to name-only, never throws. */
  cards?: Record<string, PassCard>;
  main_character_id: string;
  user_id?: string | null;
  message_id?: string | null;
  content_policy?: string;
  /** World facts injected into Pass E as given, e.g. `empty_seat = beside(나리)`. */
  facts?: string[];
};

export type BeatPlan = {
  applied: ApplySceneDeltaResult;
  focus: FocusResult;
  approved_extras: ApprovedExtra[];
  eligible_ids: string[];
  rejected: ReturnType<typeof approveExtras>['rejected'];
  ambient: AmbientPick[];
  assigned: AssignSpeakersOutput;
  /** The rows to persist, derived once so chat.ts and the benches agree. */
  messages: PersistSpeakerMessage[];
  header: string | null;
  ui: BeatUi;
  /** Pass N is always planned; a beat with no focus is still a narrated beat. */
  pass_n: string;
  /** null when there is no focus — §4.1-4, and the caller skips Pass F entirely. */
  pass_f: string | null;
  called_model: false;
};

export type PassEPlan = { character_id: string; name: string; duty: string; prompt: string };

/** One row per speaker, in §6 order. The persist shape, computed in one place. */
export type PersistSpeakerMessage = {
  speaker_character_id: string;
  speaker_name: string;
  slot: 'main' | 'extra';
  /** The duty that opened the slot. Undefined for the focus. */
  reason?: string;
  meta: { speaker_character_id: string };
};

/**
 * f9-tags-catalog — derive the cast from the roster's `party:` tags.
 * An untagged roster (every existing 1:1 conversation) yields null, so generate
 * stays on the 1:1 path unchanged.
 */
export function partyCastForGenerate(
  conv: { character_id: string },
  roster: PartyTagRow[],
): CastMember[] | null {
  if (!roster.length) return null;
  const tagged = castFromCharacters(roster, conv.character_id);
  if (!tagged) return null;
  const starter = roster.find((r) => r.id === conv.character_id);
  return withConversationStarter(tagged, {
    id: conv.character_id,
    name: starter?.name ?? conv.character_id,
  });
}

function cardFor(id: string, input: BeatPlanInput): PassCard {
  return input.cards?.[id] ?? { name: input.cast.find((c) => c.id === id)?.name ?? id };
}

function userNameOf(input: BeatPlanInput): string {
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

/** Steps 1-6 plus the Pass N / Pass F prompts. No model has run yet. */
export function planBeat(input: BeatPlanInput): BeatPlan {
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
  });

  // 3-5. Candidates closed, then approved. Default: nobody.
  const approval = approveExtras({
    cast: input.cast,
    scene,
    focus_id: focus.focus_id,
    catalog,
    applied_events: applied.discarded ? [] : applied.appliedEvents,
    user_id: input.user_id ?? null,
  });
  const extraIds = approval.approved.map((e) => e.character_id);

  // 6. Ambient — the people with no line, noticed in narration only.
  const ambient = ambientPicks({
    cast: input.cast,
    scene,
    focus_id: focus.focus_id,
    extra_ids: extraIds,
    seed: ambientSeed(input.conversation_id ?? "", scene, input.message_id),
  });

  const assigned = assignSpeakers({
    scores: {},
    cast: input.cast,
    main_character_id: input.main_character_id,
    main_speaker_id: focus.focus_id,
    eligible_secondary_ids: extraIds,
  });

  const header = renderHeader(scene);
  const ui = renderUi({
    scene,
    cast: input.cast,
    focus_id: focus.focus_id,
    extra_ids: extraIds,
    intent_hint: scene.beat_goal ?? null,
  });

  const focusCard = focus.focus_id ? cardFor(focus.focus_id, input) : null;

  const dutyOf = new Map(approval.approved.map((e) => [e.character_id, e.duty] as const));
  const messages: PersistSpeakerMessage[] = assigned.speakers.map((sp) => {
    const duty = dutyOf.get(sp.character_id);
    return {
      speaker_character_id: sp.character_id,
      speaker_name: input.cast.find((c) => c.id === sp.character_id)?.name ?? sp.character_id,
      slot: sp.slot,
      ...(sp.slot === 'extra' && duty ? { reason: duty } : {}),
      meta: { speaker_character_id: sp.character_id },
    };
  });

  return {
    applied,
    focus,
    approved_extras: approval.approved,
    eligible_ids: approval.eligible_ids,
    rejected: approval.rejected,
    ambient,
    assigned,
    messages,
    header,
    ui,
    pass_n: renderPassN({
      focusCard,
      cast: input.cast,
      scene,
      header,
      userText: input.user_text,
      ambientNames: ambient.map((a) => a.name),
    }),
    pass_f: focusCard
      ? renderPassF({
          focusCard,
          userName: userNameOf(input),
          userText: input.user_text,
          scene,
          header,
          narration: '',
          contentPolicy: input.content_policy,
        })
      : null,
    called_model: false,
  };
}

/**
 * Pass F depends on Pass N's actual output, so it is rebuilt once narration exists.
 * A failed Pass N yields an empty narration and the prompt still works — the
 * section is simply omitted (A-6).
 */
export function passFWith(input: BeatPlanInput, plan: BeatPlan, narration: string): string | null {
  if (!plan.focus.focus_id) return null;
  return renderPassF({
    focusCard: cardFor(plan.focus.focus_id, input),
    userName: userNameOf(input),
    userText: input.user_text,
    scene: plan.applied.state,
    header: plan.header,
    narration,
    contentPolicy: input.content_policy,
  });
}

/** One Pass E prompt per approved extra, in approval order. */
export function planPassE(input: BeatPlanInput, plan: BeatPlan, narration: string, focusText: string): PassEPlan[] {
  const focusName = plan.focus.focus_id
    ? (input.cast.find((c) => c.id === plan.focus.focus_id)?.name ?? '')
    : '';
  return plan.approved_extras.map((extra) => ({
    character_id: extra.character_id,
    name: extra.name,
    duty: extra.duty,
    prompt: renderPassE({
      card: cardFor(extra.character_id, input),
      duty: extra.duty,
      focusName,
      focusText,
      narration,
      userName: userNameOf(input),
      userText: input.user_text,
      facts: input.facts,
    }),
  }));
}

export type BeatOutputs = {
  narration: string;
  focus_text: string;
  /** Whatever each extra actually produced. A missing id simply has no block. */
  extra_texts: Record<string, string>;
};

export type FinishedBeat = {
  blocks: BeatBlock[];
  /** The scene to persist: step 9, with last_beat and roster emotion committed. */
  scene: Scene;
};

function lineFor(
  id: string,
  name: string,
  text: string,
  scene: Scene,
  catalog: PartyCatalog,
): BeatLine {
  const row = scene.roster?.[id];
  const emotion = row?.emotion ?? null;
  const outfit = row?.outfit ?? null;
  return {
    character_id: id,
    name,
    text,
    asset_path: assetPathFor({ characterId: id, outfit, emotion }, catalog),
    emotion,
    outfit,
  };
}

/**
 * Steps 8-9: serialize what the passes produced, and compute the scene to persist.
 *
 * `unresolved` is decided here, by the server, from a deliberately small rule set.
 * §4.1-2 makes the previous beat's unresolved party the next beat's focus, so a
 * false positive pins the conversation to one character. Under-detecting costs a
 * turn of continuity; over-detecting costs control of the scene, which is worse —
 * so anything ambiguous is simply not recorded.
 */
export function finishBeat(input: BeatPlanInput, plan: BeatPlan, outputs: BeatOutputs): FinishedBeat {
  const scene = plan.applied.state;
  const catalog = input.catalog;
  const split = splitFocusText(outputs.focus_text);

  const focusId = plan.focus.focus_id;
  const focusName = focusId ? (input.cast.find((c) => c.id === focusId)?.name ?? focusId) : '';

  const focus_line = focusId && split.line
    ? lineFor(focusId, focusName, split.line, scene, catalog)
    : null;

  const extra_lines: BeatLine[] = [];
  const spokeExtraIds: string[] = [];
  for (const extra of plan.approved_extras) {
    const text = (outputs.extra_texts[extra.character_id] ?? '').trim();
    if (!text) continue;   // a failed Pass E drops that extra only (A-6)
    extra_lines.push(lineFor(extra.character_id, extra.name, text, scene, catalog));
    spokeExtraIds.push(extra.character_id);
  }

  const blocks = serializeBeat({
    header: plan.header,
    narration_open: outputs.narration.trim() ? [outputs.narration.trim()] : [],
    focus_line,
    thought: focusId && split.thought
      ? { character_id: focusId, name: focusName, text: split.thought }
      : null,
    extra_lines,
    ui: plan.ui,
  });

  return {
    blocks,
    scene: {
      ...scene,
      last_beat: {
        focus_id: focusId,
        extra_ids: spokeExtraIds,
        unresolved: detectUnresolved(focusId, split.line),
      },
    },
  };
}

/** Second-person request patterns. Deliberately narrow — see `finishBeat`. */
const REQUEST_ENDINGS = [
  '?', '？',
  '해줘', '해 줘', '해줄래', '해봐', '해 봐', '말해', '대답해', '答え',
  '주세요', '하세요', '하십시오', '봐라', '해라',
];

export function detectUnresolved(focusId: string | null, line: string): string[] {
  if (!focusId) return [];
  const text = line.trim();
  if (!text) return [];
  // Only the CLOSING sentence counts. A question earlier in a long turn was
  // usually answered inside the same block — "왜 그래?" followed by the character
  // turning away and looking out the window is not an open question, and treating
  // it as one would pin the next beat's focus to them for no reason.
  // The terminator may be followed by a closing quote — "왜 그래?" is one sentence,
  // not a sentence boundary sitting inside the quotation mark.
  const sentences = text
    .split(/(?<=[.!?。！？…]["'\u2019\u201d\uff09)\u300d\u300f]*)\s+|\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const last = sentences[sentences.length - 1] ?? text;
  return REQUEST_ENDINGS.some((p) => last.includes(p)) ? [focusId] : [];
}
