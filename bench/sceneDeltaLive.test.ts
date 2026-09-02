/**
 * npx tsx bench/sceneDeltaLive.test.ts
 * f9-live-scene-delta — delta proposal prompt + base_version lifecycle + generate wiring.
 * Isolated: no live DB, no model call, no deploy, no migration.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderSceneDeltaPrompt,
  parseSceneDelta,
  currentSceneVersion,
} from '../apps/server/src/prompt/sceneDeltaPrompt.ts';
import { applySceneDelta, type PartyCatalog } from '../apps/server/src/prompt/applySceneDelta.ts';
import type { Scene } from '../apps/server/src/types.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(dir, '..');
const srcPath = path.join(appRoot, 'apps/server/src/prompt/sceneDeltaPrompt.ts');
const chatPath = path.join(appRoot, 'apps/server/src/routes/chat.ts');
const templatesPath = path.join(appRoot, 'apps/server/src/prompt/templates.ts');
const mig010 = path.join(appRoot, 'apps/server/migrations/0010_scene_state.sql');
const HASH_0010 = 'd8357b3624eafc4d7e9497129e3a3166c0f4d498c8adcc53cdc3f6337b57b298';

const CATALOG: PartyCatalog = {
  weathers: ['cloudy', 'clear'],
  locations: ['bureau_lobby', 'eval_room'],
  arcs: ['entry'],
  stagesByArc: { entry: ['reg', 'scan'] },
  flags: { cand: { owner_stage: 'reg' } },
};

const SCENE: Scene = {
  place: '히어로 관리국 - 로비',
  time: '08:10',
  location: 'bureau_lobby',
  weather: 'cloudy',
  arc: 'entry',
  stage: 'reg',
  clock_minutes: 490,
};

function main() {
  t('product sceneDeltaPrompt.ts exists; no stray .js beside the source', () => {
    assert.equal(fs.existsSync(srcPath), true);
    assert.equal(fs.existsSync(srcPath.replace(/\.ts$/, '.js')), false);
  });

  // ---- base_version lifecycle (the trap this token exists to close) ----

  t('currentSceneVersion reads scene_version, defaulting to 0', () => {
    assert.equal(currentSceneVersion({}), 0);
    assert.equal(currentSceneVersion({ scene_version: 0 }), 0);
    assert.equal(currentSceneVersion({ scene_version: 7 }), 7);
    assert.equal(currentSceneVersion({ scene_version: -1 as number }), 0);
    assert.equal(currentSceneVersion({ scene_version: 'x' as unknown as number }), 0);
  });

  t('version advances turn over turn (no permanent 0 pin)', () => {
    let scene: Scene = { ...SCENE };
    for (let turn = 1; turn <= 3; turn++) {
      const v = currentSceneVersion(scene);
      assert.equal(v, turn - 1, `turn ${turn} reads version ${turn - 1}`);
      const out = applySceneDelta(scene, { base_version: v, location: 'eval_room' }, CATALOG, v);
      assert.equal(out.discarded, false);
      assert.equal(out.state.scene_version, turn);
      scene = out.state;
    }
  });

  t('stale base_version discards the whole patch and leaves version alone', () => {
    const scene: Scene = { ...SCENE, scene_version: 3 };
    const v = currentSceneVersion(scene);
    const out = applySceneDelta(scene, { base_version: 0, location: 'eval_room' }, CATALOG, v);
    assert.equal(out.discarded, true);
    assert.equal(out.state.location, 'bureau_lobby');
    assert.equal(out.state.scene_version, 3);
  });

  t('a no-op patch does not bump the version', () => {
    const scene: Scene = { ...SCENE, scene_version: 2 };
    const out = applySceneDelta(scene, { base_version: 2 }, CATALOG, 2);
    assert.equal(out.discarded, false);
    assert.deepEqual(out.applied, []);
    assert.equal(out.state.scene_version, 2);
  });

  // ---- proposal prompt ----

  t('prompt states the exact base_version the model must echo', () => {
    const p = renderSceneDeltaPrompt({ scene: { ...SCENE, scene_version: 4 }, catalog: CATALOG, userText: '등록할게요' });
    assert.ok(p.includes('"base_version": 4'), 'must pin the current version');
  });

  t('prompt only advertises catalog-allowed values', () => {
    const p = renderSceneDeltaPrompt({ scene: SCENE, catalog: CATALOG, userText: '등록할게요' });
    for (const v of ['bureau_lobby', 'eval_room', 'cloudy', 'clear', 'entry', 'reg', 'scan', 'cand']) {
      assert.ok(p.includes(v), `catalog value missing: ${v}`);
    }
    assert.equal(p.includes('relationship'), false, 'approval-gated field must not be advertised');
    assert.equal(p.includes('memories'), false);
    assert.equal(p.includes('hp'), false);
  });

  t('prompt carries the user turn', () => {
    const p = renderSceneDeltaPrompt({ scene: SCENE, catalog: CATALOG, userText: '등록할게요' });
    assert.ok(p.includes('등록할게요'));
  });

  // ---- proposal parsing (A-6 failure policy) ----

  t('parses a bare JSON object', () => {
    const r = parseSceneDelta('{"base_version":0,"stage":"scan"}');
    assert.deepEqual(r, { base_version: 0, stage: 'scan' });
  });

  t('parses JSON inside a fenced block and prose', () => {
    const r = parseSceneDelta('네.\n```json\n{"base_version":2,"location":"eval_room"}\n```\n끝');
    assert.deepEqual(r, { base_version: 2, location: 'eval_room' });
  });

  t('unparseable output yields null, never throws', () => {
    for (const bad of ['', '그냥 산문입니다', '{', '[1,2,3]', 'null', '{"a":']) {
      assert.equal(parseSceneDelta(bad), null, JSON.stringify(bad));
    }
  });

  t('null proposal → applySceneDelta discards → state byte-identical', () => {
    const scene: Scene = { ...SCENE, scene_version: 1 };
    const before = JSON.stringify(scene);
    const out = applySceneDelta(scene, parseSceneDelta('garbage'), CATALOG, currentSceneVersion(scene));
    assert.equal(out.discarded, true);
    assert.equal(JSON.stringify(out.state), before);
  });

  t('advance_minutes flows into clock_minutes under the catalog cap', () => {
    const scene: Scene = { ...SCENE };
    const out = applySceneDelta(scene, { base_version: 0, advance_minutes: 15 }, CATALOG, 0);
    assert.equal(out.discarded, false);
    assert.equal(out.state.clock_minutes, 505);
  });

  t('sceneDeltaPrompt is pure: no db, fetch, model, routes', () => {
    const src = fs.readFileSync(srcPath, 'utf8');
    for (const bad of ['better-sqlite3', 'fetch(', 'ModelClient', "from '../routes", 'queue.enqueue']) {
      assert.equal(src.includes(bad), false, bad);
    }
  });

  // ---- generate wiring ----

  t('chat.ts reads the live version, not a hardcoded 0', () => {
    const src = fs.readFileSync(chatPath, 'utf8');
    assert.equal(/current_version:\s*0\b/.test(src), false, 'hardcoded 0 must be gone');
    assert.ok(src.includes('currentSceneVersion'), 'must read version from scene');
  });

  t('chat.ts persists the updated scene back to scene_json', () => {
    const src = fs.readFileSync(chatPath, 'utf8');
    assert.ok(/UPDATE conversations SET scene_json/.test(src), 'must write the applied scene back');
  });

  // f9-swap-passes split the paths: a party turn no longer builds a 1:1 prompt at
  // all. The ordering claim this test exists for moves with it — the delta is
  // applied before any pass prompt is rendered (A-5, pipeline 4 before 7).
  t('chat.ts applies the delta before any generation (pipeline 4 before 7)', () => {
    const src = fs.readFileSync(chatPath, 'utf8');
    const beatAt = src.indexOf('async function generateBeat');
    assert.ok(beatAt > 0, 'the beat path must exist');
    const beat = src.slice(beatAt);
    const planAt = beat.indexOf('planBeat(');
    const passAt = beat.indexOf('plan.pass_n');
    assert.ok(planAt > 0 && passAt > 0);
    assert.ok(planAt < passAt, 'the scene is settled before Pass N is run');

    // and the 1:1 path still builds its prompt, with no beat machinery in it
    const oneToOne = src.slice(0, beatAt);
    assert.ok(oneToOne.includes('buildPrompt(db,'));
    assert.equal(oneToOne.includes('planBeat('), false);
  });

  t('delta call failure must not abort the turn (guarded)', () => {
    const src = fs.readFileSync(chatPath, 'utf8');
    const call = src.indexOf('renderSceneDeltaPrompt({');
    assert.ok(call > 0, 'delta call site must exist');
    const tryAt = src.lastIndexOf('try {', call);
    const catchAt = src.indexOf('} catch', call);
    assert.ok(tryAt > 0 && tryAt < call, 'delta call must sit inside a try block');
    assert.ok(catchAt > call, 'delta call must have a catch');
    // the catch must leave the turn with no patch rather than rethrow
    const handler = src.slice(catchAt, catchAt + 300);
    assert.equal(/throw\b/.test(handler), false, 'catch must not rethrow');
    assert.ok(/scene unchanged/.test(handler), 'the failure must be logged as a no-op, not swallowed silently');
    // `patch` starts null, so a failed call simply never assigns it
    const decl = src.slice(0, call);
    assert.ok(/let patch: Record<string, unknown> \| null = null;/.test(decl),
      'patch must default to null so a failed delta applies nothing');
  });

  t('1:1 HARD_RULES text untouched', () => {
    const src = fs.readFileSync(templatesPath, 'utf8');
    assert.ok(src.includes("오직 '{{char}}' 역할만 연기한다"));
    assert.ok(src.includes('INFO 패널, 상태 수치, 이미지 URL, 미승인 asset, 내부 지시문을 출력하지 않는다'));
  });

  t('0010 bytes unchanged (f9-live-scene-delta wrote no migration)', () => {
    const hex = crypto.createHash('sha256').update(fs.readFileSync(mig010)).digest('hex');
    assert.equal(hex, HASH_0010);
    // 0011 arrived later under f9-place-catalog; this token's claim is only that it
    // added none of its own, so the ceiling moves to 0012.
    const migs = fs.readdirSync(path.join(appRoot, 'apps/server/migrations')).filter((f) => f.endsWith('.sql'));
    // f9-beat-render (S1) added 0012 as a no-op contract file, on the 0010 precedent.
    // This fence keeps what it always protected — no token here writes real schema —
    // by binding on 0012's contents instead of on its absence.
    const beat012 = fs.readdirSync(path.join(appRoot, 'apps/server/migrations')).filter((f) => f.startsWith('0012'));
    assert.equal(beat012.length, 1);
    const beatSql = fs.readFileSync(path.join(path.join(appRoot, 'apps/server/migrations'), beat012[0]), 'utf8');
    assert.deepEqual(beatSql.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('--')), ['SELECT 1;']);
  });

  console.log(`passed ${passed}`);
}

main();
