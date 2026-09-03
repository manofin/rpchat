/** npx tsx bench/hudStateMatrix.test.ts
 * Notes_260903 State Authority Matrix — shipped applySceneDelta, not a reimplementation.
 * Isolated. No live DB, no school seed, no 1:1 rewrite.
 */
import assert from 'node:assert/strict';
import {
  applySceneDelta,
  HP_MAX,
  MONEY_MAX,
  type PartyCatalog,
} from '../apps/server/src/prompt/applySceneDelta.ts';
import { finishBeat, planBeat, type BeatPlanInput } from '../apps/server/src/prompt/composeBeat.ts';
import { catalogFromStory } from '../apps/server/src/prompt/sceneCatalog.ts';
import { THOUGHT_MARKER } from '../apps/server/src/prompt/passes.ts';
import type { CastMember } from '../apps/server/src/prompt/cast.ts';
import type { Scene } from '../apps/server/src/types.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const CATALOG: PartyCatalog = {
  weathers: ['맑음', '흐림'],
  locations: ['교실', '복도'],
  arcs: ['entry'],
  stagesByArc: { entry: ['reg'] },
  flags: { rulebreak: { owner_duty: '교칙' } },
  items: ['학생증', '등록서류 봉투', '2학기 시간표'],
};

const BASE: Scene = {
  location: '교실',
  weather: '맑음',
  clock_minutes: 9 * 60 + 38,
  user_sheet: { hp: 100, money: 10000, gear: ['교복'], inventory: ['학생증'], traits: [] },
};

function apply(state: Scene, patch: unknown, version = 0) {
  return applySceneDelta(state, patch, CATALOG, version);
}

t('illegal hp/money type or out-of-range delta leaves prior values', () => {
  const prior = { ...BASE, user_sheet: { ...BASE.user_sheet! } };
  const badType = apply(prior, { base_version: 0, hp_delta: 1.5, money_delta: 'x' });
  assert.equal(badType.state.user_sheet!.hp, 100);
  assert.equal(badType.state.user_sheet!.money, 10000);
  const over = apply(prior, { base_version: 0, hp_delta: -1000 });
  assert.equal(over.state.user_sheet!.hp, 100);
  assert.ok(over.ignored.some((i) => i.key === 'hp_delta' && i.reason === 'out_of_range'));
  const broke = apply(prior, { base_version: 0, money_delta: -10001 });
  assert.equal(broke.state.user_sheet!.money, 10000);
  const huge = apply(prior, { base_version: 0, hp_delta: HP_MAX + 1 });
  assert.equal(huge.state.user_sheet!.hp, 100);
  void MONEY_MAX;
});

t('bare hp/money/inventory keys do not overwrite the sheet', () => {
  const r = apply(BASE, { base_version: 0, hp: 1, money: 0, inventory: { gold: 9 } });
  assert.equal(r.state.user_sheet!.hp, 100);
  assert.equal(r.state.user_sheet!.money, 10000);
  assert.deepEqual(r.state.user_sheet!.inventory, ['학생증']);
  assert.ok(r.ignored.some((i) => i.key === 'hp'));
  assert.ok(r.ignored.some((i) => i.key === 'money'));
  assert.ok(r.ignored.some((i) => i.key === 'inventory'));
});

t('illegal location/weather stay previous; legal bounded deltas apply', () => {
  const r = apply(BASE, {
    base_version: 0,
    location: '옥상',
    weather: 'hail',
    hp_delta: -10,
    money_delta: 50,
    advance_minutes: 2,
  });
  assert.equal(r.state.location, '교실');
  assert.equal(r.state.weather, '맑음');
  assert.equal(r.state.user_sheet!.hp, 90);
  assert.equal(r.state.user_sheet!.money, 10050);
  assert.equal(r.state.clock_minutes, 9 * 60 + 40);
  assert.ok(r.ignored.some((i) => i.key === 'location'));
  assert.ok(r.ignored.some((i) => i.key === 'weather'));
});

t('inventory add/remove against allow-list; unknown ids ignored', () => {
  const add = apply(BASE, { base_version: 0, inventory_add: ['등록서류 봉투', '핵'] });
  assert.ok(add.state.user_sheet!.inventory!.includes('등록서류 봉투'));
  assert.equal(add.state.user_sheet!.inventory!.includes('핵'), false);
  assert.ok(add.ignored.some((i) => i.key === 'inventory_add.핵'));
  const drop = apply(add.state, { base_version: add.state.scene_version ?? 1, inventory_remove: ['학생증', '유니콘'] }, add.state.scene_version ?? 1);
  assert.equal(drop.state.user_sheet!.inventory!.includes('학생증'), false);
  assert.ok(drop.state.user_sheet!.inventory!.includes('등록서류 봉투'));
});

