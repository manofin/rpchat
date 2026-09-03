/**
 * npx tsx bench/composeDialog.test.ts
 * dialog-format S-C — planDialogBeat / finishDialogBeat on shipped code, plus the
 * Dialog.txt-class contract: one user turn → INFO sheet + interleaved script with
 * repeating speakers, which is exactly the shape the beat serializer cannot make.
 * Synthetic ids modelled on the transcript; never live 서리/카이 rows.
 * Isolated: no systemd, no live DB, no model call, no migration, no live generate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_DIALOG_SPEAKERS, dialogSpeakers, finishDialogBeat, planDialogBeat,
  type DialogPlanInput,
} from '../apps/server/src/prompt/composeDialog.ts';
import { PASS_S_MAX_LINES } from '../apps/server/src/prompt/dialogScript.ts';
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

const SEORIN = member({ id: 'osr', name: '오세린', aliases: ['국장'] });
const YEOJIN = member({ id: 'hyj', name: '한여진', aliases: ['여진'] });
const GUIDE = member({ id: 'guide', name: '길잡이', role: 'main' });
const BACKDROP = member({ id: 'bg', name: '직원', role: 'background' });
const CAST = [GUIDE, SEORIN, YEOJIN, BACKDROP];

const CAT = catalogFromStory(JSON.stringify({
  places: [{ id: '제3검사실', name: '제3검사실' }],
  weathers: ['실내'],
}));

/** T-29 of the transcript as scene state. */
const T29: Scene = {
  format: 'dialog',
  turn_no: 28,
  time_phrase: '이틀 뒤·오전 10시',
  location: '제3검사실',
  weather: '실내',
  present_ids: ['osr', 'hyj'],
  scene_version: 0,
  roster: {
    osr: { note: '봉인국 국장·1급·검사 중' },
    hyj: { note: '계약국 1급·보증·관찰' },
  },
  info: {
    status: ['민간인(영시+혈족능력 보유·비계약)', '비전투', '무소속'],
    goals: ['봉인국 영적 상태 검사'],
  },
};

const input = (o: Partial<DialogPlanInput> = {}): DialogPlanInput => ({
  conversation_id: 'conv-dialog',
  scene: T29,
  catalog: CAT,
  current_version: 0,
  user_text: '오세린 국장님, 검사부터 시작할까요?',
  user_name: '황지명',
  cast: CAST,
  main_character_id: 'guide',
  ...o,
});

// ---- speaker allow-list ---------------------------------------------------

t('the allow-list is who is present, focus first', () => {
  const slots = dialogSpeakers({ cast: CAST, scene: T29, focus_id: 'hyj' });
  assert.deepEqual(slots.map((s) => s.id), ['hyj', 'osr']);
});

t('a background row is never given a line slot (§4.2)', () => {
  const scene: Scene = { ...T29, present_ids: ['osr', 'hyj', 'bg'] };
  const slots = dialogSpeakers({ cast: CAST, scene, focus_id: null });
  assert.ok(!slots.some((s) => s.id === 'bg'));
});

t('a locked character is never given a line slot', () => {
  const cast = [...CAST, member({ id: 'mok', name: '목련', locked: true })];
  const scene: Scene = { ...T29, present_ids: ['osr', 'mok'] };
  assert.deepEqual(dialogSpeakers({ cast, scene, focus_id: null }).map((s) => s.id), ['osr']);
});

t('someone outside the room is never given a line slot', () => {
  const slots = dialogSpeakers({ cast: CAST, scene: T29, focus_id: null });
  assert.ok(!slots.some((s) => s.id === 'guide'));
});

t('the allow-list is capped at the transcript maximum', () => {
  const cast = Array.from({ length: 8 }, (_, i) => member({ id: `c${i}`, name: `인물${i}` }));
  const scene: Scene = { present_ids: cast.map((c) => c.id) };
  assert.equal(MAX_DIALOG_SPEAKERS, 3);
  assert.equal(dialogSpeakers({ cast, scene, focus_id: null }).length, MAX_DIALOG_SPEAKERS);
});

t('an ambient pick is excluded from the allow-list, unless they are the focus', () => {
  assert.deepEqual(
    dialogSpeakers({ cast: CAST, scene: T29, focus_id: 'osr', ambient_ids: ['hyj'] }).map((s) => s.id),
    ['osr'],
  );
  assert.deepEqual(
    dialogSpeakers({ cast: CAST, scene: T29, focus_id: 'hyj', ambient_ids: ['hyj'] }).map((s) => s.id),
    ['hyj', 'osr'],
  );
});

t('the focus keeps its slot even when the cap would otherwise cut it', () => {
  const cast = [
    ...Array.from({ length: 6 }, (_, i) => member({ id: `c${i}`, name: `인물${i}` })),
    SEORIN,
  ];
  const scene: Scene = { present_ids: cast.map((c) => c.id) };
  const slots = dialogSpeakers({ cast, scene, focus_id: 'osr' });
  assert.equal(slots[0].id, 'osr');
  assert.equal(slots.length, MAX_DIALOG_SPEAKERS);
});

