/**
 * npx tsx bench/hunterScript.test.ts
 * hunter-format S-B — Pass H prompt + the server-side script/state parsers.
 * The point of this file is the allow-list: a `💬 이름│대사` line only survives if
 * the server already approved that speaker. Script samples follow Huntt.txt.
 * Isolated: no systemd, no live DB, no model call, no migration, no live generate.
 */
import assert from 'node:assert/strict';
import {
  PASS_H_MAX_LINES, PASS_H_MAX_NARRATION, PASS_H_MAX_SYSTEM,
  STATE_CLOSE, STATE_OPEN, extractHunterState, parseHunterScript, parseHunterState,
  renderPassH, type HunterSpeakerSlot,
} from '../apps/server/src/prompt/hunterScript.ts';
import { FIELD_SEP, MODE_ICONS, NARRATION_CLOSE, NARRATION_OPEN } from '../apps/server/src/prompt/renderHunter.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const DAEUN: HunterSpeakerSlot = { id: 'daeun', name: '강다은', aliases: ['다은'] };
const ALLOWED = [DAEUN];

t('a line whose speaker is on the allow-list becomes a line block', () => {
  const r = parseHunterScript(`💬 강다은${FIELD_SEP}(통신) "접근한다."`, ALLOWED);
  assert.deepEqual(r.items, [{
    kind: 'line', character_id: 'daeun', name: '강다은', text: '(통신) "접근한다."',
  }]);
  assert.deepEqual(r.spoke_ids, ['daeun']);
  assert.deepEqual(r.rejected_names, []);
});

t('an ASCII pipe is accepted as the field separator', () => {
  const r = parseHunterScript('💬 강다은|"물러서라."', ALLOWED);
  assert.equal(r.items[0].kind, 'line');
});

t('a speaker the server never approved is demoted to narration, not dropped', () => {
  const r = parseHunterScript(`💬 설록${FIELD_SEP}"네 이름을 줘."`, ALLOWED);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].kind, 'narration');
  assert.ok((r.items[0] as { text: string }).text.includes('네 이름을 줘'));
  assert.deepEqual(r.rejected_names, ['설록']);
  assert.deepEqual(r.spoke_ids, []);
});

t('an alias resolves to the canonical id and canonical display name', () => {
  const r = parseHunterScript(`💬 다은${FIELD_SEP}" rec."`, ALLOWED);
  assert.equal(r.items[0].kind, 'line');
  assert.equal((r.items[0] as { name: string }).name, '강다은');
  assert.equal((r.items[0] as { character_id: string }).character_id, 'daeun');
});

t('a decorated speaker name still resolves', () => {
  assert.equal(parseHunterScript(`**강다은**${FIELD_SEP}닥쳐.`, ALLOWED).items[0].kind, 'line');
  assert.equal(parseHunterScript(`- 강다은${FIELD_SEP}닥쳐.`, ALLOWED).items[0].kind, 'line');
});

t('name matching folds width and case but is never a substring match', () => {
  assert.equal(parseHunterScript(`강다은  ${FIELD_SEP}응.`, ALLOWED).items[0].kind, 'line');
  assert.equal(parseHunterScript(`강다은이${FIELD_SEP}응.`, ALLOWED).items[0].kind, 'narration');
});

t('『』 paragraphs are one narration item, even when wrapped', () => {
  const r = parseHunterScript(
    `${NARRATION_OPEN}첫째 줄\n둘째 줄${NARRATION_CLOSE}\n다음 문단.`,
    ALLOWED,
  );
  assert.equal(r.items[0].kind, 'narration');
  assert.equal((r.items[0] as { text: string }).text, '첫째 줄 둘째 줄');
  assert.equal(r.items[1].kind, 'narration');
});

t('an unterminated 『 is kept as narration, not dropped', () => {
  const r = parseHunterScript(`${NARRATION_OPEN}잘린 문단`, ALLOWED);
  assert.equal(r.items.length, 1);
  assert.equal((r.items[0] as { text: string }).text, '잘린 문단');
});

t('a [bracket] line is the system voice', () => {
  const r = parseHunterScript('[가호 및 스킬 생성 완료]', ALLOWED);
  assert.deepEqual(r.items, [{ kind: 'system', text: '가호 및 스킬 생성 완료' }]);
});

t('panel rows the model echoed are discarded, not narrated', () => {
  const echoed = [
    'INFO',
    '⏳️-11│1일차│🗓 26.03.02. 월',
    '10:55│오전│ ⚔️',
    '🪪 황지명│남│무소속│📍게이트',
    '🎯퀘스트: 위조',
    '[💬 등장 중 인물: 강다은]',
    '💭: 훔친 속마음',
  ].join('\n');
  const r = parseHunterScript(echoed, ALLOWED);
  assert.equal(r.items.length, 0);
  assert.ok(r.dropped_panel_rows >= 6);
});

