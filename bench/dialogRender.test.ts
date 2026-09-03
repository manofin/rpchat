/**
 * npx tsx bench/dialogRender.test.ts
 * dialog-format S-A — the INFO sheet and script serialization, on shipped code.
 * Field shapes come from Dialog.txt (T-1 · T-29 · T-33); ids are synthetic.
 * Isolated: no systemd, no live DB, no model call, no migration, no live generate.
 */
import assert from 'node:assert/strict';
import {
  EMPTY_FIELD, renderCastRow, renderDialogHeader, renderInfoBlock, renderInfoRows,
  serializeDialogBeat, type ScriptItem,
} from '../apps/server/src/prompt/renderDialog.ts';
import type { BeatCastMember } from '../apps/server/src/prompt/renderBeat.ts';
import type { Scene } from '../apps/server/src/types.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const SEORIN: BeatCastMember = { id: 'osr', name: '오세린' };
const YEOJIN: BeatCastMember = { id: 'hyj', name: '한여진' };
const LOCKED: BeatCastMember = { id: 'mok', name: '목련', locked: true };
const CAST = [SEORIN, YEOJIN, LOCKED];

/** T-29 of the transcript, as scene state. */
const T29: Scene = {
  format: 'dialog',
  turn_no: 29,
  time_phrase: '이틀 뒤·오전 10시',
  location: '진령청 본부 지하2층 제3검사실',
  weather: '실내',
  present_ids: ['osr', 'hyj'],
  roster: {
    osr: { note: '봉인국 국장·1급·검사 중·추가 확인 요청(성흔 미약 발현)' },
    hyj: { note: '계약국 1급·보증·동의서 범위 확인' },
  },
  info: {
    status: ['민간인(영시+혈족능력 보유·비계약·비관리)', '비전투', '무소속'],
    goals: ['봉인국 영적 상태 검사(진행 중·「폐쇄」로 영시 잠금 상태)'],
  },
};

// ---- header ---------------------------------------------------------------

t('header is the transcript bracket form: T-n, 시간, 장소, 날씨', () => {
  assert.equal(
    renderDialogHeader(T29),
    '[T-29] [이틀 뒤·오전 10시] [진령청 본부 지하2층 제3검사실] [실내]',
  );
});

t('a scene with no time and no place renders no header, never an invented one', () => {
  assert.equal(renderDialogHeader({}), null);
  assert.equal(renderDialogHeader({ turn_no: 3 }), '[T-3]');
});

t('clock_minutes is used only when time_phrase is absent', () => {
  const clocked: Scene = { turn_no: 1, clock_minutes: 9 * 60 + 38, day_index: 2, location: '로비' };
  assert.equal(renderDialogHeader(clocked), '[T-1] [2일차·09:38] [로비]');
  assert.equal(
    renderDialogHeader({ ...clocked, time_phrase: '다음 날·오전' }),
    '[T-1] [다음 날·오전] [로비]',
  );
});

t('turn_no is truncated and never negative-formatted into a fake turn', () => {
  assert.equal(renderDialogHeader({ turn_no: 4.7 }), '[T-4]');
  assert.equal(renderDialogHeader({ turn_no: Number.NaN }), null);
});

// ---- INFO rows ------------------------------------------------------------

t('INFO rows are 정보·계약·침식·목표·인물 in transcript order', () => {
  const rows = renderInfoRows({ scene: T29, cast: CAST, userName: '황지명' });
  assert.deepEqual(rows.map((r) => r.label), ['정보', '계약', '침식', '목표', '인물']);
});

t('정보 leads with the persona name, then the scene segments', () => {
  const rows = renderInfoRows({ scene: T29, cast: CAST, userName: '황지명' });
  assert.equal(
    rows[0].value,
    '황지명 | 민간인(영시+혈족능력 보유·비계약·비관리) | 비전투 | 무소속',
  );
});

t('an empty field renders — , not an empty row', () => {
  const rows = renderInfoRows({ scene: T29, cast: CAST, userName: '황지명' });
  assert.equal(rows[1].value, EMPTY_FIELD);   // 계약
  assert.equal(rows[2].value, EMPTY_FIELD);   // 침식
});

t('목표 joins multiple goals with the transcript separator', () => {
  const scene: Scene = { ...T29, info: { ...T29.info, goals: ['정체 파악', '추가 검증(3일~1주일)'] } };
  const rows = renderInfoRows({ scene, cast: CAST, userName: '황지명' });
  assert.equal(rows[3].value, '정체 파악 / 추가 검증(3일~1주일)');
});

t('extra labeled rows are appended after 목표 and before 인물', () => {
  const scene: Scene = {
    ...T29,
    info: { ...T29.info, extra: [{ label: '성흔', value: '미약 발현' }, { label: '', value: 'dropped' }] },
  };
  const rows = renderInfoRows({ scene, cast: CAST, userName: '황지명' });
  assert.deepEqual(rows.map((r) => r.label), ['정보', '계약', '침식', '목표', '성흔', '인물']);
});

t('the persona name falls back to 나, matching the 1:1 builder', () => {
  const rows = renderInfoRows({ scene: {}, cast: [], userName: '' });
  assert.equal(rows[0].value, '나');
});

