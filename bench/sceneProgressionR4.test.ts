/**
 * npx tsx bench/sceneProgressionR4.test.ts
 * R4 — Progression: server-owned rise caps, quest lock, grade ladder.
 * Isolated: no live DB, no generate, no 1:1 prompt rewrite, no migration.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  applySceneDelta,
  HP_DELTA_MAX_UP,
  MONEY_DELTA_MAX_UP,
  type PartyCatalog,
} from '../apps/server/src/prompt/applySceneDelta.ts';
import { catalogFromStory } from '../apps/server/src/prompt/sceneCatalog.ts';
import { renderSceneDeltaPrompt } from '../apps/server/src/prompt/sceneDeltaPrompt.ts';
import { renderScene } from '../apps/server/src/prompt/templates.ts';
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

const CATALOG: PartyCatalog = {
  weathers: ['clear'],
  locations: ['lobby'],
  arcs: ['entry'],
  stagesByArc: { entry: ['reg'] },
  flags: {},
  grades: ['외문', '내문', '금단'],
};

const BASE: Scene = {
  location: 'lobby',
  user_sheet: { hp: 100, money: 1000, inventory: [] },
  hunter: { quest: undefined, trait: { name: '기초' } },
};

function apply(state: Scene, patch: unknown, version = 0) {
  return applySceneDelta(state, patch, CATALOG, version);
}

t('hp/money rise above the per-turn cap is ignored; damage still applies', () => {
  const up = apply(BASE, { base_version: 0, hp_delta: HP_DELTA_MAX_UP + 1 });
  assert.equal(up.state.user_sheet!.hp, 100);
  assert.ok(up.ignored.some((i) => i.key === 'hp_delta' && i.reason === 'rise_cap'));
  const ok = apply(BASE, { base_version: 0, hp_delta: HP_DELTA_MAX_UP });
  assert.equal(ok.state.user_sheet!.hp, 120);
  const cash = apply(BASE, { base_version: 0, money_delta: MONEY_DELTA_MAX_UP + 1 });
  assert.equal(cash.state.user_sheet!.money, 1000);
  assert.ok(cash.ignored.some((i) => i.key === 'money_delta' && i.reason === 'rise_cap'));
  const dmg = apply(BASE, { base_version: 0, hp_delta: -30 });
  assert.equal(dmg.state.user_sheet!.hp, 70);
});

t('quest_set fills an empty slot; replacing a different quest is locked', () => {
  const first = apply(BASE, { base_version: 0, quest_set: '입구 등록' });
  assert.equal(first.state.hunter!.quest, '입구 등록');
  assert.ok(first.applied.includes('quest_set'));
  const steal = apply(first.state, { base_version: first.state.scene_version ?? 1, quest_set: '금단 돌파' }, first.state.scene_version ?? 1);
  assert.equal(steal.state.hunter!.quest, '입구 등록');
  assert.ok(steal.ignored.some((i) => i.key === 'quest_set' && i.reason === 'quest_locked'));
  const same = apply(first.state, { base_version: first.state.scene_version ?? 1, quest_set: '입구 등록' }, first.state.scene_version ?? 1);
  assert.equal(same.state.hunter!.quest, '입구 등록');
  assert.ok(same.applied.includes('quest_set'));
});

t('quest_clear then quest_set is the legal replace (two applies)', () => {
  const held = apply(BASE, { base_version: 0, quest_set: '입구 등록' });
  const cleared = apply(held.state, { base_version: held.state.scene_version ?? 1, quest_clear: true }, held.state.scene_version ?? 1);
  assert.equal(cleared.state.hunter!.quest, undefined);
  assert.ok(cleared.applied.includes('quest_clear'));
  const next = apply(cleared.state, { base_version: cleared.state.scene_version ?? 2, quest_set: '금단 돌파' }, cleared.state.scene_version ?? 2);
  assert.equal(next.state.hunter!.quest, '금단 돌파');
});

t('grade_up walks the catalog ladder one step; skip and missing ladder fail closed', () => {
  const a = apply(BASE, { base_version: 0, grade_up: true });
  assert.equal(a.state.hunter!.trait!.grade, '외문');
  const b = apply(a.state, { base_version: a.state.scene_version ?? 1, grade_up: true }, a.state.scene_version ?? 1);
  assert.equal(b.state.hunter!.trait!.grade, '내문');
  const top = apply(
    { ...BASE, hunter: { trait: { grade: '금단' } } },
    { base_version: 0, grade_up: true },
  );
  assert.equal(top.state.hunter!.trait!.grade, '금단');
  assert.ok(top.ignored.some((i) => i.key === 'grade_up' && i.reason === 'rise_cap'));
  const noLadder = applySceneDelta(BASE, { base_version: 0, grade_up: true }, { ...CATALOG, grades: [] }, 0);
  assert.equal(noLadder.state.hunter!.trait!.grade, undefined);
  assert.ok(noLadder.ignored.some((i) => i.key === 'grade_up' && i.reason === 'not_in_allowlist'));
  const foreign = apply(
    { ...BASE, hunter: { trait: { grade: '신선' } } },
    { base_version: 0, grade_up: true },
  );
  assert.equal(foreign.state.hunter!.trait!.grade, '신선');
  assert.ok(foreign.ignored.some((i) => i.key === 'grade_up' && i.reason === 'not_in_allowlist'));
});

t('same patch sequence replays to identical hp/quest/grade (head-branch survival)', () => {
  const seq = (start: Scene) => {
    let s = start;
    let v = 0;
    for (const patch of [
      { base_version: 0, quest_set: '입구 등록', hp_delta: 5, grade_up: true },
      { hp_delta: -2, grade_up: true },
    ]) {
      const r = apply(s, { ...patch, base_version: v }, v);
      s = r.state;
      v = r.state.scene_version ?? v;
    }
    return s;
  };
  const a = seq(JSON.parse(JSON.stringify(BASE)) as Scene);
  const b = seq(JSON.parse(JSON.stringify(BASE)) as Scene);
  assert.equal(a.user_sheet!.hp, b.user_sheet!.hp);
  assert.equal(a.hunter!.quest, b.hunter!.quest);
  assert.equal(a.hunter!.trait!.grade, b.hunter!.trait!.grade);
  assert.equal(a.user_sheet!.hp, 103);
  assert.equal(a.hunter!.quest, '입구 등록');
  assert.equal(a.hunter!.trait!.grade, '내문');
});

t('apply does not mutate the input hunter slot', () => {
  const src: Scene = { hunter: { quest: '', trait: { name: '기초', grade: '외문' } } };
  apply(src, { base_version: 0, quest_set: '입구 등록', grade_up: true });
  assert.equal(src.hunter!.quest, '');
  assert.equal(src.hunter!.trait!.grade, '외문');
});

t('bare hunter/quest/grade keys stay off the allow-list', () => {
  const r = apply(BASE, {
    base_version: 0,
    hunter: { quest: '해킹', trait: { grade: '신선' } },
    quest: '해킹',
    grade: '신선',
  });
  assert.equal(r.state.hunter!.quest, undefined);
  assert.equal(r.state.hunter!.trait!.grade, undefined);
  const applySrc = src('apps/server/src/prompt/applySceneDelta.ts');
  assert.equal(applySrc.includes("'format'"), false);
  assert.equal(/\n  'quest'/.test(applySrc), false);
  assert.equal(/\n  'hunter'/.test(applySrc), false);
});

t('catalogFromStory forwards grades; prompt advertises the ladder only when present', () => {
  const cat = catalogFromStory(JSON.stringify({ grades: ['외문', '내문'] }));
  assert.deepEqual(cat.grades, ['외문', '내문']);
  const withLadder = renderSceneDeltaPrompt({ scene: BASE, catalog: { ...CATALOG }, userText: '수련' });
  assert.ok(withLadder.includes('grade_up'));
  assert.ok(withLadder.includes('외문'));
  const noLadder = renderSceneDeltaPrompt({ scene: BASE, catalog: { ...CATALOG, grades: [] }, userText: '수련' });
  assert.equal(noLadder.includes('grade_up'), false);
  assert.ok(withLadder.includes('quest_set'));
  assert.equal(withLadder.includes('relationship'), false);
});

t('1:1 renderScene stays six-field; builder/HARD_RULES files are not this slice', () => {
  const gold = '### 현재 장면 (정본. 없는 항목을 창작하지 말 것)\n장소: 항구\n시간: 밤';
  assert.equal(renderScene({ place: '항구', time: '밤', hunter: { quest: '입구' }, user_sheet: { hp: 1 } }), gold);
  const templates = src('apps/server/src/prompt/templates.ts');
  assert.equal(templates.includes('quest_set'), false);
  assert.equal(templates.includes('grade_up'), false);
  const builder = src('apps/server/src/prompt/builder.ts');
  assert.equal(builder.includes('quest_set'), false);
  assert.equal(builder.includes('applySceneDelta'), false);
});

t('0010/0011 migration bytes are not this slice', () => {
  const sha = (p: string) => createHash('sha256').update(fs.readFileSync(path.join(appRoot, p))).digest('hex');
  assert.equal(sha('apps/server/migrations/0010_scene_state.sql'), 'd8357b3624eafc4d7e9497129e3a3166c0f4d498c8adcc53cdc3f6337b57b298');
});

console.log(`\n${passed} passed`);
