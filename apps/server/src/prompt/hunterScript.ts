/**
 * hunter-format — Pass H (turn script + state) and its server-side parser.
 *
 * One call writes the turn, for the reason `dialogScript.ts` states: the beat's
 * N+F+E split exists so no single call writes two voices, and paying that in round
 * trips is only affordable when a turn is one voice plus narration. This transcript
 * is 83 narration blocks and 42 lines across 12 turns — narration-dominant, one
 * speaker in 11 of 12 turns — so the beat split would spend its budget on prose.
 *
 * The price of one call is paid on the way back, in two places:
 *
 *   - `parseHunterScript` — a `💬 이름│대사` line survives only if the name is on
 *     the server's allow-list. Anything else is demoted to narration, never
 *     dropped: deleting a sentence loses story, demoting it only loses attribution.
 *   - `parseHunterState` — the panel's written half (표정·감정·📍·💭·일정·상황)
 *     arrives as a fenced block, and every row is matched against the same
 *     allow-list, flattened to one line and capped. The model proposes; the server
 *     decides. Identity rows (🪪 ✨️ 💠 📚 💼 💰 ⏳️ 🎯) never come from here at all.
 *
 * A model that ignores the fence loses nothing but the panel's written half —
 * `renderHunterPanel` fills `-` and the turn still commits.
 *
 * Pure: no DB, no fetch, no model.
 */
import {
  FIELD_SEP, MODE_ICONS, NARRATION_CLOSE, NARRATION_OPEN, PANEL_LABEL,
  type HunterActor, type HunterScriptItem, type HunterState,
} from './renderHunter.js';
import { STORY_CHOICES_INSTRUCTION, substitute } from './templates.js';
import type { PassCard } from './passes.js';
import type { Scene } from '../types.js';

/** Prompt-stated caps. The parser enforces each again on the way back. */
export const PASS_H_MAX_LINES = 12;
export const PASS_H_MAX_NARRATION = 16;
export const PASS_H_MAX_SYSTEM = 6;

/** The fence Pass H closes with. Stripped before the script is parsed. */
export const STATE_OPEN = '<상태>';
export const STATE_CLOSE = '</상태>';

export type HunterSpeakerSlot = {
  id: string;
  name: string;
  aliases?: string[];
  card?: PassCard;
};

/**
 * Rows the server owns. A model that echoes the panel back gets those lines
 * discarded rather than rendered as prose — the panel has exactly one author.
 */
