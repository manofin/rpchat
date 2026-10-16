// npm run test:benches -- adventureState — pure, synthetic records; no model or live DB.
import assert from 'node:assert/strict';
import { applyAdventureAction, renderAdventureState, requestSchema } from '../apps/server/src/adventure/state.js';
import { applySceneDelta } from '../apps/server/src/prompt/applySceneDelta.js';
import { planBeat, passFWith, planPassE, type BeatPlanInput } from '../apps/server/src/prompt/composeBeat.js';
import type { AdventureState } from '@rpchat/contracts/adventure';
let checks = 0;
function test(name: string, fn: () => void) { fn(); console.log(`ok ${++checks} ${name}`); }
const initial = () => applyAdventureAction(undefined, { kind: 'initialize', currency: '은화', balance: 2, rank: '불', experience: 0, skills: [] }, 'init').state;
const catalog = { weathers: [], locations: [], arcs: [], stagesByArc: {}, flags: {}, items: ['도구'], grades: ['불', '치'] };
test('model proposals cannot spend, award, accept a quest or upgrade confirmed state', () => {
  const state = { adventure: initial(), user_sheet: { money: 2, inventory: [] }, hunter: { trait: { grade: '불' } } };
  const result = applySceneDelta(state, { base_version: 0, money_delta: -1, inventory_add: '도구', quest_set: '약초', grade_up: true }, catalog, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(result.state.user_sheet)), state.user_sheet);
  assert.deepEqual(JSON.parse(JSON.stringify(result.state.hunter)), state.hunter);
  assert.deepEqual(result.state.adventure, state.adventure);
  assert.equal(result.ignored.filter(r => r.reason === 'human_confirmation_required').length, 4);
});
test('three-turn observation: inquiry and consideration preserve money; registration alone pays', () => {
  let s = initial();
  s = applyAdventureAction(s, { kind: 'quest_offer', title: '약초', terms: '뿌리 10개 / 이틀 / 도구 대여 별도', reward: 3 }, 'q').state;
  s = applyAdventureAction(s, { kind: 'quest_stage', quest_id: 'q', stage: 'considering' }, 'x').state;
  assert.equal(s.balance, 2); assert.equal(s.registration, null); assert.deepEqual(s.items, []);
  s = applyAdventureAction(s, { kind: 'register', organization: '유사단', fee: 1 }, 'x').state;
  assert.equal(s.balance, 1); assert.equal(s.quests[0].stage, 'considering'); assert.equal(s.experience, 0);
  assert.deepEqual(s.skills, []); assert.deepEqual(s.items, []);
  assert.throws(() => applyAdventureAction(s, { kind: 'register', organization: '유사단', fee: 1 }, 'x'), /이미 등록/);
});
test('ownership, loan conditions, partial returns and quantities survive JSON round trip', () => {
  let s = applyAdventureAction(initial(), { kind: 'item_receive', name: '호미', quantity: 2, ownership: 'loan', owner: '접수원', terms: '이틀 뒤 반납', source: '창구에서 직접 수령' }, 'tool').state;
  assert.throws(() => applyAdventureAction(s, { kind: 'item_reduce', item_id: 'tool', quantity: 1, reason: 'use' }, 'x'), /대여품/);
  s = applyAdventureAction(JSON.parse(JSON.stringify(s)), { kind: 'item_reduce', item_id: 'tool', quantity: 1, reason: 'return' }, 'x').state;
  assert.equal(s.items[0].quantity, 1); assert.equal(s.items[0].terms, '이틀 뒤 반납');
  assert.throws(() => applyAdventureAction(s, { kind: 'item_reduce', item_id: 'tool', quantity: 2, reason: 'return' }, 'x'), /수량/);
});
test('promised reward is not payment; settlement requires completion and cannot repeat', () => {
  let s = applyAdventureAction(initial(), { kind: 'quest_offer', title: '약초', terms: '열 뿌리', reward: 3 }, 'q').state;
  assert.throws(() => applyAdventureAction(s, { kind: 'quest_settle', quest_id: 'q', received: 3 }, 'x'), /완료/);
  for (const stage of ['accepted', 'in_progress', 'completed']) s = applyAdventureAction(s, { kind: 'quest_stage', quest_id: 'q', stage }, 'x').state;
  assert.equal(s.balance, 2); assert.equal(s.experience, 0);
  s = applyAdventureAction(s, { kind: 'quest_settle', quest_id: 'q', received: 2 }, 'x').state;
  assert.equal(s.balance, 4); assert.equal(s.quests[0].reward, 3);
  assert.throws(() => applyAdventureAction(s, { kind: 'quest_settle', quest_id: 'q', received: 2 }, 'x'), /한 번/);
});
test('negative/fractional/overflow amounts, unknown fields and insufficient funds fail without mutation', () => {
  const s = initial(); const before = JSON.stringify(s);
  for (const amount of [-1, 0.5, 1_000_000_001, NaN, Infinity, 3]) {
    assert.throws(() => applyAdventureAction(s, { kind: 'payment', direction: 'pay', amount, counterpart: '창구', reason: '비용' }, 'x'));
  }
  assert.equal(JSON.stringify(s), before);
  assert.equal(requestSchema.safeParse({ expected_head_id: 'h', expected_scene_version: 0, idempotency_key: 'bad', action: { kind: 'register', organization: 'a', fee: 1 }, confirmed_by: 'model' }).success, false);
});
test('unknown persisted versions fail closed and prompt distinguishes terms from delivery', () => {
  assert.throws(() => renderAdventureState({ ...initial(), version: 9 } as unknown as AdventureState));
  assert.match(renderAdventureState(initial())!, /제안·질문·고려는 실행이 아니다/);
  assert.equal(renderAdventureState(undefined), null);
});

test('beat planner supplies the same confirmed data to N, F and each actual extra', () => {
  const input: BeatPlanInput = {
    scene: { adventure: initial(), location: 'reception', present_ids: ['a', 'b', 'c'] },
    catalog, current_version: 0, user_text: '안녕하세요', main_character_id: 'a',
    cast: ['a', 'b', 'c'].map((id, n) => ({ id, name: `인물${n}`, aliases: [], duties: [], place: '', role: n === 0 ? 'main' : 'secondary' })),
  };
  const plan = planBeat(input);
  const extras = planPassE(input, plan, '안내를 기다린다.', '조건을 설명하겠다.');
  assert.equal(extras.length, 2, 'exercise real approved extras, not an empty map');
  const expected = renderAdventureState(initial())!;
  for (const prompt of [plan.pass_n, plan.pass_f, passFWith(input, plan, '서술'), ...extras.map(e => e.prompt)]) {
    assert.ok(prompt?.includes(expected), 'every actor receives the confirmed public state');
    assert.equal(prompt!.split(expected).length - 1, 1, 'include the packet once per request');
  }
});
