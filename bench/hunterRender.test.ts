/**
 * npx tsx bench/hunterRender.test.ts
 * hunter-format S-A — the INFO panel and script serialization, on shipped code.
 * Field shapes come from Huntt.txt (⏳️-11); ids are synthetic.
 * Isolated: no systemd, no live DB, no model call, no migration, no live generate.
 */
import assert from 'node:assert/strict';
import {
  DEFAULT_MODE, FIELD_SEP, HUNTER_EMPTY, NARRATION_CLOSE, NARRATION_OPEN, PANEL_LABEL,
  renderCastRows, renderClockRow, renderHunterPanel, renderQuestRows, renderSheetRows,
  renderTurnRow, serializeHunterBeat, type HunterScriptItem, type HunterState,
} from '../apps/server/src/prompt/renderHunter.ts';
import type { BeatCastMember } from '../apps/server/src/prompt/renderBeat.ts';
import type { Scene } from '../apps/server/src/types.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const DAEUN: BeatCastMember = { id: 'daeun', name: '강다은' };
const LOCKED: BeatCastMember = { id: 'mok', name: '목련', locked: true };
const CAST = [DAEUN, LOCKED];

/** ⏳️-11 of the transcript, as scene state. */
const T11: Scene = {
  format: 'hunter',
  turn_no: 11,
  day_index: 1,
  weekday: '월',
  clock_minutes: 10 * 60 + 55,
  location: '미등록 D급 게이트 내부',
  present_ids: ['daeun'],
  hunter: {
    date: '26.03.02.',
    gender: '남',
    affiliation: '무소속',
    trait: { name: '금강불괴', grade: '-', note: '육체 강도·정신 내성 극대화' },
    patron: { name: '달마', note: '골수 통찰·요마 제도의 가호' },
    skills: ['나한복마인'],
    quest: "게이트 내부의 '원한'을 제도하고 실력 증명하기",
  },
  user_sheet: {
    inventory: ['헌터 신분증'],
    money: 500_000,
  },
};

const STATE: HunterState = {
  mode: '⚔️',
  schedule: '망자 고블린 제도 -> 원한의 근원 탐색',
  situation: '시무외인으로 망자들을 일시 정화함',
  actors: [{
    character_id: 'daeun',
    emoji: '😳',
    mood: '경악·흥미',
    place: '게이트 외부(통신)',
    thought: '저것이... 제도? 파괴 없이 원한을...',
  }],
};

const T11_PANEL = [
  'INFO',
  '',
  '⏳️-11│1일차│🗓 26.03.02. 월',
  '10:55│오전│ ⚔️',
  '',
  '🪪 황지명│남│무소속│📍미등록 D급 게이트 내부',
  '✨️ 금강불괴│-│육체 강도·정신 내성 극대화',
  '💠 달마│골수 통찰·요마 제도의 가호',
  '📚: [나한복마인]',
  '💼: 헌터 신분증',
  '💰: 500,000원',
  '',
  '[💬 등장 중 인물: 강다은]',
  '강다은│😳│경악·흥미│📍게이트 외부(통신)',
  '💭: 저것이... 제도? 파괴 없이 원한을...',
  '',
  "🎯퀘스트: 게이트 내부의 '원한'을 제도하고 실력 증명하기",
  '📝일정: 망자 고블린 제도 -> 원한의 근원 탐색',
  '📖상황: 시무외인으로 망자들을 일시 정화함',
].join('\n');

t('the turn row is the transcript form: ⏳️-n│일차│🗓 날짜 요일', () => {
  assert.equal(renderTurnRow(T11), '⏳️-11│1일차│🗓 26.03.02. 월');
});

t('a scene with no clock and no date still prints ⏳️-0, never invents a calendar', () => {
  assert.equal(renderTurnRow({}), '⏳️-0');
  assert.equal(renderTurnRow({ turn_no: 3 }), '⏳️-3');
});

t('turn_no is truncated and a NaN turn does not become ⏳️-NaN', () => {
  assert.equal(renderTurnRow({ turn_no: 4.7 }), '⏳️-4');
  assert.equal(renderTurnRow({ turn_no: Number.NaN }), '⏳️-0');
});

t('the clock row keeps the space before the mode mark', () => {
  assert.equal(renderClockRow(T11, STATE), '10:55│오전│ ⚔️');
});

t('afternoon is 오후, and an unknown mode falls back to the default mark', () => {
  assert.equal(
    renderClockRow({ clock_minutes: 15 * 60 + 1 }, { mode: '??' }),
    `15:01${FIELD_SEP}오후${FIELD_SEP} ${DEFAULT_MODE}`,
  );
});

t('a missing clock prints - rather than 00:00', () => {
  assert.equal(renderClockRow({}), `-│-│ ${DEFAULT_MODE}`);
});

t('the six sheet rows are 🪪 ✨️ 💠 📚 💼 💰 in transcript order', () => {
  const rows = renderSheetRows({ scene: T11, cast: CAST, userName: '황지명' });
  assert.equal(rows.length, 6);
  assert.ok(rows[0].startsWith('🪪'));
  assert.ok(rows[1].startsWith('✨'));
  assert.ok(rows[2].startsWith('💠'));
  assert.ok(rows[3].startsWith('📚'));
  assert.ok(rows[4].startsWith('💼'));
  assert.ok(rows[5].startsWith('💰'));
});

t('empty identity fields render -, never a dropped row', () => {
  const rows = renderSheetRows({ scene: {}, cast: [], userName: '' });
  assert.equal(rows.length, 6);
  assert.ok(rows.every((r) => r.includes(HUNTER_EMPTY)));
  assert.ok(rows[0].startsWith('🪪 나│'));
});