const PANEL_ROW = /^(?:INFO|⏳️|🪪|✨️|💠|📚\s*:|💼\s*:|💰\s*:|💭\s*:|🎯\s*퀘스트|📝\s*일정|📖\s*상황|\[💬\s*등장|\d{1,2}:\d{2}[│|])/u;

/**
 * Pass H — one turn: narration in `『』`, lines as `💬 이름│"대사"`, then the state
 * fence.
 *
 * The allow-list is printed as a closed list and inventing a name is forbidden in
 * its own rule; the `<choices>` contract showed a positive instruction alone lands
 * about 80% of the time, so the mitigations that matter are stated as prohibitions.
 */
export function renderPassH(input: {
  speakers: HunterSpeakerSlot[];
  scene: Scene;
  /** The identity half of the panel, already rendered. Context, not an output slot. */
  panel: string | null;
  userName: string;
  userText: string;
  ambientNames?: string[];
  contentPolicy?: string;
}): string {
  const names = input.speakers.map((s) => s.name);
  const ambient = (input.ambientNames ?? []).filter((n) => !names.includes(n));
  const policy = (input.contentPolicy ?? '').trim();
  const example = names[0] ?? '이름';

  const cards = input.speakers
    .filter((s) => s.card)
    .map((s) => {
      const c = s.card!;
      const parts = [`### ${c.name}`];
      const add = (label: string, v?: string | null) => {
        const t = (v ?? '').trim();
        if (t) parts.push(`${label}: ${t}`);
      };
      add('한 줄 소개', c.tagline);
      add('설명', c.description);
      add('성격', c.personality);
      add('말투', c.speech_style);
      add('금기(절대 하지 않는 것)', c.taboos);
      return parts.join('\n');
    });

  return [
    '너는 헌터물 RP의 서술자다. 아래 상황에서 이어지는 한 턴을 쓴다.',
    '',
    ...(cards.length ? ['## 등장인물', ...cards, ''] : []),
    '## 현재 상태 (서버가 확정했다. 그대로 다시 출력하지 말 것)',
    ...(input.panel ? [input.panel] : []),
    ...(input.scene.beat_goal ? [`- 이 턴이 끝나야 하는 것: ${input.scene.beat_goal}`] : []),
    '',
    `## ${input.userName}의 입력`,
    input.userText,
    '',
    '## 출력 형식',
    `- 서술은 \`${NARRATION_OPEN}\` 로 열고 \`${NARRATION_CLOSE}\` 로 닫는다. 문단 하나가 ${NARRATION_OPEN}${NARRATION_CLOSE} 하나다.`,
    `- 대사는 \`💬 이름${FIELD_SEP}"대사"\` 형식의 한 줄로 쓴다. 예: \`💬 ${example}${FIELD_SEP}"물러서라."\``,
    '- 시스템·기계 음성은 `[잠정 등급 측정을 시작합니다.]` 처럼 대괄호 한 줄로 쓴다. 필요할 때만.',
    '- 서술과 대사를 번갈아 쓴다. 한 인물이 여러 번 말해도 된다.',
    '',
    '## 규칙',
    `- **대사를 쓸 수 있는 인물은 다음뿐이다: ${names.join(', ') || '(없음)'}.** 이 목록 밖의 이름으로 대사 줄을 만들지 않는다.`,
    '- 새 인물의 이름을 지어내지 않는다.',
    ...(ambient.length
      ? [`- 다음 인물은 이 자리에 있지만 이번 턴에 말하지 않는다. 행동·표정 한 조각으로만 등장시킨다: ${ambient.join(', ')}.`]
      : []),
    `- ${input.userName}의 대사·행동·생각·감정을 만들어 내거나 확정하지 않는다. \`💬 ${input.userName}${FIELD_SEP}\` 로 시작하는 줄을 쓰지 않는다.`,
    `- 대사 줄은 모두 합쳐 ${PASS_H_MAX_LINES}줄을 넘기지 않는다.`,
    `- ${PANEL_LABEL} 패널(⏳️·🪪·✨️·💠·📚·💼·💰·🎯·📝·📖 줄)은 출력하지 않는다. 서버가 이 턴 끝에 붙인다.`,
    '- 장소·시각·소지품·소지금·등급을 새로 확정하지 않는다. 위 상태가 이 턴의 사실이다.',
    ...(policy ? [`- ${policy}`] : []),
    '- 한국어로 답한다.',
    '',
    '## 마지막에 붙일 상태 블록',
    `본문을 끝낸 뒤, 아래 형식 그대로 ${STATE_OPEN} … ${STATE_CLOSE} 를 한 번만 쓴다. 값이 없으면 그 줄을 생략한다.`,
    STATE_OPEN,
    `모드: ${MODE_ICONS.join(' 또는 ')} 중 하나`,
    '일정: 이번 턴 이후의 행동 흐름 한 줄 (예: 망자 고블린 제도 -> 원한의 근원 탐색)',
    '상황: 이번 턴에 실제로 벌어진 일 한 줄',
    `${example}${FIELD_SEP}표정 이모지 1개${FIELD_SEP}감정 두 단어${FIELD_SEP}그 인물이 있는 곳${FIELD_SEP}속마음 한 줄`,
    STATE_CLOSE,
    '',
    // 1:1 경로(`builder.ts`)와 같은 지시문, 같은 파서(`extractChoices`).
    substitute(STORY_CHOICES_INSTRUCTION, '', input.userName),
    '',
    '본문:',
  ].join('\n');
}

/** Strips the decorations a model puts around a speaker name: `**강다은**`, `강다은:` … */
function normalizeName(raw: string): string {
  return raw
    .replace(/^[\s>*_`\-–—]+|[\s*_`]+$/g, '')
    .replace(/^💬\s*/u, '')
    .replace(/[:：]\s*$/, '')
    .replace(/^\[|\]$/g, '')
    .trim();
}

/**
 * Fold width/case so `강다은` matches `강다은 `.
 * Deliberately a local copy of the dialog path's helper rather than an import:
 * the three output formats are siblings, and a shared private helper would make a
 * change to one of them silently change the others.
 */
function foldName(v: string): string {
  return v.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

function slotIndex(allowed: HunterSpeakerSlot[]): Map<string, HunterSpeakerSlot> {
  const byName = new Map<string, HunterSpeakerSlot>();
  for (const slot of allowed) {
    byName.set(foldName(slot.name), slot);
    for (const alias of slot.aliases ?? []) {
      const key = foldName(alias);
      if (key && !byName.has(key)) byName.set(key, slot);
    }
  }
  return byName;
}

/** Splits a row on `│` or an ASCII pipe — models substitute one for the other. */
function splitRow(line: string): string[] {
  return line.split(/[│|]/u).map((s) => s.trim());
}

export type ExtractedState = { content: string; state: string | null };

/**
 * Pulls the `<상태>` fence out before the script is parsed, so a name inside a
 * state row can never be read as a speaker line. Same shape as `extractChoices`.
 * An unclosed fence still yields its body — a truncated stream keeps its panel.
 */
export function extractHunterState(text: string): ExtractedState {
  const raw = text ?? '';
  const open = raw.indexOf(STATE_OPEN);
  if (open < 0) return { content: raw, state: null };

  const bodyStart = open + STATE_OPEN.length;
  const close = raw.indexOf(STATE_CLOSE, bodyStart);
  const body = close < 0 ? raw.slice(bodyStart) : raw.slice(bodyStart, close);
  const after = close < 0 ? '' : raw.slice(close + STATE_CLOSE.length);
  return { content: `${raw.slice(0, open)}${after}`, state: body };
}

export type ParseHunterStateResult = {
  state: HunterState;
  /** Names that claimed a panel row and were refused. Non-zero = the list worked. */
  rejected_names: string[];
};

/**
 * Parses the `<상태>` body against the allow-list.
 *
 * Labelled rows (`모드:` `일정:` `상황:`) set the turn's own fields; any other row
 * with a separator is read as an actor row, and only survives if its first field
 * names an approved character. Values are left as written and normalized later by
 * `renderHunterPanel` — one place owns flattening and capping, so a bench that
 * pins the panel's bytes pins them for every input path.
 */
export function parseHunterState(
  body: string | null,
  allowed: HunterSpeakerSlot[],
): ParseHunterStateResult {
  const state: HunterState = {};
  const rejected: string[] = [];
  if (!body) return { state, rejected_names: rejected };

  const byName = slotIndex(allowed);
  const actors: HunterActor[] = [];
  const seen = new Set<string>();

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === STATE_OPEN || line === STATE_CLOSE) continue;

    const labelled = /^(모드|분위기|일정|상황)\s*[:：]\s*(.*)$/u.exec(line);
    if (labelled) {
      const value = labelled[2].trim();
      if (!value) continue;
      if (labelled[1] === '모드' || labelled[1] === '분위기') {
        // Enum, not free text: the mark is the one panel field with a closed set.
        const hit = MODE_ICONS.find((icon) => value.includes(icon));
        if (hit) state.mode = hit;
      } else if (labelled[1] === '일정') {
        state.schedule = value;
      } else {
        state.situation = value;
      }
      continue;
    }

    const cells = splitRow(line);
    if (cells.length < 2) continue;

    const name = normalizeName(cells[0]);
    if (!name) continue;
    const slot = byName.get(foldName(name));
    if (!slot) {
      if (!rejected.includes(name)) rejected.push(name);
      continue;
    }
    if (seen.has(slot.id)) continue;
    seen.add(slot.id);

    actors.push({
      character_id: slot.id,
      emoji: cells[1] || undefined,
      mood: cells[2] || undefined,
      // `📍` is decoration in the panel, not data — strip it if the model copied it.
      place: (cells[3] ?? '').replace(/^📍\s*/u, '') || undefined,
      thought: (cells[4] ?? '').replace(/^💭\s*[:：]?\s*/u, '') || undefined,
    });
  }

  if (actors.length) state.actors = actors;
  return { state, rejected_names: rejected };
}

