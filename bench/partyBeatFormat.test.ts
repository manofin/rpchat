/** npx tsx bench/partyBeatFormat.test.ts
 * Classroom-shaped beat format against shipped compose/render (not a reimplementation).
 * Synthetic ids; never live 서리/카이 rows. No systemd, no live DB, no model.
 */
import assert from 'node:assert/strict';
import {
  finishBeat, planBeat, type BeatPlanInput,
} from '../apps/server/src/prompt/composeBeat.ts';
import { THOUGHT_MARKER } from '../apps/server/src/prompt/passes.ts';
import { catalogFromStory } from '../apps/server/src/prompt/sceneCatalog.ts';
import { initialBeatScene, DEFAULT_STORY_CLOCK_MINUTES } from '../apps/server/src/prompt/initScene.ts';
import { renderHeader, renderUi, LOCK_CHIP } from '../apps/server/src/prompt/renderBeat.ts';
import type { CastMember } from '../apps/server/src/prompt/cast.ts';
import type { Scene } from '../apps/server/src/types.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const member = (o: Partial<CastMember> & { id: string; name: string }): CastMember => ({
  aliases: [], duties: [], place: '교실', role: 'secondary', ...o,
});

const NARI = member({ id: 'nari', name: '나리', aliases: ['나리쨩'], duties: ['이야기'], outfit: '교복' });
const SERA = member({ id: 'sera', name: '세라', duties: ['교칙'], outfit: '교복' });
const HAYEON = member({ id: 'hayeon', name: '하연', duties: ['수업'], role: 'main', outfit: '교복' });
const YURA = member({ id: 'yura', name: '유라', talkativeness: 0.4 });
const LUNA = member({ id: 'luna', name: '루나', talkativeness: 0.8 });
const MIR = member({ id: 'mir', name: '미르', talkativeness: 0.1 });
const HAN = member({ id: 'hansoyeon', name: '한소연', place: '사무실' });
const YUKI = member({ id: 'yuki', name: '유키', place: '경비실' });
const CAST = [NARI, SERA, HAYEON, YURA, LUNA, MIR, HAN, YUKI];

const CAT = catalogFromStory(JSON.stringify({
  places: [
    { id: '교실', name: 'S반 교실', default_focus: 'hayeon' },
    { id: '사무실' },
    { id: '경비실' },
  ],
  weathers: ['맑음'],
  arcs: ['entry'],
  stagesByArc: { entry: ['reg', 'class'] },
  flags: { rulebreak: { owner_stage: 'reg', owner_duty: '교칙' } },
  stages: { class: { closer_duty: '수업' } },
  outfits: ['교복'],
  emotions: { '😡': 8, '🙂': 2 },
}));

const CLASSROOM: Scene = {
  location: '교실',
  weather: '맑음',
  clock_minutes: 9 * 60 + 38,
  day_index: 1,
  weekday: '목',
  arc: 'entry',
  stage: 'reg',
  present_ids: ['nari', 'sera', 'hayeon', 'yura', 'luna', 'mir'],
  roster: {
    nari: { emotion: '😡', outfit: '교복' },
    luna: { emotion: '🙂', outfit: '교복' },
  },
  user_sheet: {
    hp: 100,
    money: 10000,
    gear: ['교복', '스마트폰'],
    inventory: ['등록서류 봉투', '2학기 시간표'],
    traits: ['[A]성흔(풍뢰영근)'],
  },
};

const CARDS = Object.fromEntries(CAST.map((m) => [m.id, { name: m.name, personality: `${m.name}의 성격` }]));

const input = (o: Partial<BeatPlanInput> = {}): BeatPlanInput => ({
  conversation_id: 'conv-class',
  scene: CLASSROOM,
  catalog: CAT,
  current_version: 0,
  user_text: '나리, 네 이야기 말인데.',
  user_name: '황지명',
  cast: CAST,
  cards: CARDS,
  main_character_id: 'hayeon',
  message_id: 'msg-1',
  ...o,
});

t('header carries clock, place, weather from scene (not model text)', () => {
  const h = renderHeader(CLASSROOM);
  assert.ok(h, 'header must exist');
  assert.ok(h!.includes('09:38'), h);
  assert.ok(h!.includes('교실'), h);
  assert.ok(h!.includes('맑음'), h);
  assert.ok(h!.includes('1일차'), h);
});

t('initialBeatScene fills a StoryPage-empty overlay from catalog + closed cast', () => {
  const scene = initialBeatScene({ catalog: CAT, cast: CAST, overlay: {} });
  assert.equal(scene.location, '교실');
  assert.equal(scene.weather, '맑음');
  assert.equal(scene.clock_minutes, DEFAULT_STORY_CLOCK_MINUTES);
  assert.equal(scene.day_index, 1);
  assert.ok(scene.present_ids!.includes('nari'));
  assert.ok(scene.present_ids!.includes('luna'));
  assert.equal(scene.present_ids!.includes('hansoyeon'), false, '사무실 is out of the classroom');
  assert.equal(scene.present_ids!.includes('yuki'), false, '경비실 is out of the classroom');
  assert.equal(scene.user_sheet!.hp, 100);
  assert.equal(typeof scene.user_sheet!.money, 'number');
  assert.equal(scene.roster!.nari.outfit, '교복');
});

