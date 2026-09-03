/**
 * dialog-format — the Dialog.txt-class server template layer.
 *
 * The shipped beat renders `1일차 · 목 · 09:38 · 맑음 · 교실` and closes with a UI
 * JSON block. The transcript this slice targets opens instead with a bracketed
 * header and a five-row INFO sheet, and carries its dialogue as a script:
 *
 *   [T-33] [이틀 뒤·오전 11시 35분] [진령청 본부 앞 도로] [맑음]
 *   [정보]: 황지명 | 민간인(영시 보유·비계약) | 비전투 | 무소속
 *   [계약]: —
 *   [침식]: 없음(확인)
 *   [목표]: 자신의 체질을 파악하는 것 / 추가 검증
 *   [인물]: 오세린 | 봉인국 국장·검사 중 / 한여진 | 계약국 1급·보증
 *
 * Same invariant as `renderBeat.ts`, and for the same reason: every value here is
 * scene state. Nothing in this file reads model output, so the model can never
 * decide a turn number, a 침식 level or who is standing in the room — it only
 * writes the prose between the brackets. `—` is what an empty row renders as,
 * which is why the fields are strings rather than a sheet of numbers: a world with
 * 계약/침식 and a world with HP/₩ do not share a schema, but they share this shape.
 *
 * Pure: no DB, no fetch, no model, no filesystem. Never throws on bad input.
 */
import type { BeatBlock, BeatCastMember, BeatLine } from './renderBeat.js';
import type { Scene } from '../types.js';

/** The row value used when a field is empty. Matches the transcript. */
export const EMPTY_FIELD = '—';
/** `[인물]` entry separator. */
const CAST_SEP = ' / ';
/** `[목표]` entry separator. */
const GOAL_SEP = ' / ';
/** Speaker and line are joined by this in the script the model writes and reads. */
export const SPEAKER_SEP = ' | ';

