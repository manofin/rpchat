/** npx tsx bench/schoolFixture.test.ts
 * f9-school-fixture (S2) — the Notes §7 classroom, proved from one document.
 *
 * The live smoke story's catalog has no owner_duty/closer_duty/outfits/emotions, so
 * its k_opened=0 is structurally guaranteed and proves nothing about §7. This bench
 * is the witness instead: bench/schoolFixture/school.json is exactly what a seed
 * would POST, and every §7 row is asserted from it — focus 나리, extras 세라·하연 on
 * a hard event, 유라·루나·미르 ambient only, 한소연·유키 cut by place.
 *
 * Source change: none. Isolated: no DB, no systemd, no live DB, no model call.
 * Helper/bench PASS is not a product PASS (helper-vs-live-contract).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogFromStory } from '../apps/server/src/prompt/sceneCatalog.ts';
import { castFromCharacters, type PartyTagRow } from '../apps/server/src/prompt/tagsCatalog.ts';
import { canSpeak, isBackground, talkativenessOf, type CastMember } from '../apps/server/src/prompt/cast.ts';
import { resolveFocus } from '../apps/server/src/prompt/resolveFocus.ts';
import { eligibleExtras } from '../apps/server/src/prompt/eligibleExtras.ts';
import { approveExtras, EXTRA_SCORE_ENABLED, type AppliedEvent } from '../apps/server/src/prompt/approveExtras.ts';
import { ambientPicks } from '../apps/server/src/prompt/ambient.ts';
import { assetPathFor } from '../apps/server/src/prompt/renderBeat.ts';
import type { PartyCatalog } from '../apps/server/src/prompt/applySceneDelta.ts';
import type { Scene } from '../apps/server/src/types.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));

type Fixture = {
  story: { name: string; setting: string; scene_catalog: Record<string, unknown> };
  characters: Array<{ _id: string; name: string; tagline: string; tags: string[] }>;
  main_character: string;
  scene: Scene & { present_ids: string[] };
  turn: {
    user_text: string;
    expected: { focus: string; eligible: string[]; k_opened: number; ambient_candidates: string[] };
  };
};

const FIX = JSON.parse(fs.readFileSync(path.join(dir, 'schoolFixture/school.json'), 'utf8')) as Fixture;

/**
 * Builds the world the way the server does: catalog from the story row, cast from
 * character rows. `remap` proves the §7 outcomes do not depend on the ids, which
 * matters because POST /api/characters mints its own (characters.ts:93).
 */
function world(remap?: (symbolic: string) => string) {
  const id = (s: string) => (remap ? remap(s) : s);

  const catalogDoc = JSON.parse(JSON.stringify(FIX.story.scene_catalog)) as {
    places: Array<{ id: string; default_focus?: string }>;
  };
  for (const p of catalogDoc.places) if (p.default_focus) p.default_focus = id(p.default_focus);

  const rows: PartyTagRow[] = FIX.characters.map((c) => ({
    id: id(c._id),
    name: c.name,
    tags_json: JSON.stringify(c.tags),
  }));

  const cast = castFromCharacters(rows, id(FIX.main_character));
  assert.ok(cast, 'the roster must be a party (2+ rows carry party: tags)');

  const scene: Scene = { ...FIX.scene, present_ids: FIX.scene.present_ids.map(id) };
  const catalog: PartyCatalog = catalogFromStory(JSON.stringify(catalogDoc));
  return { cast: cast as CastMember[], scene, catalog, id };
}

const W = world();
const names = (ids: string[]) => ids.map((i) => W.cast.find((m) => m.id === i)?.name ?? i).sort();
const sortedNames = (syms: string[]) => syms.map((s) => FIX.characters.find((c) => c._id === s)!.name).sort();

// ── 1. the catalog survives as a document ───────────────────────────────────
t('the six keys are live in the catalog (S1 is what lets this be authored)', () => {
  const c = W.catalog;
  assert.equal(c.places.find((p) => p.id === '교실')?.default_focus, 'hayeon');
  assert.equal(c.flags.rulebreak?.owner_duty, '교칙');
  assert.equal(c.stages.class?.closer_duty, '수업');
  assert.deepEqual(c.dutySlots, { 교칙: '질서', 담임: '질서' });
  assert.equal(c.dutySlots['수업'], undefined, '수업 is its own slot, or §7 could never open two lines');
  assert.equal(c.flags.noise?.owner_duty, '담임');
  assert.deepEqual(c.outfits, ['교복', '체육복']);
  assert.deepEqual(c.emotions, { 평온: 0, 화남: 1, 놀람: 2 });
  assert.deepEqual(c.locations, ['교실', '복도', '사무실', '경비실']);
});