t('relationship and memories stay approval-gated and do not mutate live scene', () => {
  const r = apply(BASE, {
    base_version: 0,
    relationship: { nari: 12 },
    memories: [{ text: 'secret' }],
    hp_delta: -1,
  });
  assert.equal((r.state as Scene & { relationship?: unknown }).relationship, undefined);
  assert.equal((r.state as Scene & { memories?: unknown }).memories, undefined);
  assert.ok('relationship' in r.approvalCandidates);
  assert.ok('memories' in r.approvalCandidates);
  assert.equal(r.state.user_sheet!.hp, 99);
});

t('legal weather/location still apply alongside HUD', () => {
  const r = apply(BASE, { base_version: 0, weather: '흐림', location: '복도', hp_delta: 0 });
  assert.equal(r.state.weather, '흐림');
  assert.equal(r.state.location, '복도');
  assert.equal(r.state.user_sheet!.hp, 100);
});

const member = (o: Partial<CastMember> & { id: string; name: string }): CastMember => ({
  aliases: [], duties: [], place: '교실', role: 'secondary', ...o,
});
const CAST: CastMember[] = [
  member({ id: 'nari', name: '나리', duties: ['이야기'] }),
  member({ id: 'sera', name: '세라', duties: ['교칙'] }),
  member({ id: 'hayeon', name: '하연', duties: ['수업'], role: 'main' }),
  member({ id: 'luna', name: '루나', talkativeness: 0.8 }),
];
const BEAT_CAT = catalogFromStory(JSON.stringify({
  places: [{ id: '교실', default_focus: 'hayeon' }],
  weathers: ['맑음'],
  outfits: ['교복'],
  emotions: { '😡': 8 },
  items: ['학생증'],
}));

t('compose/render HUD still server JSON after a legal hp_delta; extras ≤ 2; local asset or null', () => {
  const scene: Scene = {
    location: '교실',
    weather: '맑음',
    clock_minutes: 578,
    day_index: 1,
    present_ids: CAST.map((c) => c.id),
    roster: { nari: { emotion: '😡', outfit: '교복' } },
    user_sheet: { hp: 100, money: 0, gear: ['교복'], inventory: ['학생증'], traits: [] },
  };
  const patched = applySceneDelta(scene, { base_version: 0, hp_delta: -5, money_delta: 10 }, { ...BEAT_CAT, items: ['학생증'] }, 0);
  assert.equal(patched.state.user_sheet!.hp, 95);
  const input: BeatPlanInput = {
    scene: patched.state,
    catalog: BEAT_CAT,
    current_version: 1,
    user_text: '나리, 네 이야기 말인데.',
    user_name: '황지명',
    cast: CAST,
    cards: Object.fromEntries(CAST.map((m) => [m.id, { name: m.name }])),
    main_character_id: 'hayeon',
  };
  const plan = planBeat(input);
  const done = finishBeat(input, plan, {
    narration: '교실이 조용하다.',
    focus_text: `"……짝꿍?"\n${THOUGHT_MARKER} 왜.`,
    extra_texts: {},
  });
  assert.ok(plan.header!.includes('교실'));
  assert.ok(/\d{2}:\d{2}/.test(plan.header!));
  const lines = done.blocks.filter((b) => b.kind === 'line');
  assert.ok(lines.some((b) => b.speaker_name === '나리'));
  assert.ok(lines.filter((b) => b.speaker_character_id !== 'nari').length <= 2);
  const thought = done.blocks.find((b) => b.kind === 'thought');
  assert.equal(thought?.speaker_character_id, 'nari');
  const ui = JSON.parse(done.blocks.find((b) => b.kind === 'ui')!.text);
  assert.equal(ui.user_sheet.hp, 95);
  assert.equal(ui.user_sheet.money, 10);
  assert.ok(ui.roster.some((r: { chip: string }) => r.chip === '😡' || r.chip === '🔒'));
  const nariLine = lines.find((b) => b.speaker_character_id === 'nari')!;
  assert.ok(nariLine.asset_path === null || nariLine.asset_path.startsWith('/media/assets/'));
  assert.ok(!String(nariLine.asset_path ?? '').includes('silu.uk'));
});

console.log(`PASS=${passed}`);
