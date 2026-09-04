/**
 * f9-beat-render — the server template layer of the beat contract
 * (`Notes_260902_210901.txt` §1 산출물 계약, §6 렌더 스키마).
 *
 * Everything here is produced from scene state and the story catalog. Nothing in
 * this file reads model output, and nothing downstream needs to parse a header,
 * a status number, a roster chip or an image path back out of generated prose.
 * That is the point of shipping this slice first: once the header/UI/image are
 * server templates, the later passes only have to produce dialogue.
 *
 * Pure: no DB, no fetch, no model, no filesystem. Never throws on bad input.
 */
import type { PartyCatalog } from './applySceneDelta.js';
import type { Scene } from '../types.js';

/**
 * `info` is the dialog-format sheet (`renderDialog.ts`); `panel`/`system` are the
 * hunter-format ones (`renderHunter.ts`). The beat path never emits any of them,
 * and neither of the other two emits `header`/`ui`. They live in one union so a
 * stored block only ever has to name its kind.
 */
export type BeatBlockKind =
  | 'header' | 'narration' | 'line' | 'thought' | 'ui' | 'info' | 'panel' | 'system';

/** A cast row as this module needs it. Structural, so any richer cast type fits. */
export type BeatCastMember = {
  id: string;
  name: string;
  locked?: boolean;
  outfit?: string;
};

export type RosterChip = {
  id: string;
  name: string;
  /** The character's emotion emoji, or 🔒 when they are not addressable this turn. */
  chip: string;
  locked: boolean;
  in_room: boolean;
};

export type BeatUi = {
  location_badge: string | null;
  user_sheet: Scene['user_sheet'] | null;
  roster: RosterChip[];
  intent_hint: string | null;
};

export type BeatLine = {
  character_id: string;
  name: string;
  text: string;
  asset_path: string | null;
  emotion: string | null;
  outfit: string | null;
};

export type BeatThought = { character_id: string; name: string; text: string };

/**
 * The §6 slots. Every narration slot is optional and may be empty — a turn that
 * fills only HEADER, LINE and UI is a legal beat.
 */
export type BeatInput = {
  header: string | null;
  narration_open?: string[];
  focus_line?: BeatLine | null;
  narration_after_line?: string[];
  thought?: BeatThought | null;
  narration_after_thought?: string[];
  extra_lines?: BeatLine[];
  narration_close?: string[];
  ui: BeatUi | null;
};

export type BeatBlock = {
  seq: number;
  kind: BeatBlockKind;
  /** null for header / narration / ui — those have no speaker by construction. */
  speaker_character_id: string | null;
  speaker_name: string | null;
  text: string;
  asset_path: string | null;
  emotion: string | null;
  outfit: string | null;
};

export const LOCK_CHIP = '🔒';
/** Chip shown for an addressable character whose emotion the scene has not set. */
export const NEUTRAL_CHIP = '·';
const MINUTES_PER_DAY = 1440;

/**
 * Path segment guard. The catalog allow-list is the real gate; this only stops a
 * separator or a control byte from reaching the media route.
 */
function isSafeSegment(v: string): boolean {
  if (!v || v.length > 64) return false;
  if (v === '.' || v === '..' || v.includes('..')) return false;
  for (const ch of v) {
    if (ch === '/' || ch === '\\') return false;
    if (ch.codePointAt(0)! < 0x20) return false;
  }
  return true;
}

