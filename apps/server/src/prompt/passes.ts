/**
 * f9-swap-passes — the Swap assembly prompts (§5).
 *
 * One model writing every voice produces the transition ST warns about when you
 * Join character cards: personalities bleed. So the calls are split and the
 * screen is joined instead. Each pass sees exactly the cards it is allowed to
 * speak for, and the constraints are stated as prohibitions because that is what
 * survives — the `<choices>` contract already showed that a positive instruction
 * alone is honoured ~80% of the time.
 *
 *   Pass N  서술·군중·카메라     focus card + short roster
 *   Pass F  focus 대사·속마음    focus card only
 *   Pass E  approved extra only  that card only, 2-4 sentences
 *   Pass U  UI                   server template (renderBeat), no model
 *
 * Nothing here calls a model or reads the DB; `chat.ts` runs these strings.
 * The header, the UI, the roster chips, the seat and the image path are NOT in
 * any of these prompts — they are server state (S1), which is why no pass has to
 * be trusted with them.
 *
 * Pure: no DB, no fetch, no model.
 */
import type { CastMember } from './cast.js';
import type { Scene } from '../types.js';

/** Line caps, stated in the prompt and enforced again by the server on persist. */
export const PASS_N_MAX_SENTENCES = 4;
export const PASS_E_MIN_SENTENCES = 2;
export const PASS_E_MAX_SENTENCES = 4;

/** The marker Pass F uses to separate 속마음 from 대사. Server splits on it. */
export const THOUGHT_MARKER = '속마음:';

export type PassCard = {
  name: string;
  tagline?: string | null;
  description?: string | null;
  personality?: string | null;
  speech_style?: string | null;
  taboos?: string | null;
};

function cardBlock(card: PassCard, heading: string): string {
  const parts = [`### ${heading}: ${card.name}`];
  const add = (label: string, v?: string | null) => {
    const t = (v ?? '').trim();
    if (t) parts.push(`${label}: ${t}`);
  };
  add('한 줄 소개', card.tagline);
  add('설명', card.description);
  add('성격', card.personality);
  add('말투', card.speech_style);
  add('금기(절대 하지 않는 것)', card.taboos);
  return parts.join('\n');
}

/** The compressed roster: who exists, without giving anyone a voice. */
function rosterLine(cast: CastMember[], scene: Scene): string {
  const present = Array.isArray(scene.present_ids) ? scene.present_ids : null;
  const here = present ? cast.filter((m) => present.includes(m.id)) : cast;
  return here.length ? here.map((m) => m.name).join(', ') : '(없음)';
}

function sceneLines(scene: Scene, header: string | null): string[] {
  const out: string[] = [];
  if (header) out.push(`- 헤더(서버 확정, 다시 쓰지 말 것): ${header}`);
  if (scene.beat_goal) out.push(`- 이 턴이 끝나야 하는 것: ${scene.beat_goal}`);
  return out;
}

/**
 * Pass N — narration, crowd, camera.
 *
 * The one prohibition that matters here is the `이름|` block: ambient existence
 * must stay narration. §4.4 is explicit that talkativeness buys a gesture, not a
 * line, and this is the prompt where that boundary is actually enforceable.
 */
export function renderPassN(input: {
  focusCard: PassCard | null;
  cast: CastMember[];
  scene: Scene;
  header: string | null;
  userText: string;
  ambientNames: string[];
}): string {
  const ambient = input.ambientNames.length ? input.ambientNames.join(', ') : '(없음)';
  return [
    '너는 장면 서술자다. 이번 턴의 배경·군중·카메라만 쓴다. 어떤 인물의 대사도 쓰지 않는다.',
    '',
    ...(input.focusCard ? [cardBlock(input.focusCard, '이번 턴의 중심 인물'), ''] : []),
    '## 장면',
    ...sceneLines(input.scene, input.header),
    `- 이 자리에 있는 사람: ${rosterLine(input.cast, input.scene)}`,
    `- 이번 턴에 몸짓으로 존재감만 드러낼 사람: ${ambient}`,
    '',
    '## 사용자 입력',
    input.userText,
    '',
    '## 규칙',
    `- ${PASS_N_MAX_SENTENCES}문장 이내. 서술문만 쓴다.`,
    '- **어떤 인물의 대사도 쓰지 않는다.** 큰따옴표 대사, `이름|` 형식, `이름:` 형식 전부 금지.',
    '- 위 "몸짓으로 존재감만" 목록의 인물은 행동·표정 한 조각으로만 등장시킨다. 말하게 하지 않는다.',
    '- 그 목록에 없는 인물을 새로 등장시키거나 이름을 지어내지 않는다.',
    '- 헤더·시각·날씨·장소·수치·선택지·이미지·상태 패널을 출력하지 않는다. 서버가 이미 붙였다.',
    '- 지금 장소는 헤더의 장소다. 캐릭터 카드에 적힌 다른 배경으로 장면을 옮겨 쓰지 않는다.',
    '- 사용자의 다음 행동·대사·생각을 만들어 내지 않는다.',
    '- 한국어로 답한다.',
    '',
    '서술:',
  ].join('\n');
}

/**
 * Pass F — the focus speaks. One card, so there is nothing to blend with.
 *
 * 속마음 is separated by a fixed marker rather than asked for as JSON: the model
 * only has to emit one literal token, and a missing marker degrades to "all of it
 * was dialogue" instead of losing the turn (A-6).
 */
