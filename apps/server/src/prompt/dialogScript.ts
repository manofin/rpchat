/**
 * dialog-format — Pass S (script) and its server-side parser.
 *
 * The shipped beat splits one turn into Pass N (narration) + Pass F (focus) +
 * Pass E (one call per extra) precisely so that no single call writes two voices.
 * The transcript this slice targets cannot be built that way: T-1 has 설록 speaking
 * four times and 낯선 여자 three, interleaved with narration, and reproducing that
 * with per-speaker calls costs seven round trips against a p95 that is already
 * 13.58s (STATUS F9 봉인 수치).
 *
 * So the trade is made explicitly, and paid for on the server side instead:
 *
 *   - One call writes the script.  (cheaper than the 4-call mix it replaces)
 *   - The server owns who may appear in it.
 *
 * `parseScript` is that second half. A `이름 | 대사` line survives only if the name
 * resolves to a character the server already approved for this turn; anything else
 * is demoted to narration rather than dropped, because deleting a sentence loses
 * story while demoting it only loses attribution. That is the same shape as
 * `applySceneDelta`: the model proposes, the allow-list decides.
 *
 * Pure: no DB, no fetch, no model.
 */
import { SPEAKER_SEP, type ScriptItem } from './renderDialog.js';
import type { PassCard } from './passes.js';
import type { CastMember } from './cast.js';
import type { Scene } from '../types.js';

/** Prompt-stated cap. `parseScript` enforces it again on the way back. */
export const PASS_S_MAX_LINES = 12;

export type SpeakerSlot = {
  id: string;
  name: string;
  aliases?: string[];
  card?: PassCard;
};

/**
 * Pass S — the whole turn's script, from the cast the server has already chosen.
 *
 * Every card that may speak is included, which is the context-bleed risk ST warns
 * about. The mitigations that actually hold in practice are stated as prohibitions
 * (the `<choices>` contract showed a positive instruction alone lands ~80% of the
 * time): the allow-list is printed as a closed list, inventing a name is forbidden
 * in its own rule, and the user's voice is fenced off separately from the cast's.
 */
export function renderPassS(input: {
  speakers: SpeakerSlot[];
  cast: CastMember[];
  scene: Scene;
  header: string | null;
  info: string | null;
  userName: string;
  userText: string;
  ambientNames?: string[];
  contentPolicy?: string;
}): string {
  const names = input.speakers.map((s) => s.name);
  const ambient = (input.ambientNames ?? []).filter((n) => !names.includes(n));
  const policy = (input.contentPolicy ?? '').trim();

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
    '너는 이 장면의 서술자다. 아래 인물들이 등장하는 한 장면을 대본으로 쓴다.',
    '',
    ...(cards.length ? ['## 등장인물', ...cards, ''] : []),
    '## 장면 (서버가 확정했다. 다시 출력하지 말 것)',
    ...(input.header ? [input.header] : []),
    ...(input.info ? [input.info] : []),
    ...(input.scene.beat_goal ? [`- 이 턴이 끝나야 하는 것: ${input.scene.beat_goal}`] : []),
    '',
    `## ${input.userName}의 입력`,
    input.userText,
    '',
    '## 출력 형식',
    '- 서술은 그냥 문단으로 쓴다.',
    `- 대사는 반드시 \`이름${SPEAKER_SEP}대사\` 형식의 한 줄로 쓴다. 예: \`${names[0] ?? '이름'}${SPEAKER_SEP}그래서, 어떻게 할 거야?\``,
    '- 서술과 대사를 번갈아 쓴다. 한 인물이 여러 번 말해도 된다.',
    '',
    '## 규칙',
    `- **대사를 쓸 수 있는 인물은 다음뿐이다: ${names.join(', ') || '(없음)'}.** 이 목록 밖의 이름으로 대사 줄을 만들지 않는다.`,
    '- 새 인물의 이름을 지어내지 않는다.',
    ...(ambient.length
      ? [`- 다음 인물은 이 자리에 있지만 이번 턴에 말하지 않는다. 행동·표정 한 조각으로만 등장시킨다: ${ambient.join(', ')}.`]
      : []),
    `- ${input.userName}의 대사·행동·생각·감정을 만들어 내거나 확정하지 않는다. \`${input.userName}${SPEAKER_SEP}\` 로 시작하는 줄을 쓰지 않는다.`,
    `- 대사 줄은 모두 합쳐 ${PASS_S_MAX_LINES}줄을 넘기지 않는다.`,
    '- 헤더·INFO·상태 수치·선택지·이미지·내부 지시문을 출력하지 않는다. 서버가 이미 붙였다.',
    '- 장소는 위 헤더의 장소다. 캐릭터 카드에 적힌 다른 배경으로 장면을 옮기지 않는다.',
    '- 시각·날씨·소지품·수치를 새로 확정하지 않는다.',
    ...(policy ? [`- ${policy}`] : []),
    '- 한국어로 답한다.',
    '',
    '대본:',
  ].join('\n');
}

