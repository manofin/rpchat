/**
 * npx tsx bench/beatRender.test.ts
 * f9-beat-render (S1) — header / UI / image path / serialization are server
 * templates. Nothing here starts systemd, touches the live DB, calls a model,
 * applies a migration, or live-generates.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOCK_CHIP,
  NEUTRAL_CHIP,
  assetPathFor,
  isAddressable,
  renderHeader,
  renderUi,
  serializeBeat,
  type BeatCastMember,
} from '../apps/server/src/prompt/renderBeat.ts';
import {
  isAssetIndex,
  isSafeAssetSegment,
  isWebp,
  readAsset,
  resolveAssetPath,
} from '../apps/server/src/media/assets.ts';
import { catalogFromStory, parseSceneCatalog } from '../apps/server/src/prompt/sceneCatalog.ts';
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
const src = (rel: string) => fs.readFileSync(path.join(appRoot, rel), 'utf8');
/** Source with comments stripped — fences must bind on code, not on prose that names a symbol. */
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── fixtures ────────────────────────────────────────────────────────────────
// Notes §7 classroom beat. Synthetic ids; never live 서리/카이 rows.
const NARI: BeatCastMember = { id: 'nari', name: '나리' };
const SERA: BeatCastMember = { id: 'sera', name: '세라' };
const HAYEON: BeatCastMember = { id: 'hayeon', name: '하연' };
const LUNA: BeatCastMember = { id: 'luna', name: '루나' };
const MIR: BeatCastMember = { id: 'mir', name: '미르', locked: true };
const YUKI: BeatCastMember = { id: 'yuki', name: '유키' };
const CAST = [NARI, SERA, HAYEON, LUNA, MIR, YUKI];

const CLASSROOM: Scene = {
  location: '교실',
  weather: '맑음',
  clock_minutes: 9 * 60 + 37,
  day_index: 12,
  weekday: '화',
  present_ids: ['nari', 'sera', 'hayeon', 'luna', 'mir'],
  roster: { nari: { emotion: '😡', outfit: '교복' }, sera: { emotion: '😟', outfit: '교복' } },
  user_sheet: { hp: 30, money: 1200, gear: ['학생증'], inventory: [], traits: [] },
};

const CATALOG_JSON = JSON.stringify({
  places: [{ id: '교실', name: '2-3 교실', default_focus: 'nari' }],
  weathers: ['맑음'],
  arcs: ['entry'],
  stagesByArc: { entry: ['reg', 'class'] },
  flags: { rulebreak: { owner_stage: 'reg', owner_duty: '교칙' } },
  outfits: ['교복', '체육복'],
  emotions: { '😡': 8, '😟': 1, '😐': 0 },
  stages: { class: { closer_duty: '수업' } },
});
const CAT: PartyCatalog = catalogFromStory(CATALOG_JSON);

// ── 1. header comes from scene state only ───────────────────────────────────
t('header renders 일차·요일·시각·날씨·장소 from scene fields', () => {
  assert.equal(renderHeader(CLASSROOM), '12일차 · 화 · 09:37 · 맑음 · 교실');
});

t('header omits every field the scene does not carry (no invention)', () => {
  assert.equal(renderHeader({ location: '교실' }), '교실');
  assert.equal(renderHeader({ clock_minutes: 0 }), '00:00');
  assert.equal(renderHeader({}), null);
  // A 0010-only scene has no day_index/weekday: the header must be shorter, not guessed.
  const h = renderHeader({ clock_minutes: 605, weather: '흐림', location: '로비' });
  assert.equal(h, '10:05 · 흐림 · 로비');
  assert.ok(!/일차/.test(h!));
});

t('header falls back to the 0001 `place` key when 0010 `location` is unset', () => {
  assert.equal(renderHeader({ place: '기숙사' }), '기숙사');
  // location wins when both exist — 0010 is the scene layer, `place` is prose.
  assert.equal(renderHeader({ place: '기숙사', location: '교실' }), '교실');
});