// ---- 인물 row --------------------------------------------------------------

t('인물 lists only who the scene says is present, with their note', () => {
  assert.equal(
    renderCastRow(T29, CAST),
    '오세린 | 봉인국 국장·1급·검사 중·추가 확인 요청(성흔 미약 발현) / 한여진 | 계약국 1급·보증·동의서 범위 확인',
  );
});

t('a present character with no note is still listed, by bare name', () => {
  const scene: Scene = { present_ids: ['osr', 'hyj'], roster: { osr: { note: '국장' } } };
  assert.equal(renderCastRow(scene, CAST), '오세린 | 국장 / 한여진');
});

t('an empty room renders —', () => {
  assert.equal(renderCastRow({ present_ids: [] }, CAST), EMPTY_FIELD);
  assert.equal(renderCastRow({}, CAST), EMPTY_FIELD);
});

t('a character outside present_ids never appears in 인물', () => {
  assert.ok(!renderCastRow(T29, CAST).includes('목련'));
});

// ---- block text -----------------------------------------------------------

t('renderInfoBlock prints one [라벨]: 값 per line', () => {
  const lines = renderInfoBlock({ scene: T29, cast: CAST, userName: '황지명' }).split('\n');
  assert.equal(lines.length, 5);
  assert.ok(lines[0].startsWith('[정보]: 황지명 | '));
  assert.equal(lines[1], '[계약]: —');
  assert.ok(lines[4].startsWith('[인물]: 오세린 | '));
});

// ---- serialization --------------------------------------------------------

const SCRIPT: ScriptItem[] = [
  { kind: 'narration', text: '오세린의 자안이 우산에서 황지명의 얼굴로 돌아왔다.' },
  { kind: 'line', character_id: 'osr', name: '오세린', text: '아라, 벌써 면역이 되셨네요.' },
  { kind: 'narration', text: '한 박자의 침묵.' },
  { kind: 'line', character_id: 'osr', name: '오세린', text: '들어오세요.' },
  { kind: 'line', character_id: 'hyj', name: '한여진', text: '불편하시면 말씀하세요.' },
];

t('the sheet is one block and the script follows in written order', () => {
  const blocks = serializeDialogBeat({
    header: renderDialogHeader(T29),
    info: renderInfoBlock({ scene: T29, cast: CAST, userName: '황지명' }),
    script: SCRIPT,
  });
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['info', 'narration', 'line', 'narration', 'line', 'line'],
  );
  assert.deepEqual(blocks.map((b) => b.seq), [0, 1, 2, 3, 4, 5]);
});

t('one speaker may hold several lines in a turn — the shape the beat cannot make', () => {
  const blocks = serializeDialogBeat({ header: null, info: null, script: SCRIPT });
  const osr = blocks.filter((b) => b.speaker_character_id === 'osr');
  assert.equal(osr.length, 2);
  assert.deepEqual(osr.map((b) => b.text), ['아라, 벌써 면역이 되셨네요.', '들어오세요.']);
});

t('header and INFO serialize as a single info block, not two panels', () => {
  const blocks = serializeDialogBeat({ header: '[T-29]', info: '[계약]: —', script: [] });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'info');
  assert.equal(blocks[0].text, '[T-29]\n[계약]: —');
});

t('no header and no info means no sheet block at all', () => {
  const blocks = serializeDialogBeat({ header: null, info: null, script: [{ kind: 'narration', text: '비.' }] });
  assert.deepEqual(blocks.map((b) => b.kind), ['narration']);
});

t('empty script items are skipped rather than serialized as blank blocks', () => {
  const blocks = serializeDialogBeat({
    header: null,
    info: null,
    script: [
      { kind: 'narration', text: '   ' },
      { kind: 'line', character_id: 'osr', name: '오세린', text: '' },
      { kind: 'narration', text: '비가 내렸다.' },
    ],
  });
  assert.deepEqual(blocks.map((b) => b.text), ['비가 내렸다.']);
  assert.deepEqual(blocks.map((b) => b.seq), [0]);
});

t('lineMeta supplies the portrait; a line with no asset keeps a null path', () => {
  const blocks = serializeDialogBeat({
    header: null,
    info: null,
    script: [{ kind: 'line', character_id: 'osr', name: '오세린', text: '들어오세요.' }],
    lineMeta: () => ({ asset_path: '/media/assets/osr/제복/2.webp', emotion: 'calm', outfit: '제복' }),
  });
  assert.equal(blocks[0].asset_path, '/media/assets/osr/제복/2.webp');
  assert.equal(blocks[0].emotion, 'calm');

  const bare = serializeDialogBeat({
    header: null,
    info: null,
    script: [{ kind: 'line', character_id: 'osr', name: '오세린', text: '들어오세요.' }],
  });
  assert.equal(bare[0].asset_path, null);
});

t('narration blocks never carry a speaker', () => {
  const blocks = serializeDialogBeat({ header: null, info: null, script: SCRIPT });
  for (const b of blocks.filter((x) => x.kind === 'narration')) {
    assert.equal(b.speaker_character_id, null);
    assert.equal(b.speaker_name, null);
  }
});

console.log(`\n${passed} passed`);
