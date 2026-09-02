/** npx tsx bench/storyCatalogWrite.test.ts
 * f9-catalog-write (S1) — the write schema must mirror what parseSceneCatalog reads.
 *
 * Two defects this pins:
 *   1. the six keys the parser reads (default_focus, owner_duty, outfits, emotions,
 *      stages, duties) were stripped by the Zod schema, so a catalog could be
 *      parsed but never authored through the API;
 *   2. PUT /api/stories/:id is a full replace and scene_catalog carried an
 *      empty-catalog default, so any client that does not model catalogs —
 *      StoryEditor sends {name, tagline, setting, minor_cast} — erased it on save.
 *
 * Isolated: temp DB only. No systemd, no live DB, no model call, no live generate.
 * Helper/bench PASS is not a product PASS (helper-vs-live-contract).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openDb } from '../apps/server/src/db/index.ts';
import { storyRoutes } from '../apps/server/src/routes/stories.ts';
import { catalogFromStory, parseSceneCatalog } from '../apps/server/src/prompt/sceneCatalog.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

/** The Notes §7 classroom catalog, in the shape a client would POST. */
const SCHOOL = {
  places: [
    { id: '교실', name: '1-3 교실', tags: ['indoor'], default_focus: 'hayeon' },
    { id: '복도', default_focus: 'mir' },
    { id: '사무실' },
    { id: '경비실' },
  ],
  weathers: ['맑음', '흐림'],
  arcs: ['entry'],
  stagesByArc: { entry: ['reg', 'class'] },
  flags: { rulebreak: { owner_stage: 'reg', owner_duty: '교칙' } },
  outfits: ['교복', '체육복'],
  emotions: { 평온: 0, 화남: 1, 놀람: 2 },
  stages: { class: { closer_duty: '수업' } },
  duties: { 교칙: { slot: '질서' }, 수업: { slot: '질서' } },
};

/** The exact body StoryEditor.save() sends — note the absent scene_catalog. */
const STORY_EDITOR_BODY = {
  name: '교실 (편집됨)',
  tagline: '',
  setting: '학교',
  minor_cast: [{ name: '학생들', note: '' }],
};

