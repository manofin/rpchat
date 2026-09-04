/**
 * hunter-format — the Huntt.txt-class server template layer.
 *
 * A third output shape, sibling to `renderBeat.ts` (party beat) and
 * `renderDialog.ts` (Dialog.txt). The transcript this slice targets closes every
 * turn with a status panel and carries its prose as bracketed narration:
 *
 *   『당신은 쇄도하는 원한의 파도를 거스르는 바위처럼 …』
 *   💬 강다은│"황지명, 접근한다. 열두 개체."
 *   [가호 및 스킬 생성 완료]
 *
 *   INFO
 *
 *   ⏳️-11│1일차│🗓 26.03.02. 월
 *   10:55│오전│ ⚔️
 *
 *   🪪 황지명│남│무소속│📍미등록 D급 게이트 내부
 *   ✨️ 금강불괴│-│육체 강도·정신 내성 극대화
 *   💠 달마│골수 통찰·요마 제도의 가호
 *   📚: [나한복마인]
 *   💼: 헌터 신분증
 *   💰: 500,000원
 *
 *   [💬 등장 중 인물: 강다은]
 *   강다은│😳│경악·흥미│📍게이트 외부(통신)
 *   💭: 저것이... 제도? 파괴 없이 원한을...
 *
 *   🎯퀘스트: 게이트 내부의 '원한'을 제도하고 실력 증명하기
 *   📝일정: 망자 고블린 제도 -> 원한의 근원 탐색
 *   📖상황: 시무외인으로 망자들을 일시 정화함
 *
 * Two differences from the two shipped renderers, and both are deliberate:
 *
 * 1. The panel is the *last* block of a turn, not the first. That is where the
 *    transcript puts it, and it is also the only position that can be honest:
 *    `📖상황` describes the turn that just happened.
 * 2. The panel is not purely scene state. `renderBeat`/`renderDialog` can claim
 *    "nothing here reads model output" because their sheets carry only identity
 *    (who, where, how much money). This one also carries 감정·속마음·상황, which
 *    change every turn and are by definition written, not configured. So the split
 *    is drawn inside the panel instead of around it:
 *
 *      identity rows  (⏳️ 일차 🗓 🪪 ✨️ 💠 📚 💼 💰 🎯)  server, scene state only
 *      volatile rows  (⚔️ 표정·감정·📍·💭 📝 📖)          model-proposed, server-validated
 *
 *    The volatile half arrives as a `HunterState`, which `hunterScript.ts`
 *    produces from a fenced block and an allow-list — the model proposes, the
 *    server decides, exactly as `applySceneDelta` does. Nothing in this file
 *    trusts a name: an actor row is only rendered for a character the caller
 *    passed in `cast`, and every value is flattened to a single line so a
 *    model-written newline can never forge a row.
 *
 * Pure: no DB, no fetch, no model, no filesystem. Never throws on bad input.
 */
import type { BeatBlock, BeatCastMember, BeatLine } from './renderBeat.js';
import type { Scene } from '../types.js';

/** The value an empty row renders as. `-`, as the transcript prints it. */
export const HUNTER_EMPTY = '-';
/** Row field separator (U+2502), not an ASCII pipe. */
export const FIELD_SEP = '│';
/** Narration delimiters. */
export const NARRATION_OPEN = '『';
export const NARRATION_CLOSE = '』';
/** The panel's first line, and the marker the web keys its title off. */
export const PANEL_LABEL = 'INFO';

/**
 * The `💬`/`⚔️` mood mark on the clock row.
 *
 * A closed set on purpose: it is the one panel field the model may set that is
 * not free text, so an enum costs nothing and makes the allow-list checkable.
 */
export const MODE_ICONS = ['💬', '⚔️', '🔍', '🚨', '🌙'] as const;
export type ModeIcon = (typeof MODE_ICONS)[number];
export const DEFAULT_MODE: ModeIcon = '💬';

const MINUTES_PER_DAY = 1440;
/** Caps. A panel row is a row; a model that writes a paragraph gets it cut. */
const MAX_FIELD = 60;
const MAX_LONG_FIELD = 120;

/** Single-line, separator-free, capped. Every value in the panel goes through this. */
function field(v: unknown, max = MAX_FIELD): string {
  if (typeof v !== 'string') return '';
  const flat = v.replace(/[\r\n\t]+/g, ' ').split(FIELD_SEP).join('/').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) : flat;
}

function or(v: string, fallback = HUNTER_EMPTY): string {
  return v || fallback;
}