t('initialBeatScene overlay wins; 1:1 (cast < 2) is a no-op', () => {
  const over = initialBeatScene({
    catalog: CAT,
    cast: CAST,
    overlay: { location: '사무실', clock_minutes: 0, user_sheet: { hp: 30, money: 1 } },
  });
  assert.equal(over.location, '사무실');
  assert.equal(over.clock_minutes, 0);
  assert.equal(over.user_sheet!.hp, 30);
  const one = initialBeatScene({ catalog: CAT, cast: [NARI], overlay: { place: '복도' } });
  assert.deepEqual(one, { place: '복도' });
});

t('나리-targeted turn: focus line + extras ≤ 2 + ambient not a slot + thought only on focus + UI vitals/roster', () => {
  const i = input({ patch: { base_version: 0, flags: { rulebreak: true } } });
  const plan = planBeat(i);
  assert.equal(plan.focus.focus_id, 'nari');
  assert.ok(plan.approved_extras.length <= 2);
  assert.ok(plan.header!.includes('09:38') && plan.header!.includes('교실'));

  const done = finishBeat(i, plan, {
    narration: '뒤에서 루나가 킥킥 웃었다. 유라는 창밖을 보는 척했다.',
    focus_text: `"……짝꿍?"\n${THOUGHT_MARKER} 왜 안 피하지.`,
    extra_texts: Object.fromEntries(plan.approved_extras.map((e) => [e.character_id, `"${e.name} 한 줄."`])),
  });

  const kinds = done.blocks.map((b) => b.kind);
  assert.ok(kinds.includes('header'));
  assert.ok(kinds.includes('line'));
  assert.ok(kinds.includes('thought'));
  assert.ok(kinds.includes('ui'));
  assert.equal(kinds[kinds.length - 1], 'ui');

  const lines = done.blocks.filter((b) => b.kind === 'line');
  assert.ok(lines.some((b) => b.speaker_character_id === 'nari' && b.speaker_name === '나리'));
  assert.ok(lines.length <= 3, `focus + extras ≤ 2, got ${lines.length}`);
  assert.equal(lines.filter((b) => b.speaker_character_id !== 'nari').length, plan.approved_extras.length);
  assert.ok(lines.length - 1 <= 2);

  for (const name of ['루나', '유라', '미르', '한소연', '유키']) {
    assert.equal(lines.some((b) => b.speaker_name === name), false, `${name} must not be a dialogue slot`);
  }

  const thoughts = done.blocks.filter((b) => b.kind === 'thought');
  assert.equal(thoughts.length, 1);
  assert.equal(thoughts[0].speaker_character_id, 'nari');
  assert.equal(thoughts[0].text, '왜 안 피하지.');

  const ui = JSON.parse(done.blocks.find((b) => b.kind === 'ui')!.text);
  assert.equal(ui.user_sheet.hp, 100);
  assert.equal(ui.user_sheet.money, 10000);
  assert.ok(Array.isArray(ui.user_sheet.gear) && ui.user_sheet.gear.includes('교복'));
  assert.ok(Array.isArray(ui.user_sheet.inventory) && ui.user_sheet.inventory.length > 0);
  assert.ok(Array.isArray(ui.user_sheet.traits) && ui.user_sheet.traits.length > 0);
  const nariChip = ui.roster.find((r: { id: string }) => r.id === 'nari');
  const hanChip = ui.roster.find((r: { id: string }) => r.id === 'hansoyeon');
  assert.equal(nariChip.chip, '😡');
  assert.equal(nariChip.locked, false);
  assert.equal(hanChip.chip, LOCK_CHIP);
  assert.equal(hanChip.locked, true);

  const nariLine = lines.find((b) => b.speaker_character_id === 'nari')!;
  assert.equal(nariLine.asset_path, `/media/assets/nari/${encodeURIComponent('교복')}/8.webp`);
  assert.ok(!nariLine.asset_path!.includes('silu.uk'));
});

t('thought marker absent → no thought block; extras still capped', () => {
  const i = input({ patch: { base_version: 0 } });
  const plan = planBeat(i);
  const done = finishBeat(i, plan, {
    narration: '교실이 조용하다.',
    focus_text: '"자리, 옮기면 죽는다."',
    extra_texts: { luna: '"우와아"', yura: '"흥."', hayeon: '"수업 시작한다."' },
  });
  assert.equal(done.blocks.some((b) => b.kind === 'thought'), false);
  // quiet turn approves 0 extras, so even if extra_texts arrive they are ignored
  const extraLines = done.blocks.filter((b) => b.kind === 'line' && b.speaker_character_id !== 'nari');
  assert.ok(extraLines.length <= 2);
  assert.equal(extraLines.length, 0);
});

t('renderUi roster marks ambient/out-of-room as lock, vitals from user_sheet', () => {
  const ui = renderUi({ scene: CLASSROOM, cast: CAST, focus_id: 'nari', extra_ids: ['sera'] });
  assert.equal(ui.user_sheet!.hp, 100);
  assert.equal(ui.user_sheet!.money, 10000);
  assert.deepEqual(ui.user_sheet!.gear, ['교복', '스마트폰']);
  assert.deepEqual(ui.user_sheet!.inventory, ['등록서류 봉투', '2학기 시간표']);
  assert.deepEqual(ui.user_sheet!.traits, ['[A]성흔(풍뢰영근)']);
  assert.equal(ui.roster.find((r) => r.id === 'luna')!.chip, LOCK_CHIP);
  assert.equal(ui.roster.find((r) => r.id === 'nari')!.chip, '😡');
});

console.log(`PASS=${passed}`);