export type ParseHunterScriptResult = {
  items: HunterScriptItem[];
  /** Ids that actually got at least one line, in first-spoken order. */
  spoke_ids: string[];
  /** Names that looked like speakers but were not on the allow-list. */
  rejected_names: string[];
  /** Lines dropped because a per-turn cap was already reached. */
  dropped_lines: number;
  /** Panel rows the model wrote and the server discarded. */
  dropped_panel_rows: number;
};

/**
 * Parses Pass H output into an ordered script.
 *
 * Rules that matter, and why:
 *
 *   - A `💬 이름│대사` line whose name is not on the allow-list becomes narration,
 *     carrying its full original text.
 *   - A `『…』` paragraph is one narration item even when the model wraps it over
 *     several lines; consecutive bare lines merge into one paragraph, so a wrapped
 *     output does not become ten one-line blocks.
 *   - A line that is only `[…]` is the system voice, not prose.
 *   - Anything shaped like a panel row is discarded: the panel has one author and
 *     it is not the model.
 *   - Caps are enforced after the allow-list, so padding with rejected names cannot
 *     use up the budget.
 *
 * Never throws. Empty input yields an empty script, which the caller treats as a
 * failed pass — the same degradation Pass F and Pass S already have.
 */
export function parseHunterScript(
  text: string,
  allowed: HunterSpeakerSlot[],
): ParseHunterScriptResult {
  const items: HunterScriptItem[] = [];
  const spoke: string[] = [];
  const rejected: string[] = [];
  let dropped = 0;
  let droppedPanel = 0;
  let lineCount = 0;
  let narrationCount = 0;
  let systemCount = 0;

  const byName = slotIndex(allowed);

  let buf: string[] = [];
  const flush = () => {
    const t = buf.join('\n').trim();
    buf = [];
    if (!t) return;
    if (narrationCount >= PASS_H_MAX_NARRATION) {
      dropped++;
      return;
    }
    narrationCount++;
    items.push({ kind: 'narration', text: t });
  };

  // A `『` paragraph that has not closed yet. Everything joins it until `』`.
  let open: string[] | null = null;

  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.trim();

    if (open) {
      const end = line.indexOf(NARRATION_CLOSE);
      if (end < 0) {
        if (line) open.push(line);
        continue;
      }
      open.push(line.slice(0, end));
      const body = open.join(' ').trim();
      open = null;
      buf = [];
      if (body) {
        if (narrationCount >= PASS_H_MAX_NARRATION) dropped++;
        else { narrationCount++; items.push({ kind: 'narration', text: body }); }
      }
      continue;
    }

    if (!line) {
      // A blank line ends a paragraph but not the narration block; the join keeps
      // the break so multi-paragraph narration stays readable.
      if (buf.length && buf[buf.length - 1] !== '') buf.push('');
      continue;
    }

    if (PANEL_ROW.test(line)) {
      droppedPanel++;
      continue;
    }

    if (line.startsWith(NARRATION_OPEN)) {
      flush();
      const rest = line.slice(NARRATION_OPEN.length);
      const end = rest.indexOf(NARRATION_CLOSE);
      if (end < 0) {
        open = rest ? [rest] : [];
        continue;
      }
      const body = rest.slice(0, end).trim();
      if (body) {
        if (narrationCount >= PASS_H_MAX_NARRATION) dropped++;
        else { narrationCount++; items.push({ kind: 'narration', text: body }); }
      }
      continue;
    }

    const sys = /^\[([^\]]+)\]$/u.exec(line);
    if (sys && !line.includes(FIELD_SEP)) {
      flush();
      if (systemCount >= PASS_H_MAX_SYSTEM) dropped++;
      else { systemCount++; items.push({ kind: 'system', text: sys[1].trim() }); }
      continue;
    }

    const cut = line.search(/[│|]/u);
    if (cut <= 0) {
      buf.push(line);
      continue;
    }

    const name = normalizeName(line.slice(0, cut));
    const said = line.slice(cut + 1).trim();
    // A separator inside prose is not a speaker line: the left side has to be
    // short enough to be a name, and there has to be something said.
    if (!name || !said || name.length > 24) {
      buf.push(line);
      continue;
    }

    const slot = byName.get(foldName(name));
    if (!slot) {
      if (!rejected.includes(name)) rejected.push(name);
      buf.push(line);
      continue;
    }

    if (lineCount >= PASS_H_MAX_LINES) {
      dropped++;
      continue;
    }

    flush();
    items.push({ kind: 'line', character_id: slot.id, name: slot.name, text: said });
    lineCount++;
    if (!spoke.includes(slot.id)) spoke.push(slot.id);
  }

  if (open && open.length) {
    // An unterminated `『` is a truncated stream, not a lost paragraph.
    const body = open.join(' ').trim();
    if (body && narrationCount < PASS_H_MAX_NARRATION) items.push({ kind: 'narration', text: body });
  }
  flush();

  return {
    items,
    spoke_ids: spoke,
    rejected_names: rejected,
    dropped_lines: dropped,
    dropped_panel_rows: droppedPanel,
  };
}