// ---- plan -----------------------------------------------------------------

t('planning names the addressed character as focus, server-side only', () => {
  const plan = planDialogBeat(input());
  assert.equal(plan.focus.focus_id, 'osr');
  assert.equal(plan.called_model, false);
});

t('the plan renders the sheet from scene state, and no model has run', () => {
  const plan = planDialogBeat(input());
  assert.equal(plan.header, '[T-28] [이틀 뒤·오전 10시] [제3검사실] [실내]');
  assert.ok(plan.info!.startsWith('[정보]: 황지명 | 민간인'));
  assert.ok(plan.info!.includes('[인물]: 오세린 | 봉인국 국장·1급·검사 중 / 한여진 | 계약국 1급·보증·관찰'));
});

t('the Pass S prompt only ever offers the planned speakers', () => {
  const plan = planDialogBeat(input());
  const names = plan.speakers.map((s) => s.name);
  assert.ok(plan.pass_s.includes(`대사를 쓸 수 있는 인물은 다음뿐이다: ${names.join(', ')}`));
  assert.ok(!plan.pass_s.includes('직원'));
});

t('addressing two people keeps both on the allow-list, focus first', () => {
  // Shipped `resolveFocus` aims at the first name and records the rest as
  // mentions; the review spec's older "둘 이상이면 침묵" wording is behind the code.
  // For this format that is the useful behaviour: the turn has two speakers.
  const plan = planDialogBeat(input({ user_text: '오세린, 한여진, 둘 다 들어.' }));
  assert.equal(plan.focus.focus_id, 'osr');
  assert.deepEqual(plan.speakers.map((s) => s.id), ['osr', 'hyj']);
});

// ---- finish ---------------------------------------------------------------

const SCRIPT = [
  '오세린의 자안이 우산에서 황지명의 얼굴로 돌아왔다.',
  '오세린 | 아라, 벌써 면역이 되셨네요.',
  '한 박자의 침묵. 그리고—미소가 깊어졌다.',
  '오세린 | 지인분의 물건이라면 당연히요.',
  '오세린 | 들어오세요.',
  '한여진이 문 옆에서 서류철을 안은 채 지켜보고 있었다.',
  '한여진 | 불편하시면 말씀하세요.',
].join('\n');

t('Dialog.txt contract: one turn is INFO + interleaved narration and lines', () => {
  const inp = input();
  const finished = finishDialogBeat(inp, planDialogBeat(inp), SCRIPT);
  assert.deepEqual(
    finished.blocks.map((b) => b.kind),
    ['info', 'narration', 'line', 'narration', 'line', 'line', 'narration', 'line'],
  );
});

t('Dialog.txt contract: one speaker holds several lines in the same turn', () => {
  const inp = input();
  const finished = finishDialogBeat(inp, planDialogBeat(inp), SCRIPT);
  const osr = finished.blocks.filter((b) => b.speaker_character_id === 'osr');
  assert.equal(osr.length, 3);
  assert.deepEqual(finished.parsed.spoke_ids, ['osr', 'hyj']);
});

t('Dialog.txt contract: two characters speak in one turn without a hard_event', () => {
  const inp = input();
  const finished = finishDialogBeat(inp, planDialogBeat(inp), SCRIPT);
  const speakers = new Set(finished.blocks.filter((b) => b.kind === 'line').map((b) => b.speaker_character_id));
  assert.equal(speakers.size, 2);
});

t('every block carries a distinct ascending seq, and the sheet is first', () => {
  const inp = input();
  const finished = finishDialogBeat(inp, planDialogBeat(inp), SCRIPT);
  assert.deepEqual(finished.blocks.map((b) => b.seq), finished.blocks.map((_, i) => i));
  assert.equal(finished.blocks[0].kind, 'info');
});

t('a name the server did not approve gets no voice, and is reported', () => {
  const inp = input();
  const finished = finishDialogBeat(inp, planDialogBeat(inp), '설록 | 네 이름을 줘.');
  assert.ok(!finished.blocks.some((b) => b.kind === 'line'));
  assert.deepEqual(finished.parsed.rejected_names, ['설록']);
});

t('turn_no advances by exactly one, and only the server advances it', () => {
  const inp = input();
  const finished = finishDialogBeat(inp, planDialogBeat(inp), SCRIPT);
  assert.equal(finished.scene.turn_no, 29);
  assert.equal(String(src('apps/server/src/prompt/composeDialog.ts').match(/turn_no: turnNo \+ 1/g)?.length), '1');
});

t('a turn that produced nothing does not advance turn_no', () => {
  const inp = input();
  const finished = finishDialogBeat(inp, planDialogBeat(inp), '   ');
  assert.equal(finished.blocks.length, 1);      // the sheet only
  assert.equal(finished.scene.turn_no, 28);
});