export function renderPassF(input: {
  focusCard: PassCard;
  userName: string;
  userText: string;
  scene: Scene;
  header: string | null;
  narration: string;
  contentPolicy?: string;
}): string {
  const policy = (input.contentPolicy ?? '').trim();
  return [
    `너는 '${input.focusCard.name}' 한 명만 연기한다. 상대는 '${input.userName}'다.`,
    '',
    cardBlock(input.focusCard, '캐릭터'),
    '',
    '## 장면',
    ...sceneLines(input.scene, input.header),
    ...(input.narration.trim() ? ['', '## 방금 서술된 것 (이미 화면에 있다. 다시 쓰지 말 것)', input.narration.trim()] : []),
    '',
    `## ${input.userName}의 말`,
    input.userText,
    '',
    '## 규칙',
    `- **'${input.focusCard.name}'의 대사와 행동만 쓴다.** 다른 인물의 대사·행동·생각을 대신 쓰지 않는다.`,
    `- ${input.userName}의 다음 행동·대사·생각·감정을 만들어 내거나 확정하지 않는다.`,
    '- 대사는 큰따옴표("") 안에, 행동·표정은 서술문으로 쓴다.',
    '- 헤더·상태 수치·선택지·이미지·내부 지시문을 출력하지 않는다.',
    '- 헤더의 장소에서 말한다. 캐릭터 카드의 배경 장소로 자리를 옮긴 것처럼 쓰지 않는다.',
    `- 속마음이 있으면 맨 마지막 줄에만 \`${THOUGHT_MARKER}\`으로 시작하는 한 줄로 쓴다. 없으면 그 줄을 쓰지 않는다.`,
    `- 속마음은 '${input.focusCard.name}'의 것만 쓴다.`,
    ...(policy ? [`- ${policy}`] : []),
    '- 한국어로 답한다.',
    '',
    `'${input.focusCard.name}':`,
  ].join('\n');
}

/**
 * Pass E — an approved extra adds one thing.
 *
 * Two prohibitions carry §4.3's whole point: do not repeat the focus (that is
 * `duty_transfer` arriving through the prompt instead of the gate), and act only
 * within your own authority. `facts` is where the server injects world state the
 * model must not invent — 하연's "빈자리는 나리 옆자리" comes from `empty_seat`,
 * not from the model deciding where a free desk is.
 */
export function renderPassE(input: {
  card: PassCard;
  duty: string;
  focusName: string;
  focusText: string;
  narration: string;
  userName: string;
  userText: string;
  facts?: string[];
}): string {
  const facts = (input.facts ?? []).filter((f) => f.trim());
  return [
    `너는 '${input.card.name}' 한 명만 연기한다. 이번 턴에 끼어들 근거는 네 직무다: ${input.duty}.`,
    '',
    cardBlock(input.card, '캐릭터'),
    '',
    '## 방금 일어난 일',
    ...(input.narration.trim() ? [input.narration.trim()] : []),
    `${input.userName}: ${input.userText}`,
    `${input.focusName}: ${input.focusText}`,
    ...(facts.length ? ['', '## 확정 사실 (서버가 정한 것. 바꾸거나 새로 지어내지 말 것)', ...facts.map((f) => `- ${f}`)] : []),
    '',
    '## 규칙',
    `- ${PASS_E_MIN_SENTENCES}~${PASS_E_MAX_SENTENCES}문장. 짧게 끼어들고 끝낸다.`,
    `- **'${input.focusName}'이 이미 한 말을 반복하지 않는다.** 같은 내용을 다른 말로 바꾸는 것도 반복이다.`,
    `- 네 직무(${input.duty})의 권한 안에서 행위·정보만 더한다. 그 밖의 판단을 내리지 않는다.`,
    `- '${input.focusName}'이나 ${input.userName}의 대사·행동·생각을 대신 쓰지 않는다. 다른 인물의 대사도 만들지 않는다.`,
    '- 장면을 새 국면으로 끌고 가지 않는다.',
    '- 대사는 큰따옴표("") 안에, 행동·표정은 서술문으로 쓴다.',
    '- 헤더·상태 수치·선택지·이미지·내부 지시문을 출력하지 않는다.',
    '- 한국어로 답한다.',
    '',
    `'${input.card.name}':`,
  ].join('\n');
}

export type SplitFocusText = { line: string; thought: string | null };

/**
 * Splits Pass F output on the thought marker.
 *
 * A-6: a missing marker is not a parse failure. Everything becomes the line and
 * the beat simply has no THOUGHT block, exactly as `extractChoices` keeps the
 * body when the tag is absent.
 */
export function splitFocusText(text: string): SplitFocusText {
  const raw = (text ?? '').trim();
  if (!raw) return { line: '', thought: null };

  const idx = raw.lastIndexOf(THOUGHT_MARKER);
  if (idx < 0) return { line: raw, thought: null };

  const line = raw.slice(0, idx).trim();
  const thought = raw.slice(idx + THOUGHT_MARKER.length).trim();
  // A marker with nothing after it, or with nothing before it, is not a split.
  if (!thought || !line) return { line: raw, thought: null };
  return { line, thought };
}