/** `10:55` — 24h, same clock the beat header prints. */
function clockLabel(minutes: number): string {
  const m = ((Math.trunc(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** `500,000원`. Thousands separator, as the transcript prints it. */
function moneyLabel(v: number): string {
  return `${Math.trunc(v).toLocaleString('ko-KR')}원`;
}

/** One character's two rows in the `등장 중 인물` section. */
export type HunterActor = {
  character_id: string;
  /** `😳` — the emotion mark. */
  emoji?: string;
  /** `경악·흥미` */
  mood?: string;
  /** `게이트 외부(통신)` — where *they* are, which need not be the scene's place. */
  place?: string;
  /** `저것이... 제도?` — the 💭 row. */
  thought?: string;
};

/**
 * The half of the panel the model writes.
 *
 * Every field is optional; a turn where the model wrote no state block still
 * renders a complete panel from scene state, with `-` where the writing would
 * have gone. That is the degradation this format needs — a missing 속마음 is a
 * thinner panel, never a failed turn.
 */
export type HunterState = {
  mode?: ModeIcon | string;
  /** `📝일정` */
  schedule?: string;
  /** `📖상황` */
  situation?: string;
  actors?: HunterActor[];
};

export type HunterPanelInput = {
  scene: Scene;
  cast: BeatCastMember[];
  /** The protagonist's name on the 🪪 row. Persona name, never a model's guess. */
  userName: string;
  state?: HunterState | null;
};

/** `⏳️-11│1일차│🗓 26.03.02. 월` */
export function renderTurnRow(scene: Scene): string {
  const parts: string[] = [];
  const turn = typeof scene.turn_no === 'number' && Number.isFinite(scene.turn_no)
    ? Math.trunc(scene.turn_no)
    : 0;
  parts.push(`⏳️-${turn}`);

  if (typeof scene.day_index === 'number' && Number.isFinite(scene.day_index)) {
    parts.push(`${Math.trunc(scene.day_index)}일차`);
  }

  // 🗓 is a written date (`26.03.02.`), not one the server computes: the scene has
  // no epoch, and `advance_minutes` may roll a day without the world's calendar
  // agreeing. The weekday is the beat path's own `scene.weekday`, reused.
  const date = field(scene.hunter?.date, 30);
  const weekday = field(scene.weekday, 10);
  const stamp = [date, weekday].filter(Boolean).join(' ');
  if (stamp) parts.push(`🗓 ${stamp}`);

  return parts.join(FIELD_SEP);
}

/** `10:55│오전│ ⚔️` — note the space before the mark, as the transcript has it. */
export function renderClockRow(scene: Scene, state?: HunterState | null): string {
  const minutes = typeof scene.clock_minutes === 'number' && Number.isFinite(scene.clock_minutes)
    ? ((Math.trunc(scene.clock_minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
    : null;
  const clock = minutes === null ? HUNTER_EMPTY : clockLabel(minutes);
  const half = minutes === null ? HUNTER_EMPTY : (minutes < 720 ? '오전' : '오후');

  const proposed = field(state?.mode, 4);
  const mode = (MODE_ICONS as readonly string[]).includes(proposed)
    ? proposed
    : (MODE_ICONS as readonly string[]).includes(field(scene.hunter?.mode, 4))
      ? field(scene.hunter?.mode, 4)
      : DEFAULT_MODE;

  return `${clock}${FIELD_SEP}${half}${FIELD_SEP} ${mode}`;
}

/** The six 🪪…💰 rows. Fixed set, `-` filled — the transcript never drops one. */
export function renderSheetRows(input: HunterPanelInput): string[] {
  const { scene } = input;
  const h = scene.hunter ?? {};
  const sheet = scene.user_sheet ?? {};

  const name = or(field(input.userName, 40), '나');
  const idRow = [name, or(field(h.gender, 10)), or(field(h.affiliation, 30)), `📍${or(field(scene.location) || field(scene.place))}`];

  const trait = h.trait ?? {};
  const traitRow = [or(field(trait.name, 30)), or(field(trait.grade, 20)), or(field(trait.note, MAX_LONG_FIELD))];

  const patron = h.patron ?? {};
  const patronRow = [or(field(patron.name, 30)), or(field(patron.note, MAX_LONG_FIELD))];

  const skills = (h.skills ?? []).map((s) => field(s, 40)).filter(Boolean).map((s) => `[${s}]`);
  const items = (sheet.inventory ?? []).map((s) => field(s, 40)).filter(Boolean);
  const money = typeof sheet.money === 'number' && Number.isFinite(sheet.money)
    ? moneyLabel(sheet.money)
    : HUNTER_EMPTY;

  return [
    `🪪 ${idRow.join(FIELD_SEP)}`,
    `✨️ ${traitRow.join(FIELD_SEP)}`,
    `💠 ${patronRow.join(FIELD_SEP)}`,
    `📚: ${skills.length ? skills.join(', ') : HUNTER_EMPTY}`,
    `💼: ${items.length ? items.join(', ') : HUNTER_EMPTY}`,
    `💰: ${money}`,
  ];
}

/**
 * `[💬 등장 중 인물: …]` and each present character's two rows.
 *
 * Presence is the scene's occupancy list, exactly as the other two renderers read
 * it. A `HunterState` actor whose id is not in that list contributes nothing —
 * the model cannot put someone in the room by writing their name in a panel row.
 * Returns `[]` when the room is empty, which drops the whole section rather than
 * printing an empty header.
 */
export function renderCastRows(input: HunterPanelInput): string[] {
  const present = Array.isArray(input.scene.present_ids) ? input.scene.present_ids : [];
  const roster = input.scene.roster ?? {};
  const byId = new Map((input.state?.actors ?? []).map((a) => [a.character_id, a]));

  const members = input.cast.filter((m) => present.includes(m.id));
  if (!members.length) return [];

  const rows = [`[💬 등장 중 인물: ${members.map((m) => m.name).join(', ')}]`];
  for (const m of members) {
    const a = byId.get(m.id);
    const emoji = or(field(a?.emoji, 4) || field(roster[m.id]?.emotion, 4));
    const mood = or(field(a?.mood, 30));
    const place = or(field(a?.place, 40) || field(input.scene.location) || field(input.scene.place));
    rows.push(`${m.name}${FIELD_SEP}${emoji}${FIELD_SEP}${mood}${FIELD_SEP}📍${place}`);
    rows.push(`💭: ${or(field(a?.thought, MAX_LONG_FIELD))}`);
  }
  return rows;
}

/**
 * `🎯퀘스트` · `📝일정` · `📖상황`.
 *
 * 퀘스트 is scene state — it survives turns and the user owns it. 일정 and 상황 are
 * the turn's own summary, so the model's proposal wins and the scene value is the
 * fallback for a turn that proposed none.
 */
export function renderQuestRows(input: HunterPanelInput): string[] {
  const h = input.scene.hunter ?? {};
  const st = input.state ?? {};
  return [
    `🎯퀘스트: ${or(field(h.quest, MAX_LONG_FIELD))}`,
    `📝일정: ${or(field(st.schedule, MAX_LONG_FIELD) || field(h.schedule, MAX_LONG_FIELD))}`,
    `📖상황: ${or(field(st.situation, MAX_LONG_FIELD) || field(h.situation, MAX_LONG_FIELD))}`,
  ];
}

/** The whole panel, exactly as the transcript prints it. */
export function renderHunterPanel(input: HunterPanelInput): string {
  const groups: string[][] = [
    [PANEL_LABEL],
    [renderTurnRow(input.scene), renderClockRow(input.scene, input.state)],
    renderSheetRows(input),
    renderCastRows(input),
    renderQuestRows(input),
  ];
  return groups.filter((g) => g.length).map((g) => g.join('\n')).join('\n\n');
}

/**
 * A script item. `system` is the bracketed machine voice the transcript uses for
 * 측정기·시스템 알림 (`[가호 및 스킬 생성 완료]`) — narration would flatten it into
 * prose and a line would hand it to a character who did not say it.
 */
export type HunterScriptItem =
  | { kind: 'narration'; text: string }
  | { kind: 'system'; text: string }
  | { kind: 'line'; character_id: string; name: string; text: string };

export type HunterBeatInput = {
  script: HunterScriptItem[];
  panel: string | null;
  /** Portrait/emotion lookup for a speaker, or null. Same contract as BeatLine. */
  lineMeta?: (characterId: string) => Pick<BeatLine, 'asset_path' | 'emotion' | 'outfit'>;
};

const NO_META = { asset_path: null, emotion: null, outfit: null };

/**
 * hunter 직렬화: (NARRATION | SYSTEM | LINE)* → PANEL.
 *
 * Script order is the parser's order — no slot table, no reordering — and the
 * panel is appended last. `seq` is assigned here so `chat.ts` appends in exactly
 * this order and the client never sorts (the `beat_seq` invariant, unchanged).
 *
 * Narration is stored wrapped in `『』`. The parser strips whatever brackets the
 * model wrote before handing text over, so the wrap happens exactly once and a
 * stored block is the transcript's own line, re-readable as context next turn.
 */
export function serializeHunterBeat(input: HunterBeatInput): BeatBlock[] {
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

  for (const item of input.script) {
    if (item.kind === 'narration') {
      const body = item.text.trim();
      if (body) push('narration', `${NARRATION_OPEN}${body}${NARRATION_CLOSE}`, null, NO_META);
    } else if (item.kind === 'system') {
      const body = item.text.trim();
      if (body) push('system', `[${body}]`, null, NO_META);
    } else {
      push('line', item.text, { id: item.character_id, name: item.name }, meta(item.character_id));
    }
  }

  const panel = (input.panel ?? '').trim();
  if (panel) push('panel', panel, null, NO_META);

  return out;
}
