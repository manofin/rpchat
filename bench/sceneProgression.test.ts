/** npx tsx bench/sceneProgression.test.ts
 * F9E Scene Progression — applySceneDelta pure function (A-3 + A-6).
 * Isolated. No live DB, no generate, no 0010 edit, no pickSpeaker, no UI.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  ADVANCE_MINUTES_MAX,
  applySceneDelta,
  type PartyCatalog,
} from '../apps/server/src/prompt/applySceneDelta.ts';
import type { Scene } from '../apps/server/src/types.js';
import { renderScene } from '../apps/server/src/prompt/templates.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

function sha256(p: string) {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

const CATALOG: PartyCatalog = {
  weathers: ['clear', 'rain', 'fog'],
  locations: ['bureau_lobby_01', 'exam_hall_01'],
  arcs: ['entrance', 'term1'],
  stagesByArc: {
    entrance: ['registration', 'exam'],
    term1: ['classroom'],
  },
  flags: {
    power_scan_pending: { owner_stage: 'registration' },
    oath_signed: {},
  },
};

const BASE: Scene = {
  place: '취선객잔',
  time: '밤',
  clock_minutes: 60,
  weather: 'clear',
  location: 'bureau_lobby_01',
  arc: 'entrance',
  stage: 'registration',
  flags: [{ key: 'power_scan_pending', owner_stage: 'registration' }],
};

function apply(state: Scene, patch: unknown, version = 1) {
  return applySceneDelta(state, patch, CATALOG, version);
}

function main() {
  const migPath = 'apps/server/migrations/0010_scene_state.sql';
  const migShaBefore = sha256(migPath);
  const typesSrc = fs.readFileSync('apps/server/src/types.ts', 'utf8');
  const convSrc = fs.readFileSync('apps/server/src/routes/conversations.ts', 'utf8');
  const templatesSrc = fs.readFileSync('apps/server/src/prompt/templates.ts', 'utf8');
  const applySrc = fs.readFileSync('apps/server/src/prompt/applySceneDelta.ts', 'utf8');

  t('ADVANCE_MINUTES_MAX is 1440', () => {
    assert.equal(ADVANCE_MINUTES_MAX, 1440);
  });

  t('applySceneDelta does not import pickSpeaker', () => {
    assert.equal(fs.existsSync('apps/server/src/prompt/pickSpeaker.js'), false);
    assert.equal(/pickSpeaker/.test(applySrc), false);
    assert.equal(fs.existsSync('apps/server/src/prompt/assignSpeakers.js'), false);
    assert.equal(/assignSpeakers/.test(applySrc), false);
  });

  t('applySceneDelta does not import routes/db/chat', () => {
    assert.equal(applySrc.includes('../routes/'), false);
    assert.equal(applySrc.includes('../db/'), false);
    assert.equal(applySrc.includes('conversations.ts'), false);
  });

  t('valid advance_minutes adds to clock_minutes', () => {
    const r = apply(BASE, { base_version: 1, advance_minutes: 30 });
    assert.equal(r.discarded, false);
    assert.equal(r.state.clock_minutes, 90);
    assert.ok(r.applied.includes('advance_minutes'));
    assert.equal(r.state.time, '밤');
  });

  t('advance_minutes 0 is applied as no clock change', () => {
    const r = apply(BASE, { base_version: 1, advance_minutes: 0 });
    assert.equal(r.discarded, false);
    assert.equal(r.state.clock_minutes, 60);
    assert.ok(r.applied.includes('advance_minutes'));
  });

  t('advance_minutes above cap leaves clock unchanged', () => {
    const r = apply(BASE, { base_version: 1, advance_minutes: 1441 });
    assert.equal(r.state.clock_minutes, 60);
    assert.equal(r.applied.includes('advance_minutes'), false);
    assert.ok(r.ignored.some((i) => i.key === 'advance_minutes'));
  });

  t('advance_minutes negative leaves clock unchanged', () => {
    const r = apply(BASE, { base_version: 1, advance_minutes: -1 });
    assert.equal(r.state.clock_minutes, 60);
    assert.ok(r.ignored.some((i) => i.key === 'advance_minutes'));
  });

  t('advance_minutes non-int leaves clock unchanged', () => {
    const r = apply(BASE, { base_version: 1, advance_minutes: 1.5 });
    assert.equal(r.state.clock_minutes, 60);
    const r2 = apply(BASE, { base_version: 1, advance_minutes: '30' });
    assert.equal(r2.state.clock_minutes, 60);
  });

  t('weather in catalog applies; unknown weather ignored', () => {
    const ok = apply(BASE, { base_version: 1, weather: 'rain' });
    assert.equal(ok.state.weather, 'rain');
    const bad = apply(BASE, { base_version: 1, weather: 'hail' });
    assert.equal(bad.state.weather, 'clear');
    assert.ok(bad.ignored.some((i) => i.key === 'weather'));
  });

  t('location in catalog applies; unknown location ignored', () => {
    const ok = apply(BASE, { base_version: 1, location: 'exam_hall_01' });
    assert.equal(ok.state.location, 'exam_hall_01');
    const bad = apply(BASE, { base_version: 1, location: 'https://evil.example' });
    assert.equal(bad.state.location, 'bureau_lobby_01');
  });

  t('stage must belong to current arc', () => {
    const ok = apply(BASE, { base_version: 1, stage: 'exam' });
    assert.equal(ok.state.stage, 'exam');
    const bad = apply(BASE, { base_version: 1, stage: 'classroom' });
    assert.equal(bad.state.stage, 'registration');
  });

  t('arc in catalog applies; unknown arc ignored', () => {
    const ok = apply(BASE, { base_version: 1, arc: 'term1', stage: 'classroom' });
    assert.equal(ok.state.arc, 'term1');
    assert.equal(ok.state.stage, 'classroom');
    const bad = apply(BASE, { base_version: 1, arc: 'secret' });
    assert.equal(bad.state.arc, 'entrance');
  });

  t('arc change resets stage and drops owner-less flags (arc end)', () => {
    const start: Scene = {
      ...BASE,
      flags: [
        { key: 'power_scan_pending', owner_stage: 'registration' },
        { key: 'oath_signed' },
      ],
    };
    const r = apply(start, { base_version: 1, arc: 'term1' });
    assert.equal(r.state.arc, 'term1');
    assert.equal(r.state.stage, undefined);
    assert.deepEqual(r.state.flags ?? [], []);
    assert.ok(r.archiveSnapshot);
    assert.equal(r.archiveSnapshot!.arc, 'entrance');
  });

  t('stage change drops flags owned by the left stage', () => {
    const r = apply(BASE, { base_version: 1, stage: 'exam' });
    assert.equal(r.state.stage, 'exam');
    assert.equal((r.state.flags ?? []).some((f) => f.key === 'power_scan_pending'), false);
  });

  t('declared flag true adds; false removes; unknown flag key ignored only', () => {
    const add = apply({ ...BASE, flags: [] }, { base_version: 1, flags: { oath_signed: true } });
    assert.ok((add.state.flags ?? []).some((f) => f.key === 'oath_signed'));
    const rem = apply(BASE, { base_version: 1, flags: { power_scan_pending: false } });
    assert.equal((rem.state.flags ?? []).some((f) => f.key === 'power_scan_pending'), false);
    const mix = apply(BASE, {
      base_version: 1,
      flags: { oath_signed: true, unknown_flag: true },
    });
    assert.ok((mix.state.flags ?? []).some((f) => f.key === 'oath_signed'));
    assert.equal((mix.state.flags ?? []).some((f) => f.key === 'unknown_flag'), false);
    assert.ok(mix.ignored.some((i) => i.key === 'flags.unknown_flag'));
  });

  t('partial apply: bad weather does not block good location', () => {
    const r = apply(BASE, { base_version: 1, weather: 'hail', location: 'exam_hall_01' });
    assert.equal(r.discarded, false);
    assert.equal(r.state.weather, 'clear');
    assert.equal(r.state.location, 'exam_hall_01');
  });

  t('unknown patch keys drop; six-field time string not applied', () => {
    const r = apply(BASE, {
      base_version: 1,
      time: '새벽',
      place: '다른곳',
      hp: -3,
      inventory: { gold: 1 },
      money: 5,
      extra: true,
    });
    assert.equal(r.state.time, '밤');
    assert.equal(r.state.place, '취선객잔');
    assert.equal((r.state as Scene & { hp?: number }).hp, undefined);
    assert.ok(r.ignored.some((i) => i.key === 'time'));
    assert.ok(r.ignored.some((i) => i.key === 'hp'));
    assert.ok(r.ignored.some((i) => i.key === 'inventory'));
    assert.ok(r.ignored.some((i) => i.key === 'money'));
    assert.ok(r.ignored.some((i) => i.key === 'extra'));
  });

  t('relationship and memories are never auto-applied', () => {
    const r = apply(BASE, {
      base_version: 1,
      relationship: { kai: 12 },
      memories: [{ text: 'secret' }],
    });
    assert.equal((r.state as Scene & { relationship?: unknown }).relationship, undefined);
    assert.equal((r.state as Scene & { memories?: unknown }).memories, undefined);
    assert.ok('relationship' in r.approvalCandidates);
    assert.ok('memories' in r.approvalCandidates);
  });

  t('base_version mismatch discards entire patch', () => {
    const r = apply(BASE, { base_version: 12, weather: 'rain', location: 'exam_hall_01' }, 13);
    assert.equal(r.discarded, true);
    assert.equal(r.state.weather, 'clear');
    assert.equal(r.state.location, 'bureau_lobby_01');
    assert.deepEqual(r.applied, []);
  });

  t('missing base_version discards entire patch', () => {
    const r = apply(BASE, { weather: 'rain' });
    assert.equal(r.discarded, true);
    assert.equal(r.state.weather, 'clear');
  });

  t('non-object patch discards', () => {
    assert.equal(apply(BASE, null).discarded, true);
    assert.equal(apply(BASE, 'rain').discarded, true);
  });

  t('type-invalid location null ignores that key only', () => {
    const r = apply(BASE, { base_version: 1, location: null, weather: 'rain' });
    assert.equal(r.discarded, false);
    assert.equal(r.state.location, 'bureau_lobby_01');
    assert.equal(r.state.weather, 'rain');
  });

  t('successful apply increments scene_version; discard does not', () => {
    const ok = apply(BASE, { base_version: 1, weather: 'rain' }, 1);
    assert.equal(ok.state.scene_version, 2);
    const bad = apply(BASE, { base_version: 0, weather: 'rain' }, 1);
    assert.equal(bad.discarded, true);
    assert.equal(bad.state.scene_version, undefined);
  });

  t('input state is not mutated', () => {
    const src: Scene = { ...BASE, flags: [...(BASE.flags ?? [])] };
    apply(src, { base_version: 1, weather: 'rain', flags: { oath_signed: true } });
    assert.equal(src.weather, 'clear');
    assert.equal(src.flags?.length, 1);
  });

  t('renderScene still six-field only; weather/clock not in prompt', () => {
    const GOLDEN =
      '### 현재 장면 (정본. 없는 항목을 창작하지 말 것)\n장소: 취선객잔\n시간: 밤';
    assert.equal(renderScene({ place: '취선객잔', time: '밤', weather: 'rain', clock_minutes: 99 }), GOLDEN);
    assert.equal(templatesSrc.includes('s.weather'), false);
    assert.equal(templatesSrc.includes('clock_minutes'), false);
  });

  t('0010 file bytes unchanged this slice', () => {
    assert.equal(sha256(migPath), migShaBefore);
    assert.equal(migShaBefore, sha256(migPath));
  });

  t('conversations PATCH still shallow-merge; no applySceneDelta import', () => {
    assert.ok(convSrc.includes('...parseJson<Scene>(conv.scene_json, {}), ...d.scene'));
    assert.equal(convSrc.includes('applySceneDelta'), false);
  });

  t('Scene type has F9B additive keys; no hp/relationship on interface', () => {
    const start = typesSrc.indexOf('export interface Scene {');
    const end = typesSrc.indexOf('export interface ConversationRow');
    const block = typesSrc.slice(start, end);
    assert.ok(block.includes('clock_minutes?: number'));
    // A-3: hp is server-owned (delta proposal only) and relationship needs user
    // approval, so neither may be a Scene field the GM can drive. f9-beat-render
    // added a nested server-owned `user_sheet`, so this fence binds on the two
    // things that actually matter: no top-level key, and no apply path.
    // Top-level Scene fields are indented exactly two spaces; a nested field
    // (user_sheet.hp) is deeper, and only the top level is what A-3 forbids.
    assert.equal(/^ {2}hp\?:/m.test(block), false);
    assert.equal(/^ {2}relationship\?:/m.test(block), false);
    assert.ok(/^ {2}user_sheet\?:/m.test(block), 'user_sheet is the nested, server-owned home for hp');
    const applySrc = fs.readFileSync('apps/server/src/prompt/applySceneDelta.ts', 'utf8');
    const allow = applySrc.slice(applySrc.indexOf('const APPLY_KEYS'), applySrc.indexOf('const APPROVAL_KEYS'));
    for (const k of ['hp', 'money', 'relationship', 'user_sheet', 'roster', 'last_beat']) {
      assert.equal(allow.includes(`'${k}'`), false, `${k} must not be an appliable scene key`);
    }
  });

  t('no extra 0010 files', () => {
    const files = fs.readdirSync('apps/server/migrations').filter((f) => f.endsWith('.sql'));
    assert.equal(files.filter((f) => f.startsWith('0010_')).length, 1);
  });

  console.log(`# pass ${passed}`);
}

main();
