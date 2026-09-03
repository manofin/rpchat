/**
 * f9-extra-approve — who actually gets an extra dialogue slot (§4.3).
 *
 *   extra(c) iff eligible(c)
 *              AND incremental(c, focus, beat)
 *              AND (hard_event(c)
 *                   OR addressed(c)
 *                   OR opening_ack(c)
 *                   OR (EXTRA_SCORE_ENABLED && score(c) >= TAU))
 *
 * **기본은 전원 거절.** Score stays OFF. `hard_event` still opens a duty-owner
 * after a stage/flag the server applied. Party RP also opens extras when the
 * user named them (`유키랑`) or on the first untargeted beat of a conversation
 * (the rest of the room greets back). A quiet targeted turn still opens nothing.
 *
 * That asymmetry is the measurement result, not a preference. `bench/dutyAttribution`
 * showed the model attributes reasons accurately (recall 1.00 on L0) and still
 * approves one candidate per scene regardless — it fills a slot rather than judging
 * whether one is needed. `bench/necessity` V1 then showed the *incremental need*
 * question is answerable (discrimination 0.95), but that is a question for the
 * server to ask, not a licence for the model to open its own slot. So:
 *
 *   - `trigger_exists` is not a model field. §4.3, explicitly.
 *   - `incremental()` is a FILTER, never an opener.
 *   - `score()` exists but is switched off, and even when on it can only rank
 *     candidates the server already opened the door for.
 *
 * Pure: no DB, no fetch, no model.
 */
import { eligibleExtras, type ExtraRejection } from './eligibleExtras.js';
import { MAX_EXTRAS } from './assignSpeakers.js';
import type { CastMember } from './cast.js';
import type { AppliedEvent, PartyCatalog } from './applySceneDelta.js';
import type { FocusReason } from './resolveFocus.js';
import type { Scene } from '../types.js';

/**
 * The model signal of §4 step 4 ("extra 신호 — 모델(선택)"). Shipped OFF.
 *
 * Turning it on is a separate named lock: it needs its own preregistration with
 * TAU fixed in advance, because the failure this whole module exists to prevent
 * is exactly a threshold that gets loosened after seeing the results.
 */
export const EXTRA_SCORE_ENABLED = false;

export type ApproveRejectReason =
  | ExtraRejection['reason']
  | 'no_focus'         // §4.1-4: no focus ⇒ no extras at all
  | 'no_hard_event'    // the default outcome: nothing opened a slot
  | 'duty_overlap'     // the focus already covers this ground (duty_transfer guard)
  | 'dup_slot'         // someone else already fills this function slot
  | 'below_tau'        // score signal on, candidate under threshold
  | 'cap';             // K_extra cap reached

export type ApprovedExtra = {
  character_id: string;
  name: string;
  /** The duty that opened the slot. Also the function-slot key for dedupe. */
  duty: string;
  /**
   * The stage/flag transition that made this duty urgent this turn.
   * null only on the disabled score path, where no world change opened the slot.
   */
  hard_event: AppliedEvent | null;
};

export type ApproveExtrasResult = {
  approved: ApprovedExtra[];
  eligible_ids: string[];
  rejected: Array<{ id: string; reason: ApproveRejectReason }>;
  hard_events: AppliedEvent[];
  k_opened: number;
  score_ran: boolean;
};

/**
 * The duties whose slot a transition opens.
 *
 * A flag flip is owned by `catalog.flags[key].owner_duty` — 교칙 위반이 실제로
 * 일어났으니 교칙 담당이 한 마디 할 근거가 생긴다. A stage transition is owned by
 * `catalog.stages[id].closer_duty` — 수업이 시작되면 담임이 비트를 닫아야 한다.
 * Nothing else opens anything.
 */
function dutyForEvent(event: AppliedEvent, catalog: PartyCatalog): string | null {
  if (event.kind === 'flag') return catalog.flags[event.id]?.owner_duty ?? null;
  return catalog.stages?.[event.id]?.closer_duty ?? null;
}

/** Distinct duties can share one function slot ("조용히 해"), declared by the catalog. */
function slotOf(duty: string, catalog: PartyCatalog): string {
  return catalog.dutySlots?.[duty] ?? duty;
}

/**
 * §4.3 승인.
 *
 * Order matters and is the point:
 *   1. eligible (§4.2 closed set) — who may be considered at all
 *   2. hard_event / addressed / opening_ack open candidates
 *   3. incremental filters them — duty overlap with the focus, then slot dedupe
 *   4. cap at MAX_EXTRAS
 *
 * A quiet targeted turn (named the focus, world unchanged) still opens zero.
 * EXTRA_SCORE_ENABLED stays false — this is not the model filling a slot.
 */
