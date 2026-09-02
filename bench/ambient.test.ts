/**
 * npx tsx bench/ambient.test.ts
 * f9-focus-eligible (S2) — §4.4 talkativeness in its correct place.
 * Ambient produces narration points, never dialogue slots, and is deterministic.
 * Isolated: no systemd, no live DB, no model call, no migration, no live generate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AMBIENT_MAX, ambientPicks, ambientSeed, seedHash } from '../apps/server/src/prompt/ambient.ts';
import { DEFAULT_TALKATIVENESS, talkativenessOf, type CastMember } from '../apps/server/src/prompt/cast.ts';
import { parsePartyTags, castFromCharacters } from '../apps/server/src/prompt/tagsCatalog.ts';
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
/** Source with comments stripped — fences must bind on code, not on prose naming a symbol. */
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── Notes §4.4 fixture: 루나 0.8, 유라 0.4, 미르 0.1 ──────────────────────────
const member = (o: Partial<CastMember> & { id: string; name: string }): CastMember => ({
  aliases: [], duties: [], place: '교실', role: 'secondary', ...o,
});

const NARI = member({ id: 'nari', name: '나리' });
const SERA = member({ id: 'sera', name: '세라' });
const HAYEON = member({ id: 'hayeon', name: '하연', role: 'main' });
const YURA = member({ id: 'yura', name: '유라', talkativeness: 0.4 });
const LUNA = member({ id: 'luna', name: '루나', talkativeness: 0.8 });
const MIR = member({ id: 'mir', name: '미르', talkativeness: 0.1 });
const CROWD = member({ id: 'crowd', name: '학생들', role: 'background', talkativeness: 0.5 });
const SOYEON = member({ id: 'soyeon', name: '한소연', place: '사무실', talkativeness: 0.9 });

const CAST = [NARI, SERA, HAYEON, YURA, LUNA, MIR, CROWD, SOYEON];

const CLASSROOM: Scene = {
  location: '교실',
  clock_minutes: 9 * 60 + 37,
  scene_version: 3,
  present_ids: ['nari', 'sera', 'hayeon', 'yura', 'luna', 'mir', 'crowd'],
};

const pick = (o: Partial<Parameters<typeof ambientPicks>[0]> = {}) =>
  ambientPicks({ cast: CAST, scene: CLASSROOM, focus_id: 'nari', extra_ids: ['sera', 'hayeon'], seed: 'beat-1', ...o });

const ids = (r: ReturnType<typeof ambientPicks>) => r.map((p) => p.character_id);

// ── 1. ambient never becomes speech ─────────────────────────────────────────
t('an AmbientPick carries no text field — the shape cannot become a line', () => {
  for (const p of pick()) {
    assert.deepEqual(Object.keys(p).sort(), ['character_id', 'name', 'weight']);
    assert.equal('text' in p, false);
    assert.equal('slot' in p, false);
  }
});

t('the module builds no speaker block and no dialogue slot', () => {
  const s = code('apps/server/src/prompt/ambient.ts');
  assert.equal(/이름\s*\|/.test(s), false, 'no 이름| block may be constructed here');
  assert.equal(/'line'|"line"|slot/.test(s), false, 'ambient must not know about slots');
  assert.equal(/assignSpeakers|approveExtras/.test(s), false);
});

t('talkativeness is not consulted anywhere that selects a speaker', () => {
  for (const f of ['resolveFocus.ts', 'eligibleExtras.ts', 'assignSpeakers.ts']) {
    const s = code(`apps/server/src/prompt/${f}`);
    assert.equal(/talkativeness|talkativenessOf/.test(s), false, `${f} must not read talkativeness`);
  }
});

// ── 2. candidate set: the people with no line this turn ─────────────────────
t('the focus and the approved extras are excluded — they already speak', () => {
  const got = ids(pick());
  assert.equal(got.includes('nari'), false);
  assert.equal(got.includes('sera'), false);
  assert.equal(got.includes('hayeon'), false);
});

t('absent characters get no ambient mention however talkative', () => {
  assert.equal(talkativenessOf(SOYEON), 0.9);
  assert.equal(ids(pick()).includes('soyeon'), false);
});

t('locked characters get no ambient mention', () => {
  const cast = CAST.map((m) => (m.id === 'luna' ? { ...m, locked: true } : m));
  assert.equal(ids(pick({ cast })).includes('luna'), false);
});

t('background characters DO get ambient mentions — that is their whole role', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) for (const id of ids(pick({ seed: `s${i}` }))) seen.add(id);
  assert.ok(seen.has('crowd'), 'a background NPC exists in narration');
  // …but never anywhere a slot is assigned. The role tag now has exactly one
  // parser and one predicate, so this fence binds on the predicate, not on an
  // inline comparison that any module could re-spell.
  assert.ok(code('apps/server/src/prompt/assignSpeakers.ts').includes('isBackground(member)'));
  assert.ok(code('apps/server/src/prompt/cast.ts').includes("return m.role === 'background'"));
  for (const f of ['assignSpeakers.ts', 'eligibleExtras.ts', 'approveExtras.ts', 'resolveFocus.ts', 'composeBeat.ts', 'ambient.ts']) {
    assert.equal(/role [!=]== 'background'/.test(code(`apps/server/src/prompt/${f}`)), false,
      `${f} must go through canSpeak/isBackground, not re-spell the tag`);
  }
});

// ── 3. weighting: talkative is noticed more, quiet is never impossible ──────
t('§4.4 weights: 루나 0.8 is mentioned more often than 미르 0.1 across turns', () => {
  let luna = 0;
  let mir = 0;
  for (let i = 0; i < 400; i++) {
    const got = ids(pick({ seed: `turn-${i}`, max: 1 }));
    if (got[0] === 'luna') luna++;
    if (got[0] === 'mir') mir++;
  }
  assert.ok(luna > mir * 3, `루나 ${luna} vs 미르 ${mir}`);
  assert.ok(mir > 0, 'a quiet character is rare, not impossible');
});