t('the catalog does not come from character tags — one source, the story row', () => {
  const rows: PartyTagRow[] = FIX.characters.map((c) => ({ id: c._id, name: c.name, tags_json: JSON.stringify(c.tags) }));
  const tagText = rows.map((r) => r.tags_json).join(' ');
  for (const k of ['party:arc=', 'party:stage=', 'party:flag=', 'party:weather=']) {
    assert.equal(tagText.includes(k), false, `${k} belongs to the story catalog, not a character row`);
  }
});

// ── 2. the cast ─────────────────────────────────────────────────────────────
t('§7 roster: 9 rows, 하연 main, 학생들 background, nobody locked', () => {
  assert.equal(W.cast.length, 9);
  assert.equal(W.cast.find((m) => m.name === '하연')?.role, 'main');
  assert.equal(isBackground(W.cast.find((m) => m.name === '학생들')!), true);
  assert.equal(W.cast.filter((m) => m.locked).length, 0, '§7 line 140 keeps 미르 eligible, so nobody is locked');
});

t('talkativeness is an ambient weight, not a slot probability', () => {
  const of = (n: string) => talkativenessOf(W.cast.find((m) => m.name === n)!);
  assert.equal(of('루나'), 0.8);
  assert.equal(of('유라'), 0.4);
  assert.equal(of('미르'), 0.1);
  assert.equal(of('세라'), 0.3, 'untagged falls back to the documented default, not silence');
});

// ── 3. §4.1 focus ───────────────────────────────────────────────────────────
t('§7 walkthrough: aiming at 나리 makes 나리 the focus', () => {
  const r = resolveFocus({ user_text: FIX.turn.user_text, scene: W.scene, cast: W.cast, catalog: W.catalog });
  assert.equal(r.focus_id, 'nari');
  assert.deepEqual(r.matched_ids, ['nari']);
});

t('the alias resolves too, and an absent character does not', () => {
  assert.equal(resolveFocus({ user_text: '나리쨩!', scene: W.scene, cast: W.cast, catalog: W.catalog }).focus_id, 'nari');
  const away = resolveFocus({ user_text: '한소연, 서류 어디 있어?', scene: W.scene, cast: W.cast, catalog: W.catalog });
  assert.notEqual(away.focus_id, 'soyeon', 'naming someone out of the room must not put words in their mouth');
});

t('naming nobody falls to the place default_focus (담임 하연)', () => {
  const r = resolveFocus({ user_text: '조용하다.', scene: W.scene, cast: W.cast, catalog: W.catalog });
  assert.equal(r.focus_id, 'hayeon');
});

// ── 4. §4.2 eligibility ─────────────────────────────────────────────────────
t('§7 eligible = {세라, 하연, 유라, 루나, 미르}', () => {
  const r = eligibleExtras({ cast: W.cast, scene: W.scene, focus_id: 'nari' });
  assert.deepEqual(names(r.eligible_ids), sortedNames(FIX.turn.expected.eligible));
});

t('the cuts are place, focus and background — 미르 is not one of them', () => {
  const r = eligibleExtras({ cast: W.cast, scene: W.scene, focus_id: 'nari' });
  assert.equal(r.eligible_ids.includes('soyeon'), false, '한소연: out of the room');
  assert.equal(r.eligible_ids.includes('yuki'), false, '유키: out of the room');
  assert.equal(r.eligible_ids.includes('nari'), false, '나리: is the focus');
  assert.equal(r.eligible_ids.includes('crowd'), false, '학생들: background never takes a slot');
  assert.equal(r.eligible_ids.includes('mir'), true, '미르: low talkativeness is not an eligibility cut');
});

// ── 5. §4.3 approval — the default is silence ───────────────────────────────
const approve = (applied_events: AppliedEvent[], focus_id: string | null = 'nari') =>
  approveExtras({ cast: W.cast, scene: W.scene, focus_id, catalog: W.catalog, applied_events });

t('a quiet turn opens zero slots, and that is the success reading', () => {
  const r = approve([]);
  assert.deepEqual(r.approved, []);
  assert.equal(r.k_opened, FIX.turn.expected.k_opened);
  assert.ok(r.eligible_ids.length >= 4, 'the eligible set is not empty — nothing earned a slot');
  for (const id of r.eligible_ids) assert.equal(r.rejected.find((x) => x.id === id)?.reason, 'no_hard_event');
});