export function approveExtras(input: {
  cast: CastMember[];
  scene: Scene;
  focus_id: string | null;
  catalog: PartyCatalog;
  applied_events: AppliedEvent[];
  user_id?: string | null;
  previous_extra_ids?: string[];
  /** Optional model signal, §4 step 4. Ignored entirely while EXTRA_SCORE_ENABLED is false. */
  scores?: Record<string, number>;
  tau?: number;
  mention_ids?: string[];
  matched_ids?: string[];
  focus_reason?: FocusReason;
  user_text?: string;
}): ApproveExtrasResult {
  const { cast, scene, catalog } = input;
  const rejected: Array<{ id: string; reason: ApproveRejectReason }> = [];

  // §4.1-4. An extra is an addition to a focus line; with no focus there is
  // nothing to add to, so the whole cast is silent.
  if (!input.focus_id) {
    for (const m of cast) rejected.push({ id: m.id, reason: 'no_focus' });
    return { approved: [], eligible_ids: [], rejected, hard_events: [], k_opened: 0, score_ran: false };
  }

  const elig = eligibleExtras({
    cast,
    scene,
    focus_id: input.focus_id,
    user_id: input.user_id,
    previous_extra_ids: input.previous_extra_ids,
  });
  rejected.push(...elig.rejected);

  const focus = cast.find((c) => c.id === input.focus_id);
  const focusDuties = new Set(focus?.duties ?? []);

  // 2. hard_event is the only opener. Events are walked in the order the server
  //    applied them, so a turn that both closes a stage and flips a flag opens
  //    slots in that same order.
  const hardEvents = input.applied_events ?? [];
  const opened: ApprovedExtra[] = [];
  const openedIds = new Set<string>();

  const tryOpen = (id: string, duty: string, event: AppliedEvent | null) => {
    if (openedIds.has(id)) return;
    if (!elig.eligible_ids.includes(id)) return;
    const member = cast.find((c) => c.id === id);
    if (!member) return;
    openedIds.add(id);
    opened.push({ character_id: id, name: member.name, duty, hard_event: event });
  };

  for (const event of hardEvents) {
    const duty = dutyForEvent(event, catalog);
    if (!duty) continue;
    for (const id of elig.eligible_ids) {
      const member = cast.find((c) => c.id === id);
      if (!member || !member.duties.includes(duty)) continue;
      tryOpen(id, duty, event);
    }
  }

  // Addressed extras: the user named them as a mention (`유키랑`) or as a second
  // addressee (`세라, 하연`). Not a score. Not "someone always speaks".
  const addressed: string[] = [];
  for (const id of [...(input.mention_ids ?? []), ...(input.matched_ids ?? [])]) {
    if (id && id !== input.focus_id && !addressed.includes(id)) addressed.push(id);
  }
  for (const id of addressed) {
    const member = cast.find((c) => c.id === id);
    if (!member) continue;
    tryOpen(id, member.duties[0] ?? `반응:${id}`, null);
  }

  // First greeting of a party chat: the rest of the room greets back.
  // "등록하고 싶어요" / later turns stay partner-only.
  const openingAck =
    input.focus_reason === 'conversation_partner'
    && !input.scene.last_beat?.focus_id
    && /안녕|하이|헬로|반갑|처음|hello|\bhi\b/i.test(input.user_text ?? '');
  if (openingAck) {
    for (const id of elig.eligible_ids) {
      const member = cast.find((c) => c.id === id);
      if (!member) continue;
      tryOpen(id, member.duties[0] ?? `반응:${id}`, null);
    }
  }

  // §4 step 4, shipped OFF. Even when enabled it may only act on a turn no
  // hard_event opened, and the server still applies TAU — the model never opens
  // its own slot. Enabling this is a new named lock with TAU fixed in advance
  // (`bench/approveExtras/preregistration.md`), which is why that file is not
  // imported here: a constant you can reach is a constant you can quietly retune.
  const scoreRan = EXTRA_SCORE_ENABLED && opened.length === 0 && !!input.scores;
  if (scoreRan) {
    const tau = input.tau ?? 1;
    for (const id of elig.eligible_ids) {
      const member = cast.find((c) => c.id === id);
      if (!member) continue;
      if ((input.scores?.[id] ?? 0) < tau) {
        rejected.push({ id, reason: 'below_tau' });
        continue;
      }
      openedIds.add(id);
      opened.push({ character_id: id, name: member.name, duty: member.duties[0] ?? id, hard_event: null });
    }
  }

  for (const id of elig.eligible_ids) {
    if (!openedIds.has(id)) rejected.push({ id, reason: 'no_hard_event' });
  }

  // 3. incremental — a filter, never an opener.
  const approved: ApprovedExtra[] = [];
  const usedSlots = new Set<string>();
  for (const row of opened) {
    // duty_transfer guard: if the focus already holds this duty, the extra would
    // be restating the focus's own ground rather than adding to it.
    if (focusDuties.has(row.duty)) {
      rejected.push({ id: row.character_id, reason: 'duty_overlap' });
      continue;
    }
    const slot = slotOf(row.duty, catalog);
    if (usedSlots.has(slot)) {
      rejected.push({ id: row.character_id, reason: 'dup_slot' });
      continue;
    }
    if (approved.length >= MAX_EXTRAS) {
      rejected.push({ id: row.character_id, reason: 'cap' });
      continue;
    }
    usedSlots.add(slot);
    approved.push(row);
  }

  return {
    approved,
    eligible_ids: elig.eligible_ids,
    rejected,
    hard_events: hardEvents.filter((e) => dutyForEvent(e, catalog) !== null),
    k_opened: approved.length,
    // Recorded so the S5 beat log can prove the signal stayed off in production.
    score_ran: scoreRan,
  };
}
