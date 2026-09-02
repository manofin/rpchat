import { isBackground, type CastMember } from './cast.js';

export const MAX_EXTRAS = 2;
export const MAIN_LINE_CAP = 10;
export const EXTRA_LINE_CAP = 2;

export type SpeakerSlot = 'main' | 'extra';

export type ProposedLines = {
  character_id: string;
  line_count: number;
};

export type AssignedSpeaker = {
  character_id: string;
  slot: SpeakerSlot;
  score: number;
  meta: { speaker_character_id: string };
};

export type AssignSpeakersInput = {
  scores: Record<string, number>;
  cast: CastMember[];
  main_character_id: string;
  /**
   * The resolved focus, or null. null is a real outcome, not a missing value:
   * §4.1-4 says a beat with no focus gets zero dialogue slots. Do not pass the
   * conversation's main character here as a stand-in.
   */
  main_speaker_id: string | null;
  /**
   * f9-aux-speaker-generate: the ONLY source of extra slots. Router scores select
   * the main speaker; they no longer grant anyone a secondary slot. Omitted or
   * empty means nobody speaks besides the main (fail-closed).
   */
  eligible_secondary_ids?: string[];
  proposed_lines?: ProposedLines[];
};

export type AssignSpeakersOutput = {
  speakers: AssignedSpeaker[];
  silent: string[];
  kept_lines: ProposedLines[];
  dropped_lines: ProposedLines[];
};

function backgroundById(cast: CastMember[], id: string): boolean {
  const m = cast.find((c) => c.id === id);
  return !!m && isBackground(m);
}

function speaker(id: string, slot: SpeakerSlot, score: number): AssignedSpeaker {
  return { character_id: id, slot, score, meta: { speaker_character_id: id } };
}

export function assignSpeakers(input: AssignSpeakersInput): AssignSpeakersOutput {
  const { scores, cast, main_speaker_id, proposed_lines } = input;

  // §4.1-4: no focus ⇒ no dialogue slots at all. This used to fall back to the
  // conversation's main character, which meant a turn could never be silent —
  // exactly the "후보가 있으면 누군가는 말한다" behaviour §2 discards. A beat with
  // no focus is narration, not an error, and it opens no extras either: an extra
  // is by definition an addition to a focus line that does not exist here.
  const mainId =
    main_speaker_id && !backgroundById(cast, main_speaker_id) ? main_speaker_id : null;

  const speakers: AssignedSpeaker[] = mainId
    ? [speaker(mainId, 'main', scores[mainId] ?? 0)]
    : [];

  // Extras are whoever the approval gate admitted, in the order it gave them.
  // Score is still recorded on the slot for diagnostics, but never selects it.
  const seenExtra = new Set<string>(mainId ? [mainId] : []);
  for (const id of mainId ? (input.eligible_secondary_ids ?? []) : []) {
    if (seenExtra.has(id)) continue;
    const member = cast.find((c) => c.id === id);
    if (!member) continue;
    if (isBackground(member)) continue;
    seenExtra.add(id);
    speakers.push(speaker(id, 'extra', scores[id] ?? 0));
    if (speakers.filter((s) => s.slot === 'extra').length >= MAX_EXTRAS) break;
  }

  const speaking = new Set(speakers.map((s) => s.character_id));
  const silent = cast.filter((c) => !speaking.has(c.id)).map((c) => c.id);

  const slotOf = new Map(speakers.map((s) => [s.character_id, s.slot] as const));
  const kept_lines: ProposedLines[] = [];
  const dropped_lines: ProposedLines[] = [];

  if (proposed_lines) {
    for (const row of proposed_lines) {
      const slot = slotOf.get(row.character_id);
      if (!slot) {
        if (row.line_count > 0) dropped_lines.push({ ...row });
        continue;
      }
      const cap = slot === 'main' ? MAIN_LINE_CAP : EXTRA_LINE_CAP;
      const keep = Math.min(row.line_count, cap);
      const drop = row.line_count - keep;
      if (keep > 0) kept_lines.push({ character_id: row.character_id, line_count: keep });
      if (drop > 0) dropped_lines.push({ character_id: row.character_id, line_count: drop });
    }
  }

  return { speakers, silent, kept_lines, dropped_lines };
}