t('header clock wraps a day and never emits a negative or 24+ hour', () => {
  assert.equal(renderHeader({ clock_minutes: 1440 }), '00:00');
  assert.equal(renderHeader({ clock_minutes: 1500 }), '01:00');
  assert.equal(renderHeader({ clock_minutes: 1439 }), '23:59');
});

// ── 2. UI is a server template, never a generation product ──────────────────
t('renderUi takes no model text and reads only scene + cast', () => {
  const ui = renderUi({ scene: CLASSROOM, cast: CAST, focus_id: 'nari', extra_ids: ['sera'] });
  assert.equal(ui.location_badge, '교실');
  assert.deepEqual(ui.user_sheet, CLASSROOM.user_sheet);
  assert.equal(ui.roster.length, CAST.length);
  assert.equal(ui.intent_hint, null);
});

t('🔒 rule: only this turn focus and approved extras are addressable', () => {
  const ui = renderUi({ scene: CLASSROOM, cast: CAST, focus_id: 'nari', extra_ids: ['sera'] });
  const chip = (id: string) => ui.roster.find((r) => r.id === id)!;

  assert.equal(chip('nari').chip, '😡');          // focus, emotion from scene.roster
  assert.equal(chip('nari').locked, false);
  assert.equal(chip('sera').chip, '😟');          // approved extra
  assert.equal(chip('sera').locked, false);
  assert.equal(chip('hayeon').chip, LOCK_CHIP);   // present but not a target this turn
  assert.equal(chip('luna').chip, LOCK_CHIP);     // ambient only — narration, not a slot
  assert.equal(chip('mir').chip, LOCK_CHIP);      // party:locked
  assert.equal(chip('yuki').chip, LOCK_CHIP);     // outside the room
});

t('roster shows characters who are out of the room, flagged not in_room', () => {
  const ui = renderUi({ scene: CLASSROOM, cast: CAST, focus_id: 'nari' });
  const yuki = ui.roster.find((r) => r.id === 'yuki')!;
  assert.equal(yuki.in_room, false);
  assert.equal(yuki.locked, true);
  assert.equal(yuki.name, '유키');   // still listed — §7 "장소 밖이지만 로스터 표시"
  assert.equal(ui.roster.find((r) => r.id === 'nari')!.in_room, true);
});

t('addressable focus with no emotion set gets the neutral chip, not 🔒', () => {
  const scene: Scene = { ...CLASSROOM, roster: {} };
  const ui = renderUi({ scene, cast: CAST, focus_id: 'nari' });
  assert.equal(ui.roster.find((r) => r.id === 'nari')!.chip, NEUTRAL_CHIP);
});

t('focus null locks the whole roster — a narration-only beat has no target', () => {
  const ui = renderUi({ scene: CLASSROOM, cast: CAST, focus_id: null, extra_ids: [] });
  assert.deepEqual(ui.roster.map((r) => r.chip), CAST.map(() => LOCK_CHIP));
});

t('a locked character is never addressable even as focus or extra', () => {
  assert.equal(isAddressable(MIR, CLASSROOM, 'mir', []), false);
  assert.equal(isAddressable(MIR, CLASSROOM, null, ['mir']), false);
});

t('a scene that never declared occupancy does not fabricate presence', () => {
  const scene: Scene = { location: '교실' };
  assert.equal(isAddressable(NARI, scene, 'nari', []), true);
  assert.equal(renderUi({ scene, cast: CAST, focus_id: 'nari' }).roster[0].in_room, false);
});

// ── 3. image path: allow-list only, null is a normal outcome ────────────────
t('assetPathFor builds the local path from emotion × outfit', () => {
  assert.equal(assetPathFor({ characterId: 'nari', outfit: '교복', emotion: '😡' }, CAT),
    `/media/assets/nari/${encodeURIComponent('교복')}/8.webp`);
  assert.equal(assetPathFor({ characterId: 'sera', outfit: '교복', emotion: '😟' }, CAT),
    `/media/assets/sera/${encodeURIComponent('교복')}/1.webp`);
  // emotion index 0 is a real index, not a falsy miss
  assert.ok(assetPathFor({ characterId: 'nari', outfit: '교복', emotion: '😐' }, CAT)!.endsWith('/0.webp'));
});

