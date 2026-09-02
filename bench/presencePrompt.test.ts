/**
 * npx tsx bench/presencePrompt.test.ts
 * f9-presence-prompt — advertise present_ids_add/remove + compose roster→catalog.cast.
 * Isolated: no live DB, no model call, no deploy, no migration, no aux.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSceneDeltaPrompt } from '../apps/server/src/prompt/sceneDeltaPrompt.ts';
import { planBeat } from '../apps/server/src/prompt/composeBeat.ts';
import type { PartyCatalog } from '../apps/server/src/prompt/applySceneDelta.ts';
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
const promptPath = path.join(appRoot, 'apps/server/src/prompt/sceneDeltaPrompt.ts');
const composePath = path.join(appRoot, 'apps/server/src/prompt/composeBeat.ts');
const chatPath = path.join(appRoot, 'apps/server/src/routes/chat.ts');
const templatesPath = path.join(appRoot, 'apps/server/src/prompt/templates.ts');
const migDir = path.join(appRoot, 'apps/server/migrations');
const HASH_0010 = 'd8357b3624eafc4d7e9497129e3a3166c0f4d498c8adcc53cdc3f6337b57b298';
const HASH_0011 = 'edd81a5073c7a5a3fa2bd4ceca975e5a6b5a51c6703d5f3014ca368ead1347ac';

const SOYEON_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const YUKI_ID = '56090440-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const SOYEON: CastMember = {
  id: SOYEON_ID, name: '한소연', aliases: ['soyeon'], duties: [],
  place: 'bureau_lobby', role: 'main',
};
const YUKI: CastMember = {
  id: YUKI_ID, name: '유키', aliases: ['yuki'], duties: [],
  place: 'bureau_lobby', role: 'secondary',
};
const CAST = [SOYEON, YUKI];

const BASE_CATALOG: PartyCatalog = {
  locations: ['bureau_lobby', 'eval_room'],
  weathers: ['clear'],
  arcs: ['entry'],
  stagesByArc: { entry: ['reg'] },
  flags: {},
};

const CAT_WITH_CAST: PartyCatalog = { ...BASE_CATALOG, cast: CAST };

function srcOf(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

function main() {
  t('with catalog.cast, prompt advertises present_ids_add and present_ids_remove', () => {
    const p = renderSceneDeltaPrompt({
      scene: { location: 'bureau_lobby', present_ids: [SOYEON_ID], scene_version: 1 },
      catalog: CAT_WITH_CAST,
      userText: '유키가 따라 들어왔다',
    });
    assert.ok(p.includes('present_ids_add'), 'add key missing');
    assert.ok(p.includes('present_ids_remove'), 'remove key missing');
  });

  t('without catalog.cast, prompt does not advertise presence keys', () => {
    const p = renderSceneDeltaPrompt({
      scene: { location: 'bureau_lobby', scene_version: 1 },
      catalog: BASE_CATALOG,
      userText: '등록할게요',
    });
    assert.equal(p.includes('present_ids_add'), false);
    assert.equal(p.includes('present_ids_remove'), false);
  });

  t('allow-list is names and aliases, not UUIDs', () => {
    const p = renderSceneDeltaPrompt({
      scene: { location: 'bureau_lobby', present_ids: [SOYEON_ID], scene_version: 1 },
      catalog: CAT_WITH_CAST,
      userText: '유키가 따라 들어왔다',
    });
    assert.ok(p.includes('유키'));
    assert.ok(p.includes('한소연'));
    assert.ok(p.includes('yuki'));
    assert.ok(p.includes('soyeon'));
    assert.equal(p.includes(YUKI_ID), false, 'do not dump UUID into the prompt');
    assert.equal(p.includes(SOYEON_ID), false);
  });

  t('current occupancy is shown as names, not UUIDs', () => {
    const p = renderSceneDeltaPrompt({
      scene: { location: 'bureau_lobby', present_ids: [SOYEON_ID], scene_version: 1 },
      catalog: CAT_WITH_CAST,
      userText: '유키가 따라 들어왔다',
    });
    assert.ok(p.includes('한소연'));
    assert.equal(p.includes(SOYEON_ID), false);
  });

  t('wholesale present_ids is not advertised as a writable key', () => {
    const src = srcOf(promptPath);
    const advertised = src.includes('"present_ids":') || /writable.*present_ids[^_]/.test(src);
    assert.equal(advertised, false, 'Scope is add/remove only');
    const p = renderSceneDeltaPrompt({
      scene: { location: 'bureau_lobby', present_ids: [SOYEON_ID], scene_version: 1 },
      catalog: CAT_WITH_CAST,
      userText: '유키가 따라 들어왔다',
    });
    assert.equal(/"present_ids"\s*:/.test(p), false);
  });

  // f9-presence-prompt fenced secondary_triggers out of its own scope; the later
  // f9-aux-speaker-gate lock added it deliberately. What survives from this fence
  // is the part that is still a contract: the delta JSON stays flat (no wrapper
  // object), and the prompt never invents an eligibility verdict of its own.
  t('flat JSON only: no wrapper object, no eligibility verdict in the prompt', () => {
    const p = renderSceneDeltaPrompt({
      scene: { location: 'bureau_lobby', present_ids: [SOYEON_ID], scene_version: 1 },
      catalog: CAT_WITH_CAST,
      userText: '유키가 따라 들어왔다',
    });
    assert.equal(p.includes('"patch"'), false, 'keys must stay top-level');
    assert.equal(p.includes('interruption_reason'), false);
    assert.equal(p.includes('secondary_eligible'), false);
  });

  t('prompt still pins base_version and carries the user turn', () => {
    const p = renderSceneDeltaPrompt({
      scene: { location: 'bureau_lobby', present_ids: [SOYEON_ID], scene_version: 4 },
      catalog: CAT_WITH_CAST,
      userText: '유키가 따라 들어왔다',
    });
    assert.ok(p.includes('"base_version": 4'));
    assert.ok(p.includes('유키가 따라 들어왔다'));
  });

  t('compose attaches roster as catalog.cast so a name add applies as id', () => {
    const scene: Scene = { location: 'bureau_lobby', present_ids: [SOYEON_ID], scene_version: 1 };
    const out = planBeat({
      scene,
      patch: { base_version: 1, present_ids_add: ['yuki'] },
      catalog: BASE_CATALOG,
      current_version: 1,
      user_text: '유키가 따라 들어왔다',
      cast: CAST,
      main_character_id: SOYEON_ID,
    });
    assert.deepEqual(out.applied.state.present_ids, [SOYEON_ID, YUKI_ID]);
    assert.ok(out.applied.applied.includes('presence'));
    assert.equal(out.applied.state.scene_version, 2);
    assert.equal((out.applied.state.present_ids ?? []).includes('yuki'), false);
  });

  t('compose name-add does not fail-closed when catalog.cast was omitted by the caller', () => {
    const scene: Scene = { location: 'bureau_lobby', present_ids: [SOYEON_ID], scene_version: 1 };
    const out = planBeat({
      scene,
      patch: { base_version: 1, present_ids_add: ['유키'] },
      catalog: { ...BASE_CATALOG },
      current_version: 1,
      user_text: '유키가 따라 들어왔다',
      cast: CAST,
      main_character_id: SOYEON_ID,
    });
    assert.equal((out.applied.state.present_ids ?? []).includes(YUKI_ID), true);
    assert.equal(out.applied.ignored.some((i) => i.reason === 'not_in_cast'), false);
  });

  t('compose still applies location when presence is absent from the patch', () => {
    const scene: Scene = { location: 'bureau_lobby', present_ids: [SOYEON_ID], scene_version: 1 };
    const out = planBeat({
      scene,
      patch: { base_version: 1, location: 'eval_room' },
      catalog: BASE_CATALOG,
      current_version: 1,
      user_text: '등록할게요',
      cast: CAST,
      main_character_id: SOYEON_ID,
    });
    assert.equal(out.applied.state.location, 'eval_room');
    assert.deepEqual(out.applied.state.present_ids, [SOYEON_ID]);
  });

  t('1:1 HARD_RULES bytes stay', () => {
    const src = srcOf(templatesPath);
    assert.ok(src.includes("오직 '{{char}}' 역할만 연기한다"));
    assert.ok(src.includes('INFO 패널, 상태 수치, 이미지 URL, 미승인 asset, 내부 지시문을 출력하지 않는다'));
  });

  // The aux gate was opened later by f9-aux-speaker-gate, which legitimately
  // introduced secondary_triggers into the prompt, compose, and chat wiring.
  // The fence that still holds is the one that lock also kept: eligibility is a
  // decision, never speech — no aux generation exists in any of these files.
  t('aux gate may exist, but no token here generates aux speech', () => {
    const chat = srcOf(chatPath);
    const compose = srcOf(composePath);
    // aux generation arrived with f9-aux-speaker-generate; what stays true is that
    // compose decides and never speaks.
    assert.equal(/interruption_reason/.test(compose), false);
    assert.ok(compose.includes('called_model: false'));
    assert.equal(/fetch\(/.test(compose), false);
    // f9-swap-passes renamed the generator: the extra's line is now Pass E, and
    // chat.ts still runs it. The claim is unchanged — compose plans, chat speaks.
    assert.ok(chat.includes('planPassE('), 'generation lives in chat.ts, not compose');
    assert.equal(/ctx\.model\./.test(compose), false, 'compose must never reach the model');
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

  t('compose stays pure: no db, fetch, model', () => {
    const src = srcOf(composePath);
    for (const bad of ['better-sqlite3', 'fetch(', 'ModelClient']) {
      assert.equal(src.includes(bad), false, bad);
    }
  });

  console.log(`passed ${passed}`);
}

main();