t('§7: a rulebreak flag opens 세라 and nobody else', () => {
  const r = approve([{ kind: 'flag', id: 'rulebreak' }]);
  assert.deepEqual(names(r.approved.map((a) => a.character_id)), ['세라']);
  assert.equal(r.k_opened, 1);
});

t('§7: 수업 개시 stage closes the beat through 하연', () => {
  const r = approve([{ kind: 'stage', id: 'class' }]);
  assert.deepEqual(names(r.approved.map((a) => a.character_id)), ['하연']);
  assert.equal(r.k_opened, 1);
});

t('§7 in full: 교칙 위반 + 수업 개시 gives 세라 AND 하연 — K=2, the walkthrough itself', () => {
  // The §7 beat has both: 세라's rule increment and 하연 closing the beat. Their
  // opening duties are 교칙 and 수업, which are different function slots, so both
  // survive the dedupe. Mapping those two to one slot would make §7 impossible.
  const r = approve([{ kind: 'flag', id: 'rulebreak' }, { kind: 'stage', id: 'class' }]);
  assert.equal(r.k_opened, 2);
  assert.deepEqual(names(r.approved.map((a) => a.character_id)), ['세라', '하연']);
  assert.deepEqual(
    r.approved.map((a) => a.duty).sort(),
    ['교칙', '수업'],
    'each was opened by its own duty, not by being in the room',
  );
});

t('§4.3 dedupe: 교칙 and 담임 do share 질서, so two openers yield one line', () => {
  // slotOf() keys on the duty that opened the slot, so the witness has to be two
  // *opening* duties that collide: rulebreak opens 세라 via 교칙, noise opens 하연
  // via 담임, and both are declared as the 질서 slot.
  const r = approve([{ kind: 'flag', id: 'rulebreak' }, { kind: 'flag', id: 'noise' }]);
  assert.equal(r.k_opened, 1, 'same function slot → one line, not two');
  assert.deepEqual(names(r.approved.map((a) => a.character_id)), ['세라']);
  assert.equal(r.rejected.find((x) => x.id === 'hayeon')?.reason, 'dup_slot');
});

t('no focus means no extras — the whole cast is silent, not an error', () => {
  const r = approve([{ kind: 'flag', id: 'rulebreak' }], null);
  assert.deepEqual(r.approved, []);
  assert.equal(r.k_opened, 0);
});

t('the score path stays shut, so hard_event is the only opener', () => {
  assert.equal(EXTRA_SCORE_ENABLED, false);
  const r = approveExtras({
    cast: W.cast, scene: W.scene, focus_id: 'nari', catalog: W.catalog,
    applied_events: [], scores: { sera: 0.99, hayeon: 0.99, luna: 0.99 }, tau: 0.1,
  });
  assert.deepEqual(r.approved, []);
  assert.equal(r.score_ran, false);
});

t('K never exceeds 2', () => {
  const r = approve([{ kind: 'flag', id: 'rulebreak' }, { kind: 'stage', id: 'class' }]);
  assert.ok(r.k_opened <= 2, `k_opened=${r.k_opened}`);
});

// ── 6. §4.4 ambient — presence without a slot ───────────────────────────────
t('유라·루나·미르 are narration only, and ambient never returns a speaker', () => {
  const picks = ambientPicks({ cast: W.cast, scene: W.scene, focus_id: 'nari', extra_ids: [], seed: 'school:1:577' });
  const ids = picks.map((p) => p.character_id);
  assert.equal(ids.includes('nari'), false, 'the focus is not an ambient point');
  for (const id of ids) {
    const m = W.cast.find((c) => c.id === id)!;
    assert.ok(FIX.turn.expected.ambient_candidates.includes(id), `${m.name} is not an expected ambient candidate`);
  }
  assert.ok(picks.every((p) => typeof p.weight === 'number'), 'ambient carries weights, not lines');
});

t('background is an ambient input, not a fourth exclusion set', () => {
  const picks = ambientPicks({ cast: W.cast, scene: W.scene, focus_id: 'nari', extra_ids: [], seed: 'school:1:577', max: 9 });
  const crowd = W.cast.find((m) => m.name === '학생들')!;
  assert.equal(canSpeak(crowd), false, '학생들 can never take a dialogue slot');
  assert.ok(picks.some((p) => p.character_id === 'crowd'), '…and is still available to narration');
});