t('turn_no starts at 1 for a scene that has never run a dialog turn', () => {
  const inp = input({ scene: { ...T29, turn_no: undefined } });
  const finished = finishDialogBeat(inp, planDialogBeat(inp), SCRIPT);
  assert.equal(finished.scene.turn_no, 1);
});

t('last_beat records who actually spoke, not who was allowed to', () => {
  const inp = input();
  const finished = finishDialogBeat(inp, planDialogBeat(inp), '오세린 | 들어오세요.');
  assert.equal(finished.scene.last_beat!.focus_id, 'osr');
  assert.deepEqual(finished.scene.last_beat!.extra_ids, []);
  assert.deepEqual(finished.scene.last_beat!.unresolved, []);
});

t('the persisted scene keeps every field the plan did not touch', () => {
  const inp = input();
  const finished = finishDialogBeat(inp, planDialogBeat(inp), SCRIPT);
  assert.equal(finished.scene.format, 'dialog');
  assert.equal(finished.scene.time_phrase, '이틀 뒤·오전 10시');
  assert.deepEqual(finished.scene.info, T29.info);
  assert.deepEqual(finished.scene.present_ids, ['osr', 'hyj']);
});

t('the line cap survives the whole pipeline', () => {
  const inp = input();
  const long = Array.from({ length: PASS_S_MAX_LINES + 5 }, (_, i) => `오세린 | 줄 ${i}`).join('\n');
  const finished = finishDialogBeat(inp, planDialogBeat(inp), long);
  assert.equal(finished.blocks.filter((b) => b.kind === 'line').length, PASS_S_MAX_LINES);
  assert.equal(finished.parsed.dropped_lines, 5);
});

// ---- choices ----------------------------------------------------------------

const SCRIPT_WITH_CHOICES = `${SCRIPT}\n<choices>["초안 1","초안 2","초안 3"]</choices>`;

t('a trailing <choices> block is extracted and never leaks into the script', () => {
  const inp = input();
  const finished = finishDialogBeat(inp, planDialogBeat(inp), SCRIPT_WITH_CHOICES);
  assert.deepEqual(finished.choices, ['초안 1', '초안 2', '초안 3']);
  assert.ok(!finished.blocks.some((b) => b.text.includes('<choices>')));
  // same block shape as the choices-free run — extraction must not eat a line
  assert.deepEqual(
    finished.blocks.map((b) => b.kind),
    ['info', 'narration', 'line', 'narration', 'line', 'line', 'narration', 'line'],
  );
});

t('a script with no choices block yields null, not an empty array (A-6)', () => {
  const inp = input();
  const finished = finishDialogBeat(inp, planDialogBeat(inp), SCRIPT);
  assert.equal(finished.choices, null);
});

t('a name inside a choice draft is never read as a speaker line', () => {
  const inp = input();
  const withNamedDraft = `${SCRIPT}\n<choices>["오세린 님, 잠시만요.","그냥 지나친다.","되묻는다."]</choices>`;
  const finished = finishDialogBeat(inp, planDialogBeat(inp), withNamedDraft);
  // SCRIPT itself has 4 speaker lines (오세린 x3, 한여진 x1) — the point is that
  // count does not change when a choice draft mentions a cast member's name.
  assert.equal(finished.blocks.filter((b) => b.kind === 'line').length, 4);
  assert.deepEqual(finished.choices, ['오세린 님, 잠시만요.', '그냥 지나친다.', '되묻는다.']);
});

t('the Pass S prompt reuses the 1:1 choices contract, not a bespoke format', () => {
  const plan = planDialogBeat(input());
  assert.ok(plan.pass_s.includes('<choices>['));
});

// ---- isolation ------------------------------------------------------------

t('the dialog modules call no model and touch no DB', () => {
  for (const f of ['composeDialog.ts', 'renderDialog.ts', 'dialogScript.ts']) {
    const code = src(`apps/server/src/prompt/${f}`);
    assert.ok(!/\bfetch\(/.test(code), `${f} must not fetch`);
    assert.ok(!/from '\.\.\/db\//.test(code), `${f} must not import db`);
    assert.ok(!/ctx\.model|\.complete\(|\.stream\(/.test(code), `${f} must not call a model`);
  }
});

t('the beat pipeline is untouched: composeBeat has no dialog branch', () => {
  const beat = src('apps/server/src/prompt/composeBeat.ts');
  assert.ok(!beat.includes('dialog'), 'composeBeat.ts must not know about the dialog format');
  assert.ok(!beat.includes('composeDialog'));
});

t('the dialog path never reaches the 1:1 builder', () => {
  const code = src('apps/server/src/prompt/composeDialog.ts');
  assert.ok(!code.includes('buildPrompt'));
});

console.log(`\n${passed} passed`);