t('unregistered emotion or outfit yields null, not a guessed path', () => {
  assert.equal(assetPathFor({ characterId: 'nari', outfit: '교복', emotion: '🤯' }, CAT), null);
  assert.equal(assetPathFor({ characterId: 'nari', outfit: '수영복', emotion: '😡' }, CAT), null);
  assert.equal(assetPathFor({ characterId: 'nari', outfit: null, emotion: '😡' }, CAT), null);
  assert.equal(assetPathFor({ characterId: 'nari', outfit: '교복', emotion: null }, CAT), null);
  // An empty catalog rejects everything rather than inventing a default outfit.
  assert.equal(assetPathFor({ characterId: 'nari', outfit: '교복', emotion: '😡' },
    catalogFromStory('{}')), null);
});

t('assetPathFor refuses traversal and separator segments', () => {
  const cat: PartyCatalog = { ...CAT, outfits: [...(CAT.outfits ?? []), '..', 'a/b'] };
  assert.equal(assetPathFor({ characterId: '..', outfit: '교복', emotion: '😡' }, cat), null);
  assert.equal(assetPathFor({ characterId: 'nari', outfit: '..', emotion: '😡' }, cat), null);
  assert.equal(assetPathFor({ characterId: 'nari', outfit: 'a/b', emotion: '😡' }, cat), null);
  assert.equal(assetPathFor({ characterId: 'a/../b', outfit: '교복', emotion: '😡' }, cat), null);
});

t('the emitted path is exactly the route the server serves', () => {
  const p = assetPathFor({ characterId: 'nari', outfit: '교복', emotion: '😡' }, CAT)!;
  assert.match(p, /^\/media\/assets\/[^/]+\/[^/]+\/\d+\.webp$/);
  assert.ok(!p.includes('silu.uk') && !p.startsWith('http'));
});

// ── 4. media route resolution ───────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f9-assets-'));
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP', 'ascii'), Buffer.from('VP8 ', 'ascii'),
]);
fs.mkdirSync(path.join(tmp, 'nari', '교복'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'nari', '교복', '8.webp'), WEBP);
fs.writeFileSync(path.join(tmp, 'nari', '교복', '9.webp'), Buffer.from('not an image'));

t('resolveAssetPath returns a real file and reads its bytes', () => {
  const full = resolveAssetPath(tmp, { characterId: 'nari', outfit: '교복', n: '8' })!;
  assert.ok(full);
  assert.deepEqual(readAsset(full), WEBP);
});

t('missing file resolves to null — an incomplete asset set is not an error', () => {
  assert.equal(resolveAssetPath(tmp, { characterId: 'nari', outfit: '교복', n: '3' }), null);
  assert.equal(resolveAssetPath(tmp, { characterId: 'sera', outfit: '교복', n: '8' }), null);
});

t('non-webp bytes are rejected by the sniff, not served as an image', () => {
  const full = resolveAssetPath(tmp, { characterId: 'nari', outfit: '교복', n: '9' })!;
  assert.ok(full);
  assert.equal(readAsset(full), null);
  assert.equal(isWebp(Buffer.from('not an image')), false);
});

t('traversal cannot escape the asset root', () => {
  assert.equal(resolveAssetPath(tmp, { characterId: '..', outfit: '..', n: '1' }), null);
  assert.equal(resolveAssetPath(tmp, { characterId: '../../etc', outfit: 'x', n: '1' }), null);
  assert.equal(isSafeAssetSegment('..'), false);
  assert.equal(isSafeAssetSegment('a/b'), false);
  assert.equal(isSafeAssetSegment('a\\b'), false);
  assert.equal(isSafeAssetSegment(''), false);
  assert.equal(isSafeAssetSegment('교복'), true);
});