/** The live 26614525 catalog, byte for byte, as a round-trip witness. */
const LIVE_CATALOG_JSON =
  '{"places":[{"id":"bureau_lobby","name":"로비","tags":["reception"]},{"id":"evaluation_room","name":"측정실","tags":["scan"]},{"id":"academy_hall","name":"아카데미 홀","tags":["ceremony"]}],"weathers":["cloudy","clear"],"arcs":["entry"],"stagesByArc":{"entry":["reg","scan","done"]},"flags":{"cand":{"owner_stage":"reg"},"reg_ok":{"owner_stage":"reg"},"scanned":{"owner_stage":"scan"}}}';

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-catalog-write-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));

  const ctx = {
    db,
    model: {} as Ctx['model'],
    queue: { activeList: [] } as unknown as Ctx['queue'],
    log: console as unknown as Ctx['log'],
    resolvedModel: () => 'm',
    setResolvedModel: () => {},
    health: async () => ({ ok: true, checkedAt: 't', latencyMs: 0, models: [] }),
  } as Ctx;

  const app = Fastify({ logger: false });
  await app.register(storyRoutes(ctx));

  const post = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/stories', headers: { 'content-type': 'application/json' }, payload: payload as object });
  const put = (id: string, payload: unknown) =>
    app.inject({ method: 'PUT', url: `/api/stories/${id}`, headers: { 'content-type': 'application/json' }, payload: payload as object });
  const get = (id: string) => app.inject({ method: 'GET', url: `/api/stories/${id}` });
  const stored = (id: string): string =>
    (db.prepare('SELECT scene_catalog FROM stories WHERE id = ?').get(id) as { scene_catalog: string }).scene_catalog;

  // ── 1. the six keys survive POST → stored JSON → parser ────────────────────
  let schoolId = '';
  await t('the six parser-read keys survive POST (they were all stripped before)', async () => {
    const res = await post({ name: '교실', setting: '학교', scene_catalog: SCHOOL });
    assert.equal(res.statusCode, 201, res.body);
    schoolId = JSON.parse(res.body).id as string;

    const cat = catalogFromStory(stored(schoolId));
    assert.equal(cat.places.find((p) => p.id === '교실')?.default_focus, 'hayeon', 'default_focus');
    assert.equal(cat.flags.rulebreak?.owner_duty, '교칙', 'owner_duty');
    assert.deepEqual(cat.outfits, ['교복', '체육복'], 'outfits');
    assert.deepEqual(cat.emotions, { 평온: 0, 화남: 1, 놀람: 2 }, 'emotions');
    assert.equal(cat.stages.class?.closer_duty, '수업', 'closer_duty');
    assert.deepEqual(cat.dutySlots, { 교칙: '질서', 수업: '질서' }, 'dutySlots');
  });

  await t('the stored catalog is the shape approveExtras is benched against', () => {
    // approveExtras.test.ts CAT: flags.<k>.owner_duty opens a slot, stages.<id>.closer_duty closes one.
    const cat = catalogFromStory(stored(schoolId));
    assert.equal(typeof cat.flags.rulebreak?.owner_duty, 'string');
    assert.equal(typeof cat.stages.class?.closer_duty, 'string');
    assert.equal(cat.dutySlots['교칙'], cat.dutySlots['수업'], 'same function slot → one line, not two');
    assert.ok(cat.locations.includes('교실'), 'locations is still the place-id list');
  });

  // ── 2. omission preserves, explicit {} clears ─────────────────────────────
  await t('a PUT with the StoryEditor body preserves the catalog', async () => {
    const before = stored(schoolId);
    const res = await put(schoolId, STORY_EDITOR_BODY);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(JSON.parse(res.body).name, '교실 (편집됨)', 'the fields it did send were written');
    assert.equal(stored(schoolId), before, 'scene_catalog is byte-identical after the save');
  });

  await t('the preserved catalog still parses to the same six keys', () => {
    const cat = catalogFromStory(stored(schoolId));
    assert.equal(cat.places.find((p) => p.id === '교실')?.default_focus, 'hayeon');
    assert.equal(cat.flags.rulebreak?.owner_duty, '교칙');
    assert.deepEqual(cat.outfits, ['교복', '체육복']);
    assert.equal(cat.stages.class?.closer_duty, '수업');
    assert.deepEqual(cat.dutySlots, { 교칙: '질서', 수업: '질서' });
  });

  await t('an explicit {} clears it — omission and {} are different requests', async () => {
    const res = await post({ name: '지울 것', scene_catalog: SCHOOL });
    const id = JSON.parse(res.body).id as string;
    assert.notEqual(catalogFromStory(stored(id)).outfits.length, 0);

    const cleared = await put(id, { ...STORY_EDITOR_BODY, scene_catalog: {} });
    assert.equal(cleared.statusCode, 200, cleared.body);
    const cat = catalogFromStory(stored(id));
    assert.deepEqual(cat.places, []);
    assert.deepEqual(cat.outfits, []);
    assert.deepEqual(cat.emotions, {});
    assert.deepEqual(cat.stages, {});
    assert.deepEqual(cat.dutySlots, {});
  });

  // ── 3. GET → PUT round-trip (storyOut renames duties → dutySlots) ─────────
  await t('GET → PUT of the returned catalog is lossless', async () => {
    const one = JSON.parse((await get(schoolId)).body) as { scene_catalog: unknown };
    // storyOut returns the PARSED shape, so the duty map comes back as `dutySlots`.
    assert.ok('dutySlots' in (one.scene_catalog as object), 'GET returns dutySlots, not duties');

    const res = await put(schoolId, { ...STORY_EDITOR_BODY, scene_catalog: one.scene_catalog });
    assert.equal(res.statusCode, 200, res.body);
    const cat = catalogFromStory(stored(schoolId));
    assert.deepEqual(cat.dutySlots, { 교칙: '질서', 수업: '질서' }, 'duty slots survive the alias round-trip');
    assert.equal(cat.places.find((p) => p.id === '교실')?.default_focus, 'hayeon');
    assert.equal(cat.stages.class?.closer_duty, '수업');
    assert.equal('duties' in JSON.parse(stored(schoolId)), true, 'stored under one spelling');
    assert.equal('dutySlots' in JSON.parse(stored(schoolId)), false, 'the alias is not stored');
  });

  // ── 4. damaged input: reject, never partially store ───────────────────────
  await t('damaged catalogs are rejected whole — no partial write', async () => {
    const created = await post({ name: '온전한 것', scene_catalog: SCHOOL });
    const id = JSON.parse(created.body).id as string;
    const before = stored(id);

    const bad: unknown[] = [
      { ...SCHOOL, emotions: { 화남: -1 } },
      { ...SCHOOL, emotions: { 화남: 1.5 } },
      { ...SCHOOL, emotions: { 화남: '1' } },
      { ...SCHOOL, outfits: '교복' },
      { ...SCHOOL, stages: [] },
      { ...SCHOOL, places: [{ name: 'id 없음' }] },
      'not an object',
    ];
    for (const b of bad) {
      const res = await put(id, { ...STORY_EDITOR_BODY, scene_catalog: b });
      assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(b).slice(0, 60)}`);
      assert.equal(stored(id), before, 'a rejected request wrote nothing');
    }
  });

  await t('a damaged STORED catalog still degrades to empty, not a throw', () => {
    const id = 'damaged-row';
    db.prepare(
      `INSERT INTO stories (id, name, tagline, setting, minor_cast, archived, created_at, updated_at, scene_catalog)
       VALUES (?, ?, '', '', '[]', 0, 't', 't', ?)`,
    ).run(id, '손상', '{not json');
    const cat = parseSceneCatalog(stored(id));
    assert.deepEqual(cat.places, []);
    assert.deepEqual(cat.dutySlots, {});
  });

  // ── 5. the live catalog is not disturbed by the widening ──────────────────
  await t('the live 26614525 catalog round-trips unchanged in meaning', async () => {
    const live = parseSceneCatalog(LIVE_CATALOG_JSON);
    const res = await post({ name: 'live-shape', scene_catalog: JSON.parse(LIVE_CATALOG_JSON) });
    assert.equal(res.statusCode, 201, res.body);
    const id = JSON.parse(res.body).id as string;
    const after = parseSceneCatalog(stored(id));

    assert.deepEqual(after.places, live.places);
    assert.deepEqual(after.weathers, live.weathers);
    assert.deepEqual(after.arcs, live.arcs);
    assert.deepEqual(after.stagesByArc, live.stagesByArc);
    assert.deepEqual(after.flags, live.flags);
    // The new keys are present and empty — they add nothing to a catalog that had none.
    assert.deepEqual(after.outfits, []);
    assert.deepEqual(after.emotions, {});
    assert.deepEqual(after.stages, {});
    assert.deepEqual(after.dutySlots, {});
  });

  await t('a story created with no scene_catalog still gets the empty one', async () => {
    const res = await post({ name: '카탈로그 없음' });
    assert.equal(res.statusCode, 201, res.body);
    const id = JSON.parse(res.body).id as string;
    const raw = JSON.parse(stored(id)) as Record<string, unknown>;
    assert.deepEqual(raw.places, []);
    assert.deepEqual(raw.flags, {});
    assert.deepEqual(raw.duties, {});
  });

  // ── 6. fences: one parser, and the beat engine stays shut ─────────────────
  await t('stories.ts has no second catalog interpreter', () => {
    const src = fs.readFileSync('apps/server/src/routes/stories.ts', 'utf8');
    const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.match(body, /parseSceneCatalog/, 'still parses through the one parser');
    assert.equal(/JSON\.parse\(\s*s\.scene_catalog/.test(body), false, 'no hand-rolled catalog parse');
    assert.equal(/dutySlots/.test(body) && /duties/.test(body), true, 'the alias fold lives here');
  });

  await t('S1 touched no beat-engine module', () => {
    const locked = [
      'resolveFocus.ts', 'eligibleExtras.ts', 'approveExtras.ts', 'ambient.ts',
      'composeBeat.ts', 'passes.ts', 'renderBeat.ts',
    ];
    for (const f of locked) {
      const p = path.join('apps/server/src/prompt', f);
      assert.ok(fs.existsSync(p), `${f} must still exist`);
      const src = fs.readFileSync(p, 'utf8');
      assert.equal(/f9-catalog-write/.test(src), false, `${f} carries no S1 edit`);
    }
  });

  console.log(`passed ${passed}`);
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