function clean(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

function bracket(v: string): string {
  return `[${v}]`;
}

/**
 * `[T-33] [이틀 뒤·오전 11시 35분] [진령청 본부 앞 도로] [맑음]`
 *
 * Only fields the scene actually carries appear — same rule as `renderHeader`,
 * and for the same reason: HARD_RULES forbids declaring a time the scene does not
 * have, and a server template is the one place that could quietly break it.
 *
 * `time_phrase` is preferred over the clock because the transcript's sense of time
 * is narrative ("이틀 뒤·오전 11시 35분"), not a simulation tick. When only
 * `clock_minutes` exists it is rendered as a clock rather than dropped.
 */
export function renderDialogHeader(scene: Scene): string | null {
  const parts: string[] = [];

  if (typeof scene.turn_no === 'number' && Number.isFinite(scene.turn_no)) {
    parts.push(bracket(`T-${Math.trunc(scene.turn_no)}`));
  }

  const phrase = clean(scene.time_phrase);
  if (phrase) {
    parts.push(bracket(phrase));
  } else if (typeof scene.clock_minutes === 'number' && Number.isFinite(scene.clock_minutes)) {
    const m = ((Math.trunc(scene.clock_minutes) % 1440) + 1440) % 1440;
    const clock = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const day = typeof scene.day_index === 'number' && Number.isFinite(scene.day_index)
      ? `${Math.trunc(scene.day_index)}일차·`
      : '';
    parts.push(bracket(`${day}${clock}`));
  }

  const place = clean(scene.location) || clean(scene.place);
  if (place) parts.push(bracket(place));

  const weather = clean(scene.weather);
  if (weather) parts.push(bracket(weather));

  return parts.length ? parts.join(' ') : null;
}

/**
 * `[인물]` — who is in the scene, with the relation note the scene carries.
 *
 * Presence is the scene's occupancy list, exactly as `renderBeat.isAddressable`
 * reads it. A cast member with no note renders as a bare name rather than being
 * omitted: the row answers "who is here", and a missing descriptor is a gap in
 * authoring, not a reason to make someone disappear from the room.
 */
export function renderCastRow(scene: Scene, cast: BeatCastMember[]): string {
  const present = Array.isArray(scene.present_ids) ? scene.present_ids : null;
  const roster = scene.roster ?? {};

  const entries = cast
    .filter((m) => (present ? present.includes(m.id) : false))
    .map((m) => {
      const note = clean(roster[m.id]?.note);
      return note ? `${m.name}${SPEAKER_SEP}${note}` : m.name;
    });

  return entries.length ? entries.join(CAST_SEP) : EMPTY_FIELD;
}

export type InfoRow = { label: string; value: string };

/**
 * The INFO sheet rows, in transcript order: 정보 · 계약 · 침식 · 목표 · 인물.
 *
 * Returned as rows rather than a string so the web can lay them out and a bench
 * can assert one field without parsing text back out — the same reason the beat's
 * UI block is JSON rather than a rendered line.
 */
export function renderInfoRows(input: {
  scene: Scene;
  cast: BeatCastMember[];
  userName: string;
}): InfoRow[] {
  const { scene, cast } = input;
  const info = scene.info ?? {};
  const name = clean(input.userName) || '나';

  const statusSegs = (info.status ?? []).map(clean).filter(Boolean);
  const goals = (info.goals ?? []).map(clean).filter(Boolean);

  const rows: InfoRow[] = [
    { label: '정보', value: [name, ...statusSegs].join(SPEAKER_SEP) },
    { label: '계약', value: clean(info.contract) || EMPTY_FIELD },
    { label: '침식', value: clean(info.erosion) || EMPTY_FIELD },
    { label: '목표', value: goals.length ? goals.join(GOAL_SEP) : EMPTY_FIELD },
  ];

  for (const row of info.extra ?? []) {
    const label = clean(row?.label);
    if (!label) continue;
    rows.push({ label, value: clean(row?.value) || EMPTY_FIELD });
  }

  rows.push({ label: '인물', value: renderCastRow(scene, cast) });
  return rows;
}

/** The INFO block as the transcript prints it. One `[라벨]: 값` per line. */
export function renderInfoBlock(input: {
  scene: Scene;
  cast: BeatCastMember[];
  userName: string;
}): string {
  return renderInfoRows(input).map((r) => `${bracket(r.label)}: ${r.value}`).join('\n');
}

/**
 * A script item: either narration, or one character's line.
 *
 * This is the unit the shipped beat cannot express. Its serialization is fixed —
 * one focus line, then thought, then extras — so 설록이 네 번 말하고 그 사이에
 * 서술이 끼는 T-1 형태를 만들 수 없다. Here the order is data, produced by the
 * parser from the model's script and validated against the server's allow-list.
 */
export type ScriptItem =
  | { kind: 'narration'; text: string }
  | { kind: 'line'; character_id: string; name: string; text: string };

export type DialogBeatInput = {
  header: string | null;
  info: string | null;
  script: ScriptItem[];
  /** Portrait/emotion lookup for a speaker, or null. Same contract as BeatLine. */
  lineMeta?: (characterId: string) => Pick<BeatLine, 'asset_path' | 'emotion' | 'outfit'>;
};

const NO_META = { asset_path: null, emotion: null, outfit: null };

/**
 * dialog 직렬화: INFO → (NARRATION | LINE)* — 스크립트 순서 그대로.
 *
 * There is no reordering step and no fixed slot table. `seq` is assigned here so
 * that `chat.ts` appends in exactly this order and the client never has to sort
 * (the beat path's `beat_seq` invariant, unchanged).
 */
export function serializeDialogBeat(input: DialogBeatInput): BeatBlock[] {
  const out: BeatBlock[] = [];
  const meta = input.lineMeta ?? (() => NO_META);

  const push = (
    kind: BeatBlock['kind'],
    text: string,
    speaker: { id: string; name: string } | null,
    extra: Pick<BeatLine, 'asset_path' | 'emotion' | 'outfit'>,
  ) => {
    const t = text.trim();
    if (!t) return;
    out.push({
      seq: out.length,
      kind,
      speaker_character_id: speaker?.id ?? null,
      speaker_name: speaker?.name ?? null,
      text: t,
      asset_path: extra.asset_path,
      emotion: extra.emotion,
      outfit: extra.outfit,
    });
  };

  const header = (input.header ?? '').trim();
  const info = (input.info ?? '').trim();
  // Header and INFO are one block: the transcript prints them as a single
  // bracketed sheet, and splitting them would make the web render two panels
  // where the format has one.
  const sheet = [header, info].filter(Boolean).join('\n');
  if (sheet) push('info', sheet, null, NO_META);

  for (const item of input.script) {
    if (item.kind === 'narration') {
      push('narration', item.text, null, NO_META);
    } else {
      push('line', item.text, { id: item.character_id, name: item.name }, meta(item.character_id));
    }
  }

  return out;
}
