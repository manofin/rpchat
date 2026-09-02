/**
 * npx tsx bench/sceneCatalog.test.ts
 * f9-place-catalog — Story-owned place/arc/stage catalog (0011) + 3-layer split.
 * Isolated: temp DBs only. No live DB, no model call, no deploy.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  catalogFromStory,
  parseSceneCatalog,
  homePlacesOf,
  SCENE_CATALOG_EMPTY,
} from '../apps/server/src/prompt/sceneCatalog.ts';
import { parsePartyTags, castFromCharacters } from '../apps/server/src/prompt/tagsCatalog.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(dir, '..');
const srcPath = path.join(appRoot, 'apps/server/src/prompt/sceneCatalog.ts');
const migDir = path.join(appRoot, 'apps/server/migrations');
const mig011 = path.join(migDir, '0011_scene_catalog.sql');
const mig010 = path.join(migDir, '0010_scene_state.sql');
const HASH_0010 = 'd8357b3624eafc4d7e9497129e3a3166c0f4d498c8adcc53cdc3f6337b57b298';
const chatPath = path.join(appRoot, 'apps/server/src/routes/chat.ts');
const pickPath = path.join(appRoot, 'apps/server/src/prompt/cast.ts');

const CAT = JSON.stringify({
  places: [
    { id: 'bureau_lobby', name: '로비', tags: ['reception'] },
    { id: 'evaluation_room', name: '측정실', tags: ['scan'] },
    { id: 'academy_hall', name: '아카데미 홀' },
  ],
  weathers: ['cloudy', 'clear'],
  arcs: ['entry'],
  stagesByArc: { entry: ['reg', 'scan'] },
  flags: { cand: { owner_stage: 'reg' } },
});

function main() {
  t('product sceneCatalog.ts exists; no stray .js beside source', () => {
    assert.equal(fs.existsSync(srcPath), true);
    assert.equal(fs.existsSync(srcPath.replace(/\.ts$/, '.js')), false);
  });

  // ---- 0011 migration ----

  t('0011 exists and only ALTERs stories (no new table, no rewrite)', () => {
    const sql = fs.readFileSync(mig011, 'utf8');
    assert.ok(/ALTER TABLE stories ADD COLUMN scene_catalog/.test(sql));
    assert.equal(/CREATE TABLE/i.test(sql), false);
    assert.equal(/UPDATE /i.test(sql), false);
    assert.equal(/DROP /i.test(sql), false);
    assert.equal(/BEGIN|COMMIT/i.test(sql), false, 'runner owns the transaction');
  });

  t('0011 applies cleanly and defaults existing stories to {}', () => {
    const tmp = path.join(os.tmpdir(), `f9cat-${crypto.randomUUID()}.db`);
    const db = new Database(tmp);
    db.exec(fs.readFileSync(path.join(migDir, '0001_init.sql'), 'utf8'));
    db.exec(fs.readFileSync(path.join(migDir, '0008_stories.sql'), 'utf8'));
    db.prepare(
      `INSERT INTO stories (id,name,tagline,setting,minor_cast,archived,created_at,updated_at)
       VALUES ('s1','n','t','set','[]',0,'x','x')`,
    ).run();
    db.exec(fs.readFileSync(mig011, 'utf8'));
    const row: any = db.prepare('SELECT scene_catalog FROM stories WHERE id=?').get('s1');
    assert.equal(row.scene_catalog, '{}');
    const cols = db.prepare('PRAGMA table_info(stories)').all() as any[];
    assert.equal(cols.length, 9, 'exactly one column added');
    assert.equal(cols.find((c) => c.name === 'scene_catalog').notnull, 1);
    db.close();
    fs.unlinkSync(tmp);
  });

  t('0010 bytes unchanged; exactly one 0011 file', () => {
    const hex = crypto.createHash('sha256').update(fs.readFileSync(mig010)).digest('hex');
    assert.equal(hex, HASH_0010);
    const migs = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql'));
    assert.equal(migs.filter((f) => f.startsWith('0011')).length, 1);
    // f9-beat-render (S1) added 0012 as a no-op contract file, on the 0010 precedent.
    // This fence keeps what it always protected — no token here writes real schema —
    // by binding on 0012's contents instead of on its absence.
    const beat012 = fs.readdirSync(migDir).filter((f) => f.startsWith('0012'));
    assert.equal(beat012.length, 1);
    const beatSql = fs.readFileSync(path.join(migDir, beat012[0]), 'utf8');
    assert.deepEqual(beatSql.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('--')), ['SELECT 1;']);
  });

  // ---- catalog parsing ----

  t('empty / damaged catalog yields the empty catalog, never throws', () => {
    for (const bad of ['', '{}', 'null', '[]', '{oops', 'garbage']) {
      assert.deepEqual(catalogFromStory(bad), SCENE_CATALOG_EMPTY, JSON.stringify(bad));
    }
  });

  t('places come from the story, not from any character tag', () => {
    const cat = catalogFromStory(CAT);
    assert.deepEqual(cat.locations, ['bureau_lobby', 'evaluation_room', 'academy_hall']);
  });

  t('a place with no character in it is still reachable (the whole point)', () => {
    const cat = catalogFromStory(CAT);
    assert.ok(cat.locations.includes('evaluation_room'));
    assert.ok(cat.locations.includes('academy_hall'));
  });

  t('arcs / stages / weathers / flags also come from the story', () => {
    const cat = catalogFromStory(CAT);
    assert.deepEqual(cat.arcs, ['entry']);
    assert.deepEqual(cat.stagesByArc, { entry: ['reg', 'scan'] });
    assert.deepEqual(cat.weathers, ['cloudy', 'clear']);
    assert.deepEqual(cat.flags, { cand: { owner_stage: 'reg' } });
  });

  t('malformed place entries are skipped, not fatal', () => {
    const cat = catalogFromStory(JSON.stringify({ places: [{ id: 'ok' }, { name: 'no id' }, 'x', null, { id: 42 }] }));
    assert.deepEqual(cat.locations, ['ok']);
  });

  t('parseSceneCatalog keeps place display names for the UI layer', () => {
    const parsed = parseSceneCatalog(CAT);
    assert.equal(parsed.places[1].id, 'evaluation_room');
    assert.equal(parsed.places[1].name, '측정실');
    assert.deepEqual(parsed.places[1].tags, ['scan']);
  });

  // ---- character layer: home places only ----

  t('party:home is parsed as a repeatable home place', () => {
    const p = parsePartyTags(['party:role=main', 'party:home=bureau_lobby', 'party:home=evaluation_room']);
    assert.deepEqual(p.home_places, ['bureau_lobby', 'evaluation_room']);
  });

  t('legacy party:place still counts as a home place (back-compat)', () => {
    const p = parsePartyTags(['party:role=main', 'party:place=bureau_lobby']);
    assert.equal(p.place, 'bureau_lobby');
    assert.deepEqual(p.home_places, ['bureau_lobby']);
  });

  t('homePlacesOf reads a character row', () => {
    assert.deepEqual(
      homePlacesOf({ id: 'c', name: 'n', tags_json: '["party:home=a","party:home=b"]' }),
      ['a', 'b'],
    );
    assert.deepEqual(homePlacesOf({ id: 'c', name: 'n', tags_json: 'broken' }), []);
  });

  t('cast mapping is unchanged by this token (cast contract intact)', () => {
    const rows = [
      { id: 'a', name: 'A', tags_json: '["party:role=main","party:place=bureau_lobby","party:duty=등록"]' },
      { id: 'b', name: 'B', tags_json: '["party:role=secondary","party:place=bureau_lobby"]' },
    ];
    const cast = castFromCharacters(rows, 'a')!;
    assert.equal(cast.length, 2);
    assert.equal(cast.find((c) => c.id === 'a')!.place, 'bureau_lobby');
    assert.equal(cast.find((c) => c.id === 'a')!.role, 'main');
    // f9-focus-eligible retired F9C scoring; this fence used to pin `WIN = 95` as
    // proof the router was untouched. The lasting claim is the shape of the cast
    // row, and that no scoring came back with it.
    const castSrc = fs.readFileSync(pickPath, 'utf8');
    assert.ok(castSrc.includes('export type CastMember'));
    assert.ok(castSrc.includes("role: CastRole"));
    assert.equal(/const WIN|decided_stage|llm_reached/.test(castSrc), false, 'F9C scoring must not return');
  });

  // ---- wiring ----

  t('chat.ts sources the catalog from the story, not from cast tags', () => {
    const src = fs.readFileSync(chatPath, 'utf8');
    assert.ok(src.includes('catalogFromStory'), 'must use the story catalog');
    assert.equal(src.includes('catalogFromCharacters('), false, 'cast-derived catalog must be gone');
  });

  t('sceneCatalog is pure: no db, fetch, model, routes', () => {
    const src = fs.readFileSync(srcPath, 'utf8');
    for (const bad of ['better-sqlite3', 'fetch(', 'ModelClient', "from '../routes"]) {
      assert.equal(src.includes(bad), false, bad);
    }
  });

  console.log(`passed ${passed}`);
}

main();
