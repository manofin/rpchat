/**
 * npx tsx bench/presenceIdResolve.test.ts
 * f9-presence-id-resolve — apply-path name→id + cast allow-list.
 * Scope: apply only. No prompt, no aux gate, no aux generate, no tags_json.
 * Isolated: no live DB, no model call, no deploy, no migration.
 *
 * Fixtures use UUID ids. Name/alias are Korean and English so this bench
 * cannot hide the occupancy-garbage trap that id:'yuki' hid.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCastToken } from '../apps/server/src/prompt/presence.ts';
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
const presencePath = path.join(appRoot, 'apps/server/src/prompt/presence.ts');
const applyPath = path.join(appRoot, 'apps/server/src/prompt/applySceneDelta.ts');
const chatPath = path.join(appRoot, 'apps/server/src/routes/chat.ts');
const migDir = path.join(appRoot, 'apps/server/migrations');
const HASH_0010 = 'd8357b3624eafc4d7e9497129e3a3166c0f4d498c8adcc53cdc3f6337b57b298';
const HASH_0011 = 'edd81a5073c7a5a3fa2bd4ceca975e5a6b5a51c6703d5f3014ca368ead1347ac';

const SOYEON_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const YUKI_ID = '56090440-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXTRA_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const SOYEON: CastMember = {
  id: SOYEON_ID, name: '한소연', aliases: ['soyeon'], duties: [],
  place: 'bureau_lobby', role: 'main',
};
const YUKI: CastMember = {
  id: YUKI_ID, name: '유키', aliases: ['yuki'], duties: [],
  place: 'bureau_lobby', role: 'secondary',
};
const EXTRA: CastMember = {
  id: EXTRA_ID, name: '유키', aliases: ['shadow'], duties: [],
  place: 'bureau_lobby', role: 'secondary',
};

const CATALOG: PartyCatalog = {
  weathers: ['clear'],
  locations: ['bureau_lobby', 'evaluation_room'],
  arcs: ['entry'],
  stagesByArc: { entry: ['reg'] },
  flags: {},
  cast: [SOYEON, YUKI],
};

const NO_CAST: PartyCatalog = {
  weathers: ['clear'],
  locations: ['bureau_lobby', 'evaluation_room'],
  arcs: ['entry'],
  stagesByArc: { entry: ['reg'] },
  flags: {},
};

function occupancyUnchanged(before: Scene, after: Scene) {
  assert.deepEqual(after.present_ids, before.present_ids);
}

function main() {
  t('resolveCastToken: exact id wins', () => {
    assert.equal(resolveCastToken(YUKI_ID, [SOYEON, YUKI]), YUKI_ID);
  });

  t('resolveCastToken: name then alias', () => {
    assert.equal(resolveCastToken('유키', [SOYEON, YUKI]), YUKI_ID);
    assert.equal(resolveCastToken('yuki', [SOYEON, YUKI]), YUKI_ID);
    assert.equal(resolveCastToken('한소연', [SOYEON, YUKI]), SOYEON_ID);
    assert.equal(resolveCastToken('soyeon', [SOYEON, YUKI]), SOYEON_ID);
  });

  t('resolveCastToken: 0 matches or 2+ matches drop the token', () => {
    assert.equal(resolveCastToken('security-team', [SOYEON, YUKI]), null);
    assert.equal(resolveCastToken('Yuki', [SOYEON, YUKI]), null);
    assert.equal(resolveCastToken('유키', [SOYEON, YUKI, EXTRA]), null);
  });

  t('resolveCastToken: UUID not in cast is rejected', () => {
    assert.equal(resolveCastToken('dddddddd-dddd-4ddd-8ddd-dddddddddddd', [SOYEON, YUKI]), null);
  });

  t('name add stores the member id, not the token', () => {
    const scene: Scene = { location: 'evaluation_room', present_ids: [SOYEON_ID] };
    const out = applySceneDelta(
      scene,
      { base_version: 0, present_ids_add: ['yuki'] },
      CATALOG,
      0,
    );
    assert.equal(out.discarded, false);
    assert.deepEqual(out.state.present_ids, [SOYEON_ID, YUKI_ID]);
    assert.ok(out.applied.includes('presence'));
    assert.equal(out.state.scene_version, 1);
    assert.equal(out.ignored.length, 0);
  });

  t('isPresent(member.id) is true after a name add', () => {
    const scene: Scene = { location: 'evaluation_room', present_ids: [SOYEON_ID] };
    const out = applySceneDelta(
      scene,
      { base_version: 0, present_ids_add: ['유키'] },
      CATALOG,
      0,
    );
    assert.equal((out.state.present_ids ?? []).includes(YUKI_ID), true);
    assert.equal((out.state.present_ids ?? []).includes('유키'), false);
  });

  t('unknown tokens are ignored per item; occupancy and version stay', () => {
    const scene: Scene = { location: 'bureau_lobby', present_ids: [SOYEON_ID] };
    const out = applySceneDelta(
      scene,
      { base_version: 0, present_ids_add: ['security-team'] },
      CATALOG,
      0,
    );
    occupancyUnchanged(scene, out.state);
    assert.equal(out.applied.includes('presence'), false);
    assert.equal(out.state.scene_version, undefined);
    assert.deepEqual(out.ignored, [
      { key: 'present_ids_add.security-team', reason: 'not_in_cast' },
    ]);
  });

  t('mixed add: resolved id applied, unknowns ignored', () => {
    const scene: Scene = { location: 'bureau_lobby', present_ids: [SOYEON_ID] };
    const out = applySceneDelta(
      scene,
      { base_version: 0, present_ids_add: ['yuki', 'john', 'admin'] },
      CATALOG,
      0,
    );
    assert.deepEqual(out.state.present_ids, [SOYEON_ID, YUKI_ID]);
    assert.ok(out.applied.includes('presence'));
    assert.equal(out.state.scene_version, 1);
    const keys = out.ignored.map((i) => i.key).sort();
    assert.deepEqual(keys, ['present_ids_add.admin', 'present_ids_add.john']);
    for (const row of out.ignored) assert.equal(row.reason, 'not_in_cast');
  });

  t('present_ids_remove by name drops the id', () => {
    const scene: Scene = { location: 'bureau_lobby', present_ids: [SOYEON_ID, YUKI_ID] };
    const out = applySceneDelta(
      scene,
      { base_version: 0, present_ids_remove: ['yuki'] },
      CATALOG,
      0,
    );
    assert.deepEqual(out.state.present_ids, [SOYEON_ID]);
    assert.ok(out.applied.includes('presence'));
  });

  t('wholesale present_ids keeps resolved ids and drops unknown tokens', () => {
    const scene: Scene = { location: 'bureau_lobby', present_ids: [SOYEON_ID] };
    const out = applySceneDelta(
      scene,
      { base_version: 0, present_ids: ['yuki', 'john'] },
      CATALOG,
      0,
    );
    assert.deepEqual(out.state.present_ids, [YUKI_ID]);
    assert.ok(out.ignored.some((i) => i.key === 'present_ids.john' && i.reason === 'not_in_cast'));
  });

  t('all-unknown wholesale present_ids does not wipe occupancy', () => {
    const scene: Scene = { location: 'bureau_lobby', present_ids: [SOYEON_ID] };
    const out = applySceneDelta(
      scene,
      { base_version: 0, present_ids: ['john', 'admin'] },
      CATALOG,
      0,
    );
    occupancyUnchanged(scene, out.state);
    assert.equal(out.applied.includes('presence'), false);
    assert.equal(out.state.scene_version, undefined);
  });

  t('explicit empty present_ids still means nobody', () => {
    const scene: Scene = { location: 'bureau_lobby', present_ids: [SOYEON_ID] };
    const out = applySceneDelta(scene, { base_version: 0, present_ids: [] }, CATALOG, 0);
    assert.deepEqual(out.state.present_ids, []);
    assert.ok(out.applied.includes('presence'));
  });

  t('missing catalog.cast fail-closes every presence key', () => {
    const scene: Scene = { location: 'bureau_lobby', present_ids: [SOYEON_ID] };
    const out = applySceneDelta(
      scene,
      { base_version: 0, present_ids_add: ['yuki'] },
      NO_CAST,
      0,
    );
    occupancyUnchanged(scene, out.state);
    assert.equal(out.applied.includes('presence'), false);
    assert.equal(out.state.scene_version, undefined);
    assert.deepEqual(out.ignored, [{ key: 'present_ids_add', reason: 'not_in_cast' }]);
  });

  t('garbage token does not declare occupancy on an undeclared scene', () => {
    const scene: Scene = { location: 'bureau_lobby' };
    const out = applySceneDelta(
      scene,
      { base_version: 0, present_ids_add: ['yuki'] },
      NO_CAST,
      0,
    );
    assert.equal(out.state.present_ids, undefined);
    assert.equal(out.applied.includes('presence'), false);
  });

  t('location still applies when presence tokens all fail (A-6)', () => {
    const scene: Scene = { location: 'bureau_lobby', present_ids: [SOYEON_ID] };
    const out = applySceneDelta(
      scene,
      { base_version: 0, location: 'evaluation_room', present_ids_add: ['john'] },
      CATALOG,
      0,
    );
    assert.equal(out.state.location, 'evaluation_room');
    occupancyUnchanged(scene, out.state);
    assert.ok(out.applied.includes('location'));
    assert.equal(out.applied.includes('presence'), false);
    assert.equal(out.state.scene_version, 1);
  });

  t('applySceneDelta still does not import pickSpeaker', () => {
    const src = fs.readFileSync(applyPath, 'utf8');
    assert.equal(/pickSpeaker/.test(src), false);
  });

  t('id-resolve product still does not import the prompt', () => {
    const src = fs.readFileSync(presencePath, 'utf8');
    assert.equal(src.includes('sceneDeltaPrompt'), false);
    assert.equal(src.includes('renderSceneDeltaPrompt'), false);
  });

  t('this token does not open aux gate or generate', () => {
    const chat = fs.readFileSync(chatPath, 'utf8');
    const pres = fs.readFileSync(presencePath, 'utf8');
    assert.equal(chat.includes('secondary_triggers'), false);
    assert.equal(pres.includes('secondary_triggers'), false);
    assert.equal(pres.includes('interruption_reason'), false);
    assert.equal(pres.includes('secondary_eligible'), false);
  });

  t('0010 and 0011 unchanged; no 0012', () => {
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

  t('presence stays pure', () => {
    const src = fs.readFileSync(presencePath, 'utf8');
    for (const bad of ['better-sqlite3', 'fetch(', 'ModelClient', "from '../routes"]) {
      assert.equal(src.includes(bad), false, bad);
    }
  });

  console.log(`passed ${passed}`);
}

main();