function clockLabel(minutes: number): string {
  const m = ((Math.trunc(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * §1 헤더: 날짜·일차·시각·날씨·장소.
 *
 * Only fields the scene actually carries appear. A scene with no clock and no day
 * index renders a shorter header rather than an invented date — HARD_RULES forbids
 * declaring time that is not in the scene, and the header is the one place a server
 * template could quietly break that rule on the model's behalf.
 */
export function renderHeader(scene: Scene): string | null {
  const parts: string[] = [];
  if (typeof scene.day_index === 'number' && Number.isFinite(scene.day_index)) {
    parts.push(`${Math.trunc(scene.day_index)}일차`);
  }
  if (scene.weekday) parts.push(scene.weekday);
  if (typeof scene.clock_minutes === 'number' && Number.isFinite(scene.clock_minutes)) {
    parts.push(clockLabel(scene.clock_minutes));
  }
  if (scene.weather) parts.push(scene.weather);
  const place = scene.location ?? scene.place ?? '';
  if (place) parts.push(place);
  return parts.length ? parts.join(' · ') : null;
}

/** The scene's occupancy list, or null when the scene has never declared one. */
function declaredPresence(scene: Scene): string[] | null {
  return Array.isArray(scene.present_ids) ? scene.present_ids : null;
}

/**
 * Is this character a conversation target this turn?
 *
 * 🔒 in §6 means "이 턴 대화 대상 아님 또는 관계 미해금". Locked characters and
 * anyone outside the room are never addressable; among those present, only the
 * turn's focus and its approved extras are. Everyone else stays on the roster —
 * visible, but not a target — which keeps the UI honest about a cast that is
 * larger than the set of people who spoke.
 */
export function isAddressable(
  member: BeatCastMember,
  scene: Scene,
  focusId: string | null,
  extraIds: string[] = [],
): boolean {
  if (member.locked) return false;
  const present = declaredPresence(scene);
  if (present && !present.includes(member.id)) return false;
  if (focusId && member.id === focusId) return true;
  return extraIds.includes(member.id);
}

/**
 * §6 UI. Not a generation product: the model never chooses a chip, and this
 * function takes no model text as an argument.
 */
export function renderUi(input: {
  scene: Scene;
  cast: BeatCastMember[];
  focus_id?: string | null;
  extra_ids?: string[];
  intent_hint?: string | null;
}): BeatUi {
  const { scene, cast } = input;
  const focusId = input.focus_id ?? null;
  const extraIds = input.extra_ids ?? [];
  const present = declaredPresence(scene);
  const roster = scene.roster ?? {};

  return {
    location_badge: scene.location ?? scene.place ?? null,
    user_sheet: scene.user_sheet ?? null,
    roster: cast.map((m): RosterChip => {
      const addressable = isAddressable(m, scene, focusId, extraIds);
      const emotion = roster[m.id]?.emotion;
      return {
        id: m.id,
        name: m.name,
        chip: addressable ? (emotion || NEUTRAL_CHIP) : LOCK_CHIP,
        locked: !addressable,
        in_room: present ? present.includes(m.id) : false,
      };
    }),
    intent_hint: input.intent_hint ?? null,
  };
}

/**
 * §5 이미지: emotion × outfit → 로컬 자산 경로. The generator never invents this.
 *
 * Returns null — not a guess — whenever the outfit is not an allowed token or the
 * emotion has no index in the catalog. A null path is a normal outcome, rendered
 * as name + line with no image, so an incomplete asset set never breaks a turn.
 */
export function assetPathFor(
  input: { characterId: string; outfit?: string | null; emotion?: string | null },
  catalog: Pick<PartyCatalog, 'outfits' | 'emotions'>,
): string | null {
  const { characterId } = input;
  const outfit = input.outfit ?? '';
  const emotion = input.emotion ?? '';
  if (!isSafeSegment(characterId) || !isSafeSegment(outfit)) return null;

  const outfits = catalog.outfits ?? [];
  if (!outfits.includes(outfit)) return null;

  const n = (catalog.emotions ?? {})[emotion];
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return null;

  return `/media/assets/${encodeURIComponent(characterId)}/${encodeURIComponent(outfit)}/${n}.webp`;
}

function pushNarration(texts: string[] | undefined, out: BeatBlock[]): void {
  for (const text of texts ?? []) {
    const t = text.trim();
    if (!t) continue;
    out.push({
      seq: out.length,
      kind: 'narration',
      speaker_character_id: null,
      speaker_name: null,
      text: t,
      asset_path: null,
      emotion: null,
      outfit: null,
    });
  }
}

function pushLine(line: BeatLine, out: BeatBlock[]): void {
  const text = line.text.trim();
  if (!text) return;
  out.push({
    seq: out.length,
    kind: 'line',
    speaker_character_id: line.character_id,
    speaker_name: line.name,
    text,
    asset_path: line.asset_path,
    emotion: line.emotion,
    outfit: line.outfit,
  });
}

/**
 * §6 렌더 스키마 직렬화:
 *   HEADER → NARRATION* → LINE(focus) → NARRATION* → THOUGHT → NARRATION*
 *          → LINE(extra)* → NARRATION* → UI
 *
 * Order is fixed here, by the server, from already-separated inputs. The model is
 * never asked to emit position markers, so a pass that returns nothing simply
 * contributes no block instead of desynchronising the layout.
 */
export function serializeBeat(input: BeatInput): BeatBlock[] {
  const out: BeatBlock[] = [];

  const header = (input.header ?? '').trim();
  if (header) {
    out.push({
      seq: 0,
      kind: 'header',
      speaker_character_id: null,
      speaker_name: null,
      text: header,
      asset_path: null,
      emotion: null,
      outfit: null,
    });
  }

  pushNarration(input.narration_open, out);
  if (input.focus_line) pushLine(input.focus_line, out);
  pushNarration(input.narration_after_line, out);

  const thought = input.thought;
  if (thought && thought.text.trim()) {
    out.push({
      seq: out.length,
      kind: 'thought',
      speaker_character_id: thought.character_id,
      speaker_name: thought.name,
      text: thought.text.trim(),
      asset_path: null,
      emotion: null,
      outfit: null,
    });
  }

  pushNarration(input.narration_after_thought, out);
  for (const line of input.extra_lines ?? []) pushLine(line, out);
  pushNarration(input.narration_close, out);

  if (input.ui) {
    out.push({
      seq: out.length,
      kind: 'ui',
      speaker_character_id: null,
      speaker_name: null,
      text: JSON.stringify(input.ui),
      asset_path: null,
      emotion: null,
      outfit: null,
    });
  }

  return out;
}