t('a talkative character is not mentioned every single turn', () => {
  const turns = Array.from({ length: 60 }, (_, i) => ids(pick({ seed: `turn-${i}`, max: 1 })));
  assert.ok(turns.some((got) => got[0] !== 'luna'), '0.8 must not mean always');
});

t('an untagged character uses the declared default weight, not zero', () => {
  assert.equal(talkativenessOf(NARI), DEFAULT_TALKATIVENESS);
  assert.equal(DEFAULT_TALKATIVENESS > 0, true);
  const cast = [YURA, member({ id: 'x', name: 'X' })];
  const seen = new Set<string>();
  for (let i = 0; i < 60; i++) for (const id of ids(pick({ cast, scene: { location: '교실' }, focus_id: null, extra_ids: [], seed: `s${i}`, max: 1 }))) seen.add(id);
  assert.ok(seen.has('x'), 'an untagged character is still noticed sometimes');
});

t('out-of-range or unparseable weights clamp instead of throwing', () => {
  assert.equal(talkativenessOf(member({ id: 'a', name: 'A', talkativeness: 5 })), 1);
  assert.equal(talkativenessOf(member({ id: 'a', name: 'A', talkativeness: -1 })), 0);
  assert.equal(talkativenessOf(member({ id: 'a', name: 'A', talkativeness: NaN })), DEFAULT_TALKATIVENESS);
});

// ── 4. determinism ──────────────────────────────────────────────────────────
t('the same seed and scene always yield the same picks', () => {
  const first = ids(pick());
  for (let i = 0; i < 30; i++) assert.deepEqual(ids(pick()), first);
});

t('a different beat yields a different draw', () => {
  const seeds = Array.from({ length: 12 }, (_, i) => ids(pick({ seed: `beat-${i}` })).join(','));
  assert.ok(new Set(seeds).size > 1, 'the seed must actually vary the outcome');
});

t('no Math.random anywhere in the module', () => {
  assert.equal(code('apps/server/src/prompt/ambient.ts').includes('Math.random'), false);
});

t('ambientSeed is stable per beat and moves with the scene version', () => {
  const a = ambientSeed('conv-1', CLASSROOM, 'msg-1');
  assert.equal(a, ambientSeed('conv-1', CLASSROOM, 'msg-1'));
  assert.notEqual(a, ambientSeed('conv-1', { ...CLASSROOM, scene_version: 4 }, 'msg-1'));
  assert.notEqual(a, ambientSeed('conv-2', CLASSROOM, 'msg-1'));
  assert.notEqual(a, ambientSeed('conv-1', CLASSROOM, 'msg-2'));
});

t('seedHash is a stable unsigned 32-bit value', () => {
  const h = seedHash('abc');
  assert.equal(h, seedHash('abc'));
  assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff);
  assert.notEqual(seedHash('abc'), seedHash('abd'));
});

// ── 5. bounds and degenerate input ──────────────────────────────────────────
t('at most AMBIENT_MAX picks, and max: 0 yields none', () => {
  assert.ok(pick().length <= AMBIENT_MAX);
  assert.deepEqual(pick({ max: 0 }), []);
  assert.equal(pick({ max: 1 }).length, 1);
});

t('an empty room yields no picks and does not throw', () => {
  assert.deepEqual(pick({ scene: { location: '교실', present_ids: [] } }), []);
  assert.deepEqual(pick({ cast: [] }), []);
});

t('a zero-weight character is never picked', () => {
  const cast = [member({ id: 'z', name: 'Z', talkativeness: 0 }), LUNA];
  for (let i = 0; i < 50; i++) {
    assert.equal(ids(pick({ cast, seed: `s${i}` })).includes('z'), false);
  }
});

// ── 6. the tag that feeds it ────────────────────────────────────────────────
t('party:talkative / party:locked / party:outfit parse into the cast row', () => {
  const parsed = parsePartyTags(['party:role=secondary', 'party:talkative=0.8', 'party:locked=1', 'party:outfit=교복']);
  assert.equal(parsed.talkativeness, 0.8);
  assert.equal(parsed.locked, true);
  assert.equal(parsed.outfit, '교복');
});

t('an out-of-range party:talkative leaves the default in place', () => {
  assert.equal(parsePartyTags(['party:role=main', 'party:talkative=9']).talkativeness, undefined);
  assert.equal(parsePartyTags(['party:role=main', 'party:talkative=abc']).talkativeness, undefined);
  assert.equal(parsePartyTags(['party:role=main']).talkativeness, undefined);
  assert.equal(parsePartyTags(['party:role=main']).locked, false);
});

t('castFromCharacters carries the new keys through, omitting unset ones', () => {
  const rows = [
    { id: 'a', name: 'A', tags_json: '["party:role=main","party:talkative=0.8","party:outfit=교복"]' },
    { id: 'b', name: 'B', tags_json: '["party:role=secondary","party:locked=1"]' },
  ];
  const cast = castFromCharacters(rows, 'a')!;
  const a = cast.find((c) => c.id === 'a')!;
  const b = cast.find((c) => c.id === 'b')!;
  assert.equal(a.talkativeness, 0.8);
  assert.equal(a.outfit, '교복');
  assert.equal('locked' in a, false, 'unset keys stay absent so defaults apply');
  assert.equal(b.locked, true);
  assert.equal(talkativenessOf(b), DEFAULT_TALKATIVENESS);
});

console.log(`\n${passed} passed`);