t('the same seed gives the same ambient, a different one may differ', () => {
  const a = ambientPicks({ cast: W.cast, scene: W.scene, focus_id: 'nari', seed: 'school:1:577' });
  const b = ambientPicks({ cast: W.cast, scene: W.scene, focus_id: 'nari', seed: 'school:1:577' });
  assert.deepEqual(a, b);
});

// ── 7. images: declared, absent, and that is success ────────────────────────
t('a declared outfit+emotion yields a path (segments percent-encoded); anything unlisted yields null', () => {
  // The catalog holds the raw token 교복; the URL segment is encoded, which is what
  // keeps a non-ASCII outfit from producing an ambiguous path.
  const expected = `/media/assets/nari/${encodeURIComponent('교복')}/1.webp`;
  assert.equal(assetPathFor({ characterId: 'nari', outfit: '교복', emotion: '화남' }, W.catalog), expected);
  assert.equal(decodeURIComponent(expected), '/media/assets/nari/교복/1.webp');
  assert.equal(assetPathFor({ characterId: 'nari', outfit: '수영복', emotion: '화남' }, W.catalog), null);
  assert.equal(assetPathFor({ characterId: 'nari', outfit: '교복', emotion: '질투' }, W.catalog), null);
  assert.equal(assetPathFor({ characterId: '../etc', outfit: '교복', emotion: '평온' }, W.catalog), null);
});

t('no webp is seeded, so the live turn shows name+line — null is the success reading', () => {
  const root = path.join(dir, '..', 'data', 'media', 'assets');
  assert.equal(fs.existsSync(root), false, 'S2 seeds no image files');
});

// ── 8. id independence — the seed will not use these ids ────────────────────
t('every §7 outcome holds after the ids are replaced with server-minted ones', () => {
  const uuid = (s: string) => `f9school-${s}-0000-4000-8000-000000000000`;
  const X = world(uuid);
  const nm = (ids: string[]) => ids.map((i) => X.cast.find((m) => m.id === i)?.name ?? i).sort();

  const focus = resolveFocus({ user_text: FIX.turn.user_text, scene: X.scene, cast: X.cast, catalog: X.catalog });
  assert.equal(focus.focus_id, uuid('nari'));

  const el = eligibleExtras({ cast: X.cast, scene: X.scene, focus_id: uuid('nari') });
  assert.deepEqual(nm(el.eligible_ids), sortedNames(FIX.turn.expected.eligible));

  const quiet = approveExtras({ cast: X.cast, scene: X.scene, focus_id: uuid('nari'), catalog: X.catalog, applied_events: [] });
  assert.equal(quiet.k_opened, 0);

  const rule = approveExtras({
    cast: X.cast, scene: X.scene, focus_id: uuid('nari'), catalog: X.catalog,
    applied_events: [{ kind: 'flag', id: 'rulebreak' }],
  });
  assert.deepEqual(nm(rule.approved.map((a) => a.character_id)), ['세라']);

  const dflt = resolveFocus({ user_text: '조용하다.', scene: X.scene, cast: X.cast, catalog: X.catalog });
  assert.equal(dflt.focus_id, uuid('hayeon'), 'default_focus must be substituted by the seed, not left symbolic');
});

// ── 9. fences ───────────────────────────────────────────────────────────────
t('the fixture stays out of the live rows', () => {
  const raw = fs.readFileSync(path.join(dir, 'schoolFixture/school.json'), 'utf8');
  for (const live of ['f89ace9b', '255f96a2', '26614525', '552e0205', '서리', '카이']) {
    assert.equal(raw.includes(live), false, `${live} is a live row and must not appear in a fixture`);
  }
});

t('character tags obey the characters.ts limits (20 tags, 30 chars each)', () => {
  for (const c of FIX.characters) {
    assert.ok(c.tags.length <= 20, `${c.name}: ${c.tags.length} tags`);
    for (const tag of c.tags) assert.ok(tag.length <= 30, `${c.name}: "${tag}" is ${tag.length} chars`);
  }
});

t('S2 changed no source', () => {
  const locked = [
    'resolveFocus.ts', 'eligibleExtras.ts', 'approveExtras.ts', 'ambient.ts',
    'composeBeat.ts', 'passes.ts', 'renderBeat.ts', 'cast.ts', 'tagsCatalog.ts', 'sceneCatalog.ts',
  ];
  for (const f of locked) {
    const src = fs.readFileSync(path.join(dir, '../apps/server/src/prompt', f), 'utf8');
    assert.equal(/f9-school-fixture/.test(src), false, `${f} carries no S2 edit`);
  }
});

console.log(`passed ${passed}`);