t('asset index must be a bare non-negative integer', () => {
  assert.equal(isAssetIndex('0'), true);
  assert.equal(isAssetIndex('8'), true);
  assert.equal(isAssetIndex('08'), false);
  assert.equal(isAssetIndex('-1'), false);
  assert.equal(isAssetIndex('1.5'), false);
  assert.equal(isAssetIndex(''), false);
});

t('the media route replies 404 application/json, never SPA html', () => {
  const s = code('apps/server/src/routes/media.ts');
  assert.ok(/reply\.code\(404\)\.send\(\{ error: 'not found' \}\)/.test(s), s);
  assert.ok(!/sendFile|index\.html/.test(s), s);
  // registered before the static SPA handler, so a miss cannot fall through
  const idx = src('apps/server/src/index.ts');
  assert.ok(idx.indexOf('mediaRoutes(mediaRoot)') < idx.indexOf('fastifyStatic,'), 'media route must precede static');
});

// ── 5. serialization order (§6) ─────────────────────────────────────────────
const line = (id: string, name: string, text: string, asset: string | null = null) =>
  ({ character_id: id, name, text, asset_path: asset, emotion: null, outfit: null });

t('serializeBeat emits HEADER → N → LINE → N → THOUGHT → N → LINE* → N → UI', () => {
  const ui = renderUi({ scene: CLASSROOM, cast: CAST, focus_id: 'nari', extra_ids: ['sera', 'hayeon'] });
  const blocks = serializeBeat({
    header: renderHeader(CLASSROOM),
    narration_open: ['지명이 나리를 돌아본다.'],
    focus_line: line('nari', '나리', '"시비냐."'),
    narration_after_line: ['공기가 한 겹 굳는다.'],
    thought: { character_id: 'nari', name: '나리', text: '어떻게 알았지.' },
    narration_after_thought: ['루나가 눈을 반짝였다.'],
    extra_lines: [line('sera', '세라', '"교칙 위반이야."'), line('hayeon', '하연', '"수업 시작."')],
    narration_close: ['나리가 자리에 앉는다.'],
    ui,
  });

  assert.deepEqual(blocks.map((b) => b.kind), [
    'header', 'narration', 'line', 'narration', 'thought', 'narration', 'line', 'line', 'narration', 'ui',
  ]);
  assert.deepEqual(blocks.map((b) => b.seq), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(blocks[0].text, '12일차 · 화 · 09:37 · 맑음 · 교실');
  assert.deepEqual(JSON.parse(blocks[9].text), ui);
});

t('header / narration / ui blocks carry no speaker; line and thought do', () => {
  const blocks = serializeBeat({
    header: '09:37 · 교실',
    narration_open: ['조용하다.'],
    focus_line: line('nari', '나리', '"뭐."'),
    thought: { character_id: 'nari', name: '나리', text: '싫다.' },
    ui: renderUi({ scene: CLASSROOM, cast: CAST, focus_id: 'nari' }),
  });
  for (const b of blocks) {
    if (b.kind === 'line' || b.kind === 'thought') assert.ok(b.speaker_character_id, b.kind);
    else assert.equal(b.speaker_character_id, null, b.kind);
  }
});

t('a focus-null beat serializes header + narration + ui with zero line slots', () => {
  const blocks = serializeBeat({
    header: renderHeader(CLASSROOM),
    narration_open: ['아무도 대답하지 않는다.'],
    focus_line: null,
    ui: renderUi({ scene: CLASSROOM, cast: CAST, focus_id: null }),
  });
  assert.deepEqual(blocks.map((b) => b.kind), ['header', 'narration', 'ui']);
  assert.equal(blocks.filter((b) => b.kind === 'line').length, 0);
});

t('empty and whitespace-only slots contribute no block and do not skew seq', () => {
  const blocks = serializeBeat({
    header: '   ',
    narration_open: ['', '  ', '진짜 문장.'],
    focus_line: line('nari', '나리', '   '),
    extra_lines: [],
    ui: null,
  });
  assert.deepEqual(blocks.map((b) => b.kind), ['narration']);
  assert.equal(blocks[0].seq, 0);
});

t('an image-less line still renders (name + line, asset_path null)', () => {
  const blocks = serializeBeat({
    header: null,
    focus_line: line('nari', '나리', '"…"', null),
    ui: null,
  });
  assert.equal(blocks[0].kind, 'line');
  assert.equal(blocks[0].asset_path, null);
  assert.equal(blocks[0].speaker_name, '나리');
});

// ── 6. source fences: this layer cannot read model output ───────────────────
t('renderBeat.ts imports no db, fetch, fs or model surface', () => {
  const s = src('apps/server/src/prompt/renderBeat.ts');
  for (const banned of ['better-sqlite3', 'node:fs', 'node:http', 'fetch(', '../db/', 'model/', 'ModelClient']) {
    assert.ok(!s.includes(banned), `renderBeat.ts must not reference ${banned}`);
  }
  // Only type-only imports; no runtime module dependency at all.
  const imports = s.match(/^import .*$/gm) ?? [];
  assert.deepEqual(imports.filter((l) => !l.startsWith('import type')), []);
});

t('no function in this layer accepts generated text as a UI/header input', () => {
  const s = src('apps/server/src/prompt/renderBeat.ts');
  // renderHeader/renderUi/assetPathFor signatures take scene/cast/catalog only.
  assert.match(s, /export function renderHeader\(scene: Scene\)/);
  assert.match(s, /export function renderUi\(input: \{\n\s+scene: Scene;\n\s+cast: BeatCastMember\[\];/);
  assert.ok(!/renderUi\([^)]*text/.test(s));
  assert.ok(!/renderHeader\([^)]*text/.test(s));
});

t('no external image host anywhere in the beat render or media layer', () => {
  for (const f of ['apps/server/src/prompt/renderBeat.ts', 'apps/server/src/media/assets.ts', 'apps/server/src/routes/media.ts']) {
    const s = src(f);
    assert.ok(!/silu\.uk|https?:\/\//.test(s), `${f} must not reference an external host`);
  }
});

// ── 7. 0012 contract + catalog/apply additions stay additive ────────────────
t('0012 is a no-op contract file: no table, no column, no data rewrite', () => {
  const s = src('apps/server/migrations/0012_scene_beat.sql');
  assert.ok(s.trim().length > 0, '0012 must not be an empty file');
  const stmts = s.split('\n').filter((l) => l.trim() && !l.trim().startsWith('--'));
  assert.deepEqual(stmts.map((l) => l.trim()), ['SELECT 1;']);
  for (const banned of [/CREATE TABLE/i, /ALTER TABLE/i, /DROP/i, /UPDATE /i, /INSERT /i, /DELETE /i]) {
    assert.ok(!banned.test(s), `0012 must not contain ${banned}`);
  }
  const compat = JSON.parse(src('deploy/schema-compat.json'));
  assert.ok(compat.required_migrations.includes('0012_scene_beat.sql'));
});

t('parseSceneCatalog keeps the 0011 shape and adds the beat sections', () => {
  const c = parseSceneCatalog(CATALOG_JSON);
  assert.deepEqual(c.places[0], { id: '교실', name: '2-3 교실', default_focus: 'nari' });
  assert.deepEqual(c.weathers, ['맑음']);
  assert.deepEqual(c.stagesByArc, { entry: ['reg', 'class'] });
  assert.deepEqual(c.flags.rulebreak, { owner_stage: 'reg', owner_duty: '교칙' });
  assert.deepEqual(c.outfits, ['교복', '체육복']);
  assert.equal(c.emotions['😡'], 8);
  assert.deepEqual(c.stages.class, { closer_duty: '수업' });
});

t('a 0011-era catalog with no beat sections still parses, with empty beat fields', () => {
  const c = parseSceneCatalog(JSON.stringify({ places: [{ id: 'lobby' }], weathers: ['clear'] }));
  assert.deepEqual(c.places, [{ id: 'lobby' }]);   // no invented default_focus
  assert.deepEqual(c.outfits, []);
  assert.deepEqual(c.emotions, {});
  assert.deepEqual(c.stages, {});
  assert.equal(catalogFromStory('{}').outfits!.length, 0);
});

t('a malformed emotion index is dropped rather than trusted', () => {
  const c = parseSceneCatalog(JSON.stringify({ emotions: { a: 1, b: -1, c: 1.5, d: 'x', '': 2 } }));
  assert.deepEqual(c.emotions, { a: 1 });
});

t('applySceneDelta reports stage and flag transitions as appliedEvents', () => {
  const before: Scene = { arc: 'entry', stage: 'reg', scene_version: 0 };
  const r = applySceneDelta(before, { base_version: 0, stage: 'class', flags: { rulebreak: true } }, CAT, 0);
  assert.equal(r.discarded, false);
  assert.deepEqual(r.appliedEvents, [{ kind: 'stage', id: 'class' }, { kind: 'flag', id: 'rulebreak' }]);
  assert.ok(r.applied.includes('stage') && r.applied.includes('flags'));
});

t('a no-change patch produces no appliedEvents', () => {
  const before: Scene = { arc: 'entry', stage: 'reg', scene_version: 0 };
  const r = applySceneDelta(before, { base_version: 0, stage: 'reg' }, CAT, 0);
  assert.deepEqual(r.appliedEvents, []);
  const discarded = applySceneDelta(before, { base_version: 99 }, CAT, 0);
  assert.equal(discarded.discarded, true);
  assert.deepEqual(discarded.appliedEvents, []);
});

t('the model cannot propose any 0012 key — all land in not_in_allowlist', () => {
  const before: Scene = { scene_version: 0, last_beat: { focus_id: 'nari', extra_ids: [], unresolved: [] } };
  const r = applySceneDelta(before, {
    base_version: 0,
    last_beat: { focus_id: 'yuki', extra_ids: ['yuki'], unresolved: [] },
    roster: { nari: { emotion: '😊' } },
    user_sheet: { hp: 999 },
    day_index: 99,
    beat_goal: '아무거나',
  }, CAT, 0);
  for (const k of ['last_beat', 'roster', 'user_sheet', 'day_index', 'beat_goal']) {
    assert.ok(r.ignored.some((i) => i.key === k && i.reason === 'not_in_allowlist'), k);
  }
  assert.deepEqual(r.state.last_beat, { focus_id: 'nari', extra_ids: [], unresolved: [] });
  assert.equal(r.state.roster, undefined);
  assert.deepEqual(r.applied, []);
});

t('cloneScene deep-copies the 0012 nested keys (no shared mutation)', () => {
  const before: Scene = {
    arc: 'entry',
    scene_version: 0,
    roster: { nari: { emotion: '😡' } },
    last_beat: { focus_id: 'nari', extra_ids: ['sera'], unresolved: ['nari'] },
    user_sheet: { hp: 30, gear: ['학생증'] },
  };
  const r = applySceneDelta(before, { base_version: 0, weather: '맑음' }, CAT, 0);
  r.state.roster!.nari.emotion = '😊';
  r.state.last_beat!.extra_ids.push('hayeon');
  r.state.user_sheet!.gear!.push('열쇠');

  assert.equal(before.roster!.nari.emotion, '😡');
  assert.deepEqual(before.last_beat!.extra_ids, ['sera']);
  assert.deepEqual(before.user_sheet!.gear, ['학생증']);
});

// ── 8. 1:1 path is untouched by this slice ──────────────────────────────────
t('S1 changes no 1:1 prompt text and does not touch generate', () => {
  const templates = src('apps/server/src/prompt/templates.ts');
  assert.ok(!/renderBeat|assetPathFor|BeatBlock/.test(templates), 'templates.ts must not know about the beat layer');
  const builder = src('apps/server/src/prompt/builder.ts');
  assert.ok(!/renderBeat|assetPathFor/.test(builder), 'builder.ts must not import the beat layer');
  const chat = src('apps/server/src/routes/chat.ts');
  assert.ok(!/renderBeat|serializeBeat/.test(chat), 'S1 does not wire generate — that is S4');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed`);