t('money uses the transcript thousands separator', () => {
  const rows = renderSheetRows({ scene: T11, cast: CAST, userName: '황지명' });
  assert.equal(rows[5], '💰: 500,000원');
});

t('a character outside present_ids never appears in 등장 중 인물', () => {
  const rows = renderCastRows({ scene: T11, cast: CAST, userName: '황지명', state: STATE });
  assert.ok(!rows.join('\n').includes('목련'));
  assert.equal(rows[0], '[💬 등장 중 인물: 강다은]');
});

t('an empty room drops the whole 등장 section rather than printing a blank header', () => {
  assert.deepEqual(renderCastRows({ scene: { present_ids: [] }, cast: CAST, userName: '황지명' }), []);
  assert.deepEqual(renderCastRows({ scene: {}, cast: CAST, userName: '황지명' }), []);
});

t('a state actor whose id is not in the room contributes nothing', () => {
  const rows = renderCastRows({
    scene: T11,
    cast: CAST,
    userName: '황지명',
    state: { actors: [{ character_id: 'forged', emoji: '😈', thought: '침입' }] },
  });
  assert.ok(!rows.join('\n').includes('침입'));
  assert.ok(rows[1].includes(HUNTER_EMPTY));
});

t('퀘스트 is scene state; 일정 and 상황 prefer the turn\'s own writing', () => {
  const rows = renderQuestRows({ scene: T11, cast: CAST, userName: '황지명', state: STATE });
  assert.equal(rows[0], "🎯퀘스트: 게이트 내부의 '원한'을 제도하고 실력 증명하기");
  assert.equal(rows[1], '📝일정: 망자 고블린 제도 -> 원한의 근원 탐색');
  assert.equal(rows[2], '📖상황: 시무외인으로 망자들을 일시 정화함');
});

t('a missing state block still renders the quest rows, filled with -', () => {
  const rows = renderQuestRows({ scene: {}, cast: [], userName: '황지명' });
  assert.deepEqual(rows, [
    `🎯퀘스트: ${HUNTER_EMPTY}`,
    `📝일정: ${HUNTER_EMPTY}`,
    `📖상황: ${HUNTER_EMPTY}`,
  ]);
});

t('the T-11 panel is byte-identical to the transcript, VS16 included', () => {
  const panel = renderHunterPanel({ scene: T11, cast: CAST, userName: '황지명', state: STATE });
  assert.equal(panel, T11_PANEL);
  assert.equal(panel.startsWith(PANEL_LABEL + '\n'), true);
});

t('a newline inside a model-written field cannot forge a new panel row', () => {
  const panel = renderHunterPanel({
    scene: T11,
    cast: CAST,
    userName: '황지명',
    state: { situation: '한 줄\n🪪 위조│S급', schedule: 'a│b' },
  });
  assert.ok(!panel.includes('\n🪪 위조'));
  assert.ok(panel.includes('a/b'));
});

const SCRIPT: HunterScriptItem[] = [
  { kind: 'narration', text: '게이트 밖, 홀로그램 스크린으로 내부 상황을 주시하던 강다은의 미간이 좁아졌다.' },
  { kind: 'line', character_id: 'daeun', name: '강다은', text: '(통신) "황지명, 접근한다. 열두 개체."' },
  { kind: 'system', text: '경고. 해석 불가능한 고밀도 정보 반응.' },
];

t('the script serializes in written order and the panel is last', () => {
  const blocks = serializeHunterBeat({ script: SCRIPT, panel: T11_PANEL });
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['narration', 'line', 'system', 'panel'],
  );
  assert.deepEqual(blocks.map((b) => b.seq), [0, 1, 2, 3]);
  assert.equal(blocks[3].kind, 'panel');
  assert.equal(blocks[0].text, `${NARRATION_OPEN}게이트 밖, 홀로그램 스크린으로 내부 상황을 주시하던 강다은의 미간이 좁아졌다.${NARRATION_CLOSE}`);
  assert.equal(blocks[2].text, '[경고. 해석 불가능한 고밀도 정보 반응.]');
});

t('one speaker may hold several lines in a turn — the shape the beat cannot make', () => {
  const blocks = serializeHunterBeat({
    script: [
      { kind: 'line', character_id: 'daeun', name: '강다은', text: '하나.' },
      { kind: 'narration', text: '침묵.' },
      { kind: 'line', character_id: 'daeun', name: '강다은', text: '둘.' },
    ],
    panel: null,
  });
  const lines = blocks.filter((b) => b.speaker_character_id === 'daeun');
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((b) => b.text), ['하나.', '둘.']);
});

t('empty script items are skipped rather than serialized as blank blocks', () => {
  const blocks = serializeHunterBeat({
    script: [
      { kind: 'narration', text: '   ' },
      { kind: 'line', character_id: 'daeun', name: '강다은', text: '' },
      { kind: 'system', text: '  ' },
      { kind: 'narration', text: '비가 내렸다.' },
    ],
    panel: null,
  });
  assert.deepEqual(blocks.map((b) => b.text), [`${NARRATION_OPEN}비가 내렸다.${NARRATION_CLOSE}`]);
});

t('no panel means the turn ends on the last script block', () => {
  const blocks = serializeHunterBeat({ script: SCRIPT, panel: '  ' });
  assert.equal(blocks.at(-1)?.kind, 'system');
});

console.log(`\n${passed} passed`);
