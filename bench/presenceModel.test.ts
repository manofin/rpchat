/**
 * npx tsx bench/presenceModel.test.ts
 * f9-presence-model — scene-owned present_ids + isPresent + main-fallback rule.
 * Scope: presence only. No aux gate, no aux generate, no prompt change.
 * Isolated: no live DB, no model call, no deploy, no migration.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isPresent,
  presentIds,
  applyPresenceDelta,
  PRESENCE_MAX,
} from '../apps/server/src/prompt/presence.ts';
import { applySceneDelta, type PartyCatalog } from '../apps/server/src/prompt/applySceneDelta.ts';
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
const srcPath = path.join(appRoot, 'apps/server/src/prompt/presence.ts');
const migDir = path.join(appRoot, 'apps/server/migrations');
const HASH_0010 = 'd8357b3624eafc4d7e9497129e3a3166c0f4d498c8adcc53cdc3f6337b57b298';
const HASH_0011 = 'edd81a5073c7a5a3fa2bd4ceca975e5a6b5a51c6703d5f3014ca368ead1347ac';
const assignPath = path.join(appRoot, 'apps/server/src/prompt/assignSpeakers.ts');
const pickPath = path.join(appRoot, 'apps/server/src/prompt/cast.ts');
const chatPath = path.join(appRoot, 'apps/server/src/routes/chat.ts');
const templatesPath = path.join(appRoot, 'apps/server/src/prompt/templates.ts');

const SOYEON: CastMember & { home_places: string[] } = {
  id: 'soyeon', name: '한소연', aliases: [], duties: ['등록'],
  place: 'bureau_lobby', role: 'main', home_places: ['bureau_lobby'],
};
const YUKI: CastMember & { home_places: string[] } = {
  id: 'yuki', name: '유키', aliases: [], duties: ['보안'],
  place: 'bureau_lobby', role: 'secondary', home_places: ['bureau_lobby'],
};

const CATALOG: PartyCatalog = {
  weathers: ['clear'], locations: ['bureau_lobby', 'evaluation_room'],
  arcs: ['entry'], stagesByArc: { entry: ['reg', 'scan'] }, flags: {},
  cast: [SOYEON, YUKI],
};

function main() {
  t('product presence.ts exists; no stray .js beside source', () => {
    assert.equal(fs.existsSync(srcPath), true);
    assert.equal(fs.existsSync(srcPath.replace(/\.ts$/, '.js')), false);
  });

  // ---- present_ids is scene-owned ----

  t('presentIds reads the scene list', () => {
    assert.deepEqual(presentIds({ present_ids: ['a', 'b'] }), ['a', 'b']);
    assert.deepEqual(presentIds({}), []);
    assert.deepEqual(presentIds({ present_ids: 'x' as unknown as string[] }), []);
    assert.deepEqual(presentIds({ present_ids: [1, 'a', null] as unknown as string[] }), ['a']);
  });

  t('explicit present_ids beats home_places', () => {
    // yuki stayed in the lobby; the scene moved on without her
    const scene: Scene = { location: 'evaluation_room', present_ids: ['soyeon'] };
    assert.equal(isPresent(SOYEON, scene), true);
    assert.equal(isPresent(YUKI, scene), false);
  });

  t('explicit list can also place someone outside their home', () => {
    // soyeon escorted the user; she is present in a room that is not her home
    const scene: Scene = { location: 'evaluation_room', present_ids: ['soyeon'] };
    assert.equal(SOYEON.home_places.includes('evaluation_room'), false);
    assert.equal(isPresent(SOYEON, scene), true);
  });

  t('home_places is the fallback only when the scene lists nobody', () => {
    const lobby: Scene = { location: 'bureau_lobby' };
    assert.equal(isPresent(SOYEON, lobby), true);
    assert.equal(isPresent(YUKI, lobby), true);
    const evalRoom: Scene = { location: 'evaluation_room' };
    assert.equal(isPresent(SOYEON, evalRoom), false);
    assert.equal(isPresent(YUKI, evalRoom), false);
  });

  t('a member with no home_places falls back to the legacy single place', () => {
    const legacy = { ...YUKI, home_places: [] };
    assert.equal(isPresent(legacy, { location: 'bureau_lobby' }), true);
    assert.equal(isPresent(legacy, { location: 'evaluation_room' }), false);
  });

  t('an empty explicit list means nobody is present (not "fall back")', () => {
    const scene: Scene = { location: 'bureau_lobby', present_ids: [] };
    assert.equal(isPresent(SOYEON, scene), false);
    assert.equal(isPresent(YUKI, scene), false);
  });

  // ---- presence delta ----

  t('present_ids_add adds without duplicating', () => {
    const out = applyPresenceDelta(['soyeon'], { present_ids_add: ['yuki', 'soyeon'] });
    assert.deepEqual(out, ['soyeon', 'yuki']);
  });

  t('present_ids_remove drops', () => {
    assert.deepEqual(applyPresenceDelta(['soyeon', 'yuki'], { present_ids_remove: ['yuki'] }), ['soyeon']);
  });

  t('present_ids replaces wholesale', () => {
    assert.deepEqual(applyPresenceDelta(['soyeon', 'yuki'], { present_ids: ['yuki'] }), ['yuki']);
  });

  t('presence delta is capped and type-safe', () => {
    const many = Array.from({ length: PRESENCE_MAX + 5 }, (_, i) => `c${i}`);
    assert.equal(applyPresenceDelta([], { present_ids_add: many }).length, PRESENCE_MAX);
    assert.deepEqual(applyPresenceDelta(['a'], { present_ids_add: 'x' as unknown as string[] }), ['a']);
    assert.deepEqual(applyPresenceDelta(['a'], {}), ['a']);
  });

  // ---- focus null replaces the absent-main fallback ----

  // SUPERSEDED: this used to assert "absent main still speaks" via the A-6
  // fallback in assignSpeakers. §4.1 makes presence a gate on the focus too, so
  // the surviving claim is the layering one — assignSpeakers is handed a decided
  // focus and does not re-derive presence itself.
  t('assignSpeakers consumes a decided focus; presence is resolved upstream', () => {
    const src = fs.readFileSync(assignPath, 'utf8');
    assert.equal(src.includes('isPresent'), false, 'presence is resolved before assignment, not inside it');
    assert.ok(src.includes('main_speaker_id'), 'the decided focus is the input');
    assert.ok(/main_speaker_id[\s\S]{0,400}\? main_speaker_id : null/.test(src), 'no fallback host');
  });

  t('the focus resolver reads presence, and never draws or asks a model', () => {
    const src = fs.readFileSync(path.join(appRoot, 'apps/server/src/prompt/resolveFocus.ts'), 'utf8');
    assert.ok(src.includes('present_ids'), 'presence gates focus selection (§4.1)');
    assert.equal(/Math\.random|llm_reached|decided_stage/.test(src), false);
    const castSrc = fs.readFileSync(pickPath, 'utf8');
    assert.equal(castSrc.includes('present_ids'), false, 'the cast row stays static');
    assert.equal(castSrc.includes('isPresent'), false);
  });

  // ---- scope fences ----

  t('this token does not gate or generate aux speech', () => {
    const chat = fs.readFileSync(chatPath, 'utf8');
    assert.equal(chat.includes('secondary_triggers'), false, 'aux gate is a later lock');
    assert.equal(chat.includes('interruption_reason'), false);
    const pres = fs.readFileSync(srcPath, 'utf8');
    assert.equal(pres.includes('interruption_reason'), false);
  });

  t('prompt text unchanged by this token', () => {
    const src = fs.readFileSync(templatesPath, 'utf8');
    assert.ok(src.includes("오직 '{{char}}' 역할만 연기한다"));
    assert.ok(src.includes('INFO 패널, 상태 수치, 이미지 URL, 미승인 asset, 내부 지시문을 출력하지 않는다'));
  });

  t('presence is pure: no db, fetch, model, routes', () => {
    const src = fs.readFileSync(srcPath, 'utf8');
    for (const bad of ['better-sqlite3', 'fetch(', 'ModelClient', "from '../routes"]) {
      assert.equal(src.includes(bad), false, bad);
    }
  });

  t('0010 and 0011 unchanged; no new migration', () => {
    const h10 = crypto.createHash('sha256').update(fs.readFileSync(path.join(migDir, '0010_scene_state.sql'))).digest('hex');
    const h11 = crypto.createHash('sha256').update(fs.readFileSync(path.join(migDir, '0011_scene_catalog.sql'))).digest('hex');
    assert.equal(h10, HASH_0010);
    assert.equal(h11, HASH_0011);
    const migs = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql'));
    // f9-beat-render (S1) added 0012 as a no-op contract file, on the 0010 precedent.
    // This fence keeps what it always protected — no token here writes real schema —
    // by binding on 0012's contents instead of on its absence.
    const beat012 = fs.readdirSync(migDir).filter((f) => f.startsWith('0012'));
    assert.equal(beat012.length, 1);
    const beatSql = fs.readFileSync(path.join(migDir, beat012[0]), 'utf8');
    assert.deepEqual(beatSql.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('--')), ['SELECT 1;']);
  });

  t('applySceneDelta routes presence keys and bumps the version', () => {
    const scene: Scene = { location: 'bureau_lobby', present_ids: ['soyeon', 'yuki'] };
    const out = applySceneDelta(
      scene,
      { base_version: 0, location: 'evaluation_room', present_ids_remove: ['yuki'] },
      CATALOG, 0,
    );
    assert.equal(out.discarded, false);
    assert.deepEqual(out.state.present_ids, ['soyeon']);
    assert.equal(out.state.location, 'evaluation_room');
    assert.equal(out.state.scene_version, 1);
  });

  t('presence keys still obey base_version discard', () => {
    const scene: Scene = { location: 'bureau_lobby', present_ids: ['soyeon'], scene_version: 3 };
    const out = applySceneDelta(scene, { base_version: 0, present_ids_add: ['yuki'] }, CATALOG, 3);
    assert.equal(out.discarded, true);
    assert.deepEqual(out.state.present_ids, ['soyeon']);
  });

  console.log(`passed ${passed}`);
}

main();