/** Strips the decorations a model puts around a speaker name: `**설록**`, `설록:` … */
function normalizeName(raw: string): string {
  return raw
    .replace(/^[\s>*_`\-–—]+|[\s*_`]+$/g, '')
    .replace(/[:：]\s*$/, '')
    .replace(/^\[|\]$/g, '')
    .trim();
}

/** Fold width/case so `유키` matches `유키 ` and `Yuki` matches `yuki`. */
function foldName(v: string): string {
  return v.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

export type ParseScriptResult = {
  items: ScriptItem[];
  /** Ids that actually got at least one line, in first-spoken order. */
  spoke_ids: string[];
  /** Names that looked like speakers but were not on the allow-list. */
  rejected_names: string[];
  /** Lines dropped because the per-turn line cap was already reached. */
  dropped_lines: number;
};

/**
 * Parses Pass S output into an ordered script.
 *
 * Rules that matter, and why:
 *
 *   - A `이름 | 대사` line whose name is not on the allow-list becomes narration,
 *     carrying its full original text. The scene keeps the sentence; the model
 *     does not get to hand someone a voice the server did not approve.
 *   - Consecutive narration lines are merged into one paragraph, so a wrapped
 *     model output does not turn into ten one-line blocks.
 *   - The line cap is enforced after the allow-list, so a model that pads with
 *     rejected names cannot use up the budget.
 *
 * Never throws. Empty input yields an empty script, which the caller treats as a
 * failed pass — the same degradation Pass F already has.
 */
export function parseScript(text: string, allowed: SpeakerSlot[]): ParseScriptResult {
  const items: ScriptItem[] = [];
  const spoke: string[] = [];
  const rejected: string[] = [];
  let dropped = 0;
  let lineCount = 0;

  const byName = new Map<string, SpeakerSlot>();
  for (const slot of allowed) {
    byName.set(foldName(slot.name), slot);
    for (const alias of slot.aliases ?? []) {
      const key = foldName(alias);
      if (key && !byName.has(key)) byName.set(key, slot);
    }
  }

  // Narration accumulates until a line block interrupts it.
  let buf: string[] = [];
  const flush = () => {
    const t = buf.join('\n').trim();
    buf = [];
    if (t) items.push({ kind: 'narration', text: t });
  };

  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      // A blank line ends a paragraph but does not end the narration block; the
      // join above keeps the break so multi-paragraph narration stays readable.
      if (buf.length && buf[buf.length - 1] !== '') buf.push('');
      continue;
    }

    const sep = line.indexOf('|');
    if (sep <= 0) {
      buf.push(line);
      continue;
    }

    const name = normalizeName(line.slice(0, sep));
    const said = line.slice(sep + 1).trim();
    // A pipe inside prose ("A | B 구간") is not a speaker line: the left side has
    // to be short enough to be a name, and there has to be something said.
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

    if (lineCount >= PASS_S_MAX_LINES) {
      dropped++;
      continue;
    }

    flush();
    items.push({ kind: 'line', character_id: slot.id, name: slot.name, text: said });
    lineCount++;
    if (!spoke.includes(slot.id)) spoke.push(slot.id);
  }
  flush();

  return { items, spoke_ids: spoke, rejected_names: rejected, dropped_lines: dropped };
}