t('narration and lines interleave in written order, speakers repeating', () => {
  const script = [
    `${NARRATION_OPEN}강다은의 미간이 좁아졌다.${NARRATION_CLOSE}`,
    `💬 강다은${FIELD_SEP}"접근한다."`,
    `${NARRATION_OPEN}짧은 침묵.${NARRATION_CLOSE}`,
    `💬 강다은${FIELD_SEP}"열두 개체."`,
  ].join('\n');
  const r = parseHunterScript(script, ALLOWED);
  assert.deepEqual(r.items.map((i) => i.kind), ['narration', 'line', 'narration', 'line']);
});

t('the line cap is enforced after the allow-list, so padding cannot spend it', () => {
  const pad = Array.from({ length: 5 }, () => `💬 설록${FIELD_SEP}"패딩."`).join('\n');
  const real = Array.from({ length: PASS_H_MAX_LINES + 3 }, (_, i) => `💬 강다은${FIELD_SEP}"줄 ${i}"`).join('\n');
  const r = parseHunterScript(`${pad}\n${real}`, ALLOWED);
  assert.equal(r.items.filter((i) => i.kind === 'line').length, PASS_H_MAX_LINES);
  assert.equal(r.dropped_lines, 3);
  assert.deepEqual(r.rejected_names, ['설록']);
});

t('narration and system caps drop overflow rather than throwing', () => {
  const n = Array.from({ length: PASS_H_MAX_NARRATION + 2 }, (_, i) => `${NARRATION_OPEN}n${i}${NARRATION_CLOSE}`).join('\n');
  const s = Array.from({ length: PASS_H_MAX_SYSTEM + 2 }, (_, i) => `[s${i}]`).join('\n');
  const r = parseHunterScript(`${n}\n${s}`, ALLOWED);
  assert.equal(r.items.filter((i) => i.kind === 'narration').length, PASS_H_MAX_NARRATION);
  assert.equal(r.items.filter((i) => i.kind === 'system').length, PASS_H_MAX_SYSTEM);
  assert.ok(r.dropped_lines >= 4);
});

t('extractHunterState pulls the fence so a name inside it is never a speaker', () => {
  const raw = [
    `💬 강다은${FIELD_SEP}"보고."`,
    STATE_OPEN,
    `설록${FIELD_SEP}😳${FIELD_SEP}분노${FIELD_SEP}입구${FIELD_SEP}침입`,
    STATE_CLOSE,
  ].join('\n');
  const { content, state } = extractHunterState(raw);
  assert.ok(!content.includes('설록'));
  assert.ok(state?.includes('설록'));
  assert.equal(parseHunterScript(content, ALLOWED).items[0].kind, 'line');
});

t('an unclosed state fence still yields its body', () => {
  const { content, state } = extractHunterState(`본문\n${STATE_OPEN}\n상황: 잘림`);
  assert.equal(content.trim(), '본문');
  assert.ok(state?.includes('상황: 잘림'));
});

t('parseHunterState only keeps actor rows for approved names', () => {
  const body = [
    '모드: ⚔️',
    '일정: 탐색',
    '상황: 정화',
    `강다은${FIELD_SEP}😳${FIELD_SEP}경악·흥미${FIELD_SEP}게이트 외부(통신)${FIELD_SEP}저것이... 제도?`,
    `설록${FIELD_SEP}😈${FIELD_SEP}침입${FIELD_SEP}내부${FIELD_SEP}훔침`,
  ].join('\n');
  const { state, rejected_names } = parseHunterState(body, ALLOWED);
  assert.equal(state.mode, '⚔️');
  assert.equal(state.schedule, '탐색');
  assert.equal(state.situation, '정화');
  assert.equal(state.actors?.length, 1);
  assert.equal(state.actors![0].character_id, 'daeun');
  assert.equal(state.actors![0].emoji, '😳');
  assert.deepEqual(rejected_names, ['설록']);
});

t('모드 is an enum: an unknown mark is ignored rather than stored', () => {
  const { state } = parseHunterState('모드: 🚀', ALLOWED);
  assert.equal(state.mode, undefined);
  const hit = parseHunterState(`모드: ${MODE_ICONS[1]} 전투`, ALLOWED);
  assert.equal(hit.state.mode, MODE_ICONS[1]);
});

t('a missing state body yields an empty proposal, never a throw', () => {
  const { state, rejected_names } = parseHunterState(null, ALLOWED);
  assert.deepEqual(state, {});
  assert.deepEqual(rejected_names, []);
});

t('Pass H names the allow-list as a closed set and forbids echoing the panel', () => {
  const prompt = renderPassH({
    speakers: ALLOWED,
    scene: { beat_goal: '원한의 근원을 찾는다' },
    panel: 'INFO\n⏳️-11',
    userName: '황지명',
    userText: '강다은, 상황 보고.',
    ambientNames: ['목련'],
  });
  assert.ok(prompt.includes('대사를 쓸 수 있는 인물은 다음뿐이다: 강다은'));
  assert.ok(prompt.includes('INFO 패널'));
  assert.ok(prompt.includes(STATE_OPEN));
  assert.ok(prompt.includes('목련'));
  assert.ok(!prompt.includes('설록'));
  assert.ok(prompt.includes('황지명, 상황 보고.') === false);
  assert.ok(prompt.includes('강다은, 상황 보고.'));
});

console.log(`\n${passed} passed`);
