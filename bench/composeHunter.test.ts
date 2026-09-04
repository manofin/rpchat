/**
 * npx tsx bench/composeHunter.test.ts
 * hunter-format S-C — planHunterBeat / finishHunterBeat on shipped code, plus the
 * Huntt.txt-class contract: one user turn → interleaved 『』/💬/[] script, panel last.
 * Synthetic ids modelled on the transcript; never live 서리/카이 rows.
 * Isolated: no systemd, no live DB, no model call, no migration, no live generate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_HUNTER_SPEAKERS, finishHunterBeat, hunterSpeakers, planHunterBeat,
  type HunterPlanInput,
} from '../apps/server/src/prompt/composeHunter.ts';
import { PASS_H_MAX_LINES, STATE_CLOSE, STATE_OPEN } from '../apps/server/src/prompt/hunterScript.ts';
import { catalogFromStory } from '../apps/server/src/prompt/sceneCatalog.ts';
import type { CastMember } from '../apps/server/src/prompt/cast.ts';
import type { Scene } from '../apps/server/src/types.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(dir, '..');
const src = (rel: string) => fs.readFileSync(path.join(appRoot, rel), 'utf8');

const member = (o: Partial<CastMember> & { id: string; name: string }): CastMember => ({
  aliases: [], duties: [], place: '', role: 'secondary', ...o,
});

const DAEUN = member({ id: 'daeun', name: '강다은', aliases: ['다은'] });
const GUIDE = member({ id: 'guide', name: '길잡이', role: 'main' });
const BACKDROP = member({ id: 'bg', name: '인부', role: 'background' });
const CAST = [GUIDE, DAEUN, BACKDROP];

const CAT = catalogFromStory(JSON.stringify({
  places: [{ id: '게이트', name: '미등록 D급 게이트 내부' }],
  weathers: ['지하'],
}));

const T11: Scene = {
  format: 'hunter',
  turn_no: 11,
  day_index: 1,
  weekday: '월',
  clock_minutes: 10 * 60 + 55,
  location: '미등록 D급 게이트 내부',
  present_ids: ['daeun'],
  scene_version: 0,
  hunter: {
    date: '26.03.02.',
    gender: '남',
    affiliation: '무소속',
    trait: { name: '금강불괴', grade: '-', note: '육체 강도·정신 내성 극대화' },
    patron: { name: '달마', note: '골수 통찰·요마 제도의 가호' },
    skills: ['나한복마인'],
    quest: "게이트 내부의 '원한'을 제도하고 실력 증명하기",
  },
  user_sheet: { inventory: ['헌터 신분증'], money: 500_000 },
};

const input = (o: Partial<HunterPlanInput> = {}): HunterPlanInput => ({
  conversation_id: 'conv-hunter',
  scene: T11,
  catalog: CAT,
  current_version: 0,
  user_text: '강다은, 상황 보고.',
  user_name: '황지명',
  cast: CAST,
  main_character_id: 'guide',
  ...o,
});

const SCRIPT = [
  '『게이트 밖, 홀로그램 스크린으로 내부 상황을 주시하던 강다은의 미간이 좁아졌다.』',
  '💬 강다은│(통신) "황지명, 접근한다. 열두 개체."',
  '[경고. 해석 불가능한 고밀도 정보 반응.]',
  '💬 설록│"네 이름을 줘."',
  STATE_OPEN,
  '모드: ⚔️',
  '일정: 망자 고블린 제도 -> 원한의 근원 탐색',
  '상황: 시무외인으로 망자들을 일시 정화함',
  '강다은│😳│경악·흥미│게이트 외부(통신)│저것이... 제도? 파괴 없이 원한을...',
  STATE_CLOSE,
].join('\n');

t('the allow-list is who is present, focus first', () => {
  const slots = hunterSpeakers({ cast: CAST, scene: T11, focus_id: 'daeun' });
  assert.deepEqual(slots.map((s) => s.id), ['daeun']);
});

t('a background row is never given a line slot (§4.2)', () => {
  const scene: Scene = { ...T11, present_ids: ['daeun', 'bg'] };
  const slots = hunterSpeakers({ cast: CAST, scene, focus_id: null });
  assert.ok(!slots.some((s) => s.id === 'bg'));
});

t('a locked character is never given a line slot', () => {
  const cast = [...CAST, member({ id: 'mok', name: '목련', locked: true })];
  const scene: Scene = { ...T11, present_ids: ['daeun', 'mok'] };
  assert.deepEqual(hunterSpeakers({ cast, scene, focus_id: null }).map((s) => s.id), ['daeun']);
});

t('someone outside the room is never given a line slot', () => {
  const slots = hunterSpeakers({ cast: CAST, scene: T11, focus_id: null });
  assert.ok(!slots.some((s) => s.id === 'guide'));
});

t('the allow-list is capped at 3, the room\'s legal party size', () => {
  const cast = Array.from({ length: 8 }, (_, i) => member({ id: `c${i}`, name: `인물${i}` }));
  const scene: Scene = { present_ids: cast.map((c) => c.id) };
  assert.equal(MAX_HUNTER_SPEAKERS, 3);
  assert.equal(hunterSpeakers({ cast, scene, focus_id: null }).length, MAX_HUNTER_SPEAKERS);
});

t('an ambient pick is excluded from the allow-list, unless they are the focus', () => {
  const two: Scene = { ...T11, present_ids: ['daeun', 'guide'] };
  assert.deepEqual(
    hunterSpeakers({ cast: CAST, scene: two, focus_id: 'guide', ambient_ids: ['daeun'] }).map((s) => s.id),
    ['guide'],
  );
  assert.deepEqual(
    hunterSpeakers({ cast: CAST, scene: two, focus_id: 'daeun', ambient_ids: ['daeun'] }).map((s) => s.id),
    ['daeun', 'guide'],
  );
});

t('planning names the addressed character as focus, server-side only', () => {
  const plan = planHunterBeat(input());
  assert.equal(plan.focus.focus_id, 'daeun');
  assert.equal(plan.called_model, false);
});

t('the plan renders an identity-only panel from scene state, and no model has run', () => {
  const plan = planHunterBeat(input());
  assert.ok(plan.panel_preview.startsWith('INFO'));
  assert.ok(plan.panel_preview.includes('⏳️-11│1일차│🗓 26.03.02. 월'));
  assert.ok(plan.panel_preview.includes('🪪 황지명│남│무소속│📍미등록 D급 게이트 내부'));
  // Identity-only: 상황/일정 fall back to - because no state has been written yet.
  assert.ok(plan.panel_preview.includes('📖상황: -'));
});

t('the Pass H prompt only ever offers the planned speakers', () => {
  const plan = planHunterBeat(input());
  assert.ok(plan.pass_h.includes('대사를 쓸 수 있는 인물은 다음뿐이다: 강다은'));
  assert.ok(!plan.pass_h.includes('인부'));
});

t('finishHunterBeat serializes the script then the panel', () => {
  const inp = input();
  const finished = finishHunterBeat(inp, planHunterBeat(inp), SCRIPT);
  assert.deepEqual(
    finished.blocks.map((b) => b.kind),
    ['narration', 'line', 'system', 'narration', 'panel'],
  );
  assert.equal(finished.blocks.at(-1)?.kind, 'panel');
  assert.deepEqual(finished.blocks.map((b) => b.seq), finished.blocks.map((_, i) => i));
});

t('a name the server did not approve gets no voice, and is reported', () => {
  const inp = input();
  const finished = finishHunterBeat(inp, planHunterBeat(inp), SCRIPT);
  assert.deepEqual(finished.parsed.rejected_names, ['설록']);
  assert.ok(finished.blocks.some((b) => b.kind === 'narration' && b.text.includes('네 이름을 줘')));
  assert.ok(!finished.blocks.some((b) => b.speaker_name === '설록'));
});

t('the panel\'s written half comes from the fenced state, allow-listed', () => {
  const inp = input();
  const finished = finishHunterBeat(inp, planHunterBeat(inp), SCRIPT);
  const panel = finished.blocks.find((b) => b.kind === 'panel')!.text;
  assert.ok(panel.includes('📖상황: 시무외인으로 망자들을 일시 정화함'));
  assert.ok(panel.includes('강다은│😳│경악·흥미│📍게이트 외부(통신)'));
  assert.ok(!panel.includes('설록'));
  assert.equal(finished.state.mode, '⚔️');
});

t('turn_no advances by exactly one, and only the server advances it', () => {
  const inp = input();
  const finished = finishHunterBeat(inp, planHunterBeat(inp), SCRIPT);
  assert.equal(finished.scene.turn_no, 12);
  assert.equal(String(src('apps/server/src/prompt/composeHunter.ts').match(/turn_no: turnNo \+ 1/g)?.length), '1');
});

t('a turn that produced nothing does not advance turn_no', () => {
  const inp = input();
  const finished = finishHunterBeat(inp, planHunterBeat(inp), '   ');
  assert.equal(finished.parsed.items.length, 0);
  assert.equal(finished.scene.turn_no, 11);
  assert.equal(finished.blocks.filter((b) => b.kind !== 'panel').length, 0);
});

t('turn_no starts at 1 for a scene that has never run a hunter turn', () => {
  const inp = input({ scene: { ...T11, turn_no: undefined } });
  const finished = finishHunterBeat(inp, planHunterBeat(inp), SCRIPT);
  assert.equal(finished.scene.turn_no, 1);
});

t('last_beat records who actually spoke, not who was allowed to', () => {
  const inp = input();
  const finished = finishHunterBeat(inp, planHunterBeat(inp), '💬 강다은│"보고."');
  assert.equal(finished.scene.last_beat!.focus_id, 'daeun');
  assert.deepEqual(finished.scene.last_beat!.extra_ids, []);
  assert.deepEqual(finished.scene.last_beat!.unresolved, []);
});

t('the persisted scene keeps every identity field the plan did not touch', () => {
  const inp = input();
  const finished = finishHunterBeat(inp, planHunterBeat(inp), SCRIPT);
  assert.equal(finished.scene.format, 'hunter');
  assert.deepEqual(finished.scene.hunter, T11.hunter);
  assert.deepEqual(finished.scene.present_ids, ['daeun']);
  assert.equal(finished.scene.user_sheet?.money, 500_000);
});

t('the line cap survives the whole pipeline', () => {
  const inp = input();
  const long = Array.from({ length: PASS_H_MAX_LINES + 5 }, (_, i) => `💬 강다은│"줄 ${i}"`).join('\n');
  const finished = finishHunterBeat(inp, planHunterBeat(inp), long);
  assert.equal(finished.blocks.filter((b) => b.kind === 'line').length, PASS_H_MAX_LINES);
  assert.equal(finished.parsed.dropped_lines, 5);
});

t('a trailing <choices> block is extracted and never leaks into the script', () => {
  const inp = input();
  const finished = finishHunterBeat(
    inp, planHunterBeat(inp),
    `${SCRIPT}\n<choices>["초안 1","초안 2","초안 3"]</choices>`,
  );
  assert.deepEqual(finished.choices, ['초안 1', '초안 2', '초안 3']);
  assert.ok(!finished.blocks.some((b) => b.text.includes('<choices>')));
});

t('a script with no choices block yields null, not an empty array (A-6)', () => {
  const inp = input();
  const finished = finishHunterBeat(inp, planHunterBeat(inp), SCRIPT);
  assert.equal(finished.choices, null);
});

t('the hunter modules stay pure: no db, no fetch, no model', () => {
  for (const f of [
    'apps/server/src/prompt/renderHunter.ts',
    'apps/server/src/prompt/hunterScript.ts',
    'apps/server/src/prompt/composeHunter.ts',
  ]) {
    const code = src(f);
    assert.ok(!/\bfetch\(/.test(code), `${f} must not fetch`);
    assert.ok(!/from '\.\.\/db\//.test(code), `${f} must not import db`);
    assert.ok(!/ctx\.model|\.complete\(|\.stream\(/.test(code), `${f} must not call a model`);
  }
});

t('the beat pipeline is untouched: composeBeat has no hunter branch', () => {
  const beat = src('apps/server/src/prompt/composeBeat.ts');
  assert.ok(!beat.includes('hunter'), 'composeBeat.ts must not know about the hunter format');
  assert.ok(!beat.includes('composeHunter'));
  const dialog = src('apps/server/src/prompt/composeDialog.ts');
  assert.ok(!dialog.includes('hunter'), 'composeDialog.ts must not know about the hunter format');
});

t('the hunter path never reaches the 1:1 builder', () => {
  const code = src('apps/server/src/prompt/composeHunter.ts');
  assert.ok(!code.includes('buildPrompt'));
});

t('hunter identity keys are not in applySceneDelta\'s allow-list', () => {
  const delta = src('apps/server/src/prompt/applySceneDelta.ts');
  assert.ok(!delta.includes("'hunter'"));
  assert.ok(!delta.includes("'format'"));
  assert.ok(!delta.includes("'quest'"));
});

t('generateBeat\'s body is not the hunter path — dispatch sits outside it', () => {
  const chat = src('apps/server/src/routes/chat.ts');
  const start = chat.indexOf('async function generateBeat(');
  const dialog = chat.indexOf('async function generateDialog(');
  assert.ok(start >= 0 && dialog > start);
  const body = chat.slice(start, dialog);
  assert.ok(!body.includes('hunter'), 'generateBeat must not mention hunter');
  assert.ok(chat.includes("fmt === 'hunter'"));
  assert.ok(chat.includes('async function generateHunter('));
});

console.log(`\n${passed} passed`);
