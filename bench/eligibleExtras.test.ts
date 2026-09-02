/**
 * npx tsx bench/eligibleExtras.test.ts
 * f9-focus-eligible (S2) — §4.2 closed candidate set.
 * Eligibility only. Opening a slot is §4.3 (S3), and this bench asserts that the
 * two stay separate: a full eligible list is not an approval.
 * Isolated: no systemd, no live DB, no model call, no migration, no live generate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eligibleExtras } from '../apps/server/src/prompt/eligibleExtras.ts';
import { assignSpeakers, MAX_EXTRAS } from '../apps/server/src/prompt/assignSpeakers.ts';
import { inRoom, outOfRoom, excludeUser } from '../apps/server/src/prompt/presence.ts';
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
const src = (rel: string) => fs.readFileSync(path.join(appRoot, rel), 'utf8');

// ── Notes §7 fixture. Synthetic ids; never live 서리/카이 rows. ────────────────
const member = (o: Partial<CastMember> & { id: string; name: string }): CastMember => ({
  aliases: [], duties: [], place: '교실', role: 'secondary', ...o,
});

const NARI = member({ id: 'nari', name: '나리', duties: ['이야기'] });
const SERA = member({ id: 'sera', name: '세라', duties: ['교칙'] });
const HAYEON = member({ id: 'hayeon', name: '하연', duties: ['수업'], role: 'main' });
const YURA = member({ id: 'yura', name: '유라' });
const LUNA = member({ id: 'luna', name: '루나', talkativeness: 0.8 });
const MIR = member({ id: 'mir', name: '미르', talkativeness: 0.1, locked: true });
const SOYEON = member({ id: 'soyeon', name: '한소연', duties: ['서류'], place: '사무실' });
const YUKI = member({ id: 'yuki', name: '유키', duties: ['경비'], place: '경비실' });
const CROWD = member({ id: 'crowd', name: '학생들', role: 'background' });
const USER = member({ id: 'jimyeong', name: '황지명' });

const CAST = [NARI, SERA, HAYEON, YURA, LUNA, MIR, SOYEON, YUKI, CROWD, USER];

const CLASSROOM: Scene = {
  location: '교실',
  present_ids: ['nari', 'sera', 'hayeon', 'yura', 'luna', 'mir', 'crowd', 'jimyeong'],
};

const run = (o: Partial<Parameters<typeof eligibleExtras>[0]> = {}) =>
  eligibleExtras({ cast: CAST, scene: CLASSROOM, focus_id: 'nari', user_id: 'jimyeong', ...o });

const why = (r: ReturnType<typeof eligibleExtras>, id: string) =>
  r.rejected.find((x) => x.id === id)?.reason;

// ── 1. the §7 walkthrough set ───────────────────────────────────────────────
t('§7: eligible = {세라, 하연, 유라, 루나} — 미르 locked, 한소연·유키 absent', () => {
  const r = run();
  assert.deepEqual(r.eligible_ids, ['sera', 'hayeon', 'yura', 'luna']);
});

t('every exclusion records why, so a zero-extra beat is explainable', () => {
  const r = run();
  assert.equal(why(r, 'nari'), 'is_focus');
  assert.equal(why(r, 'jimyeong'), 'is_user');
  assert.equal(why(r, 'mir'), 'locked');
  assert.equal(why(r, 'crowd'), 'background');
  assert.equal(why(r, 'soyeon'), 'place');
  assert.equal(why(r, 'yuki'), 'place');
});

t('§4.2: 한소연·유키 are cut by place even though their duties fit the scene', () => {
  const r = run();
  assert.ok(SOYEON.duties.includes('서류') && YUKI.duties.includes('경비'));
  assert.equal(r.eligible_ids.includes('soyeon'), false);
  assert.equal(r.eligible_ids.includes('yuki'), false);
  assert.equal(why(r, 'yuki'), 'place');
});

// ── 2. each cut in isolation ────────────────────────────────────────────────
t('the focus is never their own extra', () => {
  for (const id of ['nari', 'sera', 'hayeon']) {
    assert.equal(run({ focus_id: id }).eligible_ids.includes(id), false, id);
  }
});

t('the user is cut even when present in the roster', () => {
  assert.equal(run().eligible_ids.includes('jimyeong'), false);
  // and without a user_id the roster row would otherwise survive
  assert.equal(run({ user_id: null }).eligible_ids.includes('jimyeong'), true);
});

t('a background character never becomes a candidate', () => {
  assert.equal(run({ focus_id: null }).eligible_ids.includes('crowd'), false);
});

t('a locked character never becomes a candidate', () => {
  assert.equal(run().eligible_ids.includes('mir'), false);
});

// ── 3. self-repeat (ST Allow Self Responses = off) ──────────────────────────
t('whoever took an extra slot last beat cannot take one again immediately', () => {
  const scene: Scene = { ...CLASSROOM, last_beat: { focus_id: 'nari', extra_ids: ['sera', 'hayeon'], unresolved: [] } };
  const r = run({ scene });
  assert.deepEqual(r.eligible_ids, ['yura', 'luna']);
  assert.equal(why(r, 'sera'), 'self_repeat');
  assert.equal(why(r, 'hayeon'), 'self_repeat');
});

t('an explicit previous_extra_ids overrides what the scene remembers', () => {
  const scene: Scene = { ...CLASSROOM, last_beat: { focus_id: 'nari', extra_ids: ['sera'], unresolved: [] } };
  assert.deepEqual(run({ scene, previous_extra_ids: ['luna'] }).eligible_ids, ['sera', 'hayeon', 'yura']);
  assert.deepEqual(run({ scene, previous_extra_ids: [] }).eligible_ids, ['sera', 'hayeon', 'yura', 'luna']);
});

t('a repeat block lasts exactly one beat', () => {
  const beat1: Scene = { ...CLASSROOM, last_beat: { focus_id: 'nari', extra_ids: ['sera'], unresolved: [] } };
  assert.equal(run({ scene: beat1 }).eligible_ids.includes('sera'), false);
  const beat2: Scene = { ...CLASSROOM, last_beat: { focus_id: 'nari', extra_ids: ['yura'], unresolved: [] } };
  assert.equal(run({ scene: beat2 }).eligible_ids.includes('sera'), true);
});

// ── 4. presence semantics ───────────────────────────────────────────────────
t('a scene that never declared occupancy does not cut anyone on place', () => {
  const r = run({ scene: { location: '교실' } });
  assert.ok(r.eligible_ids.includes('soyeon'));
  assert.ok(r.eligible_ids.includes('yuki'));
  assert.equal(r.rejected.some((x) => x.reason === 'place'), false);
});

t('an empty declared occupancy means nobody, not "fall back to tags"', () => {
  const r = run({ scene: { location: '교실', present_ids: [] } });
  assert.deepEqual(r.eligible_ids, []);
});

t('presence helpers split the roster the way §4.2 subtracts it', () => {
  const cast = excludeUser(CAST, 'jimyeong');
  assert.equal(cast.some((m) => m.id === 'jimyeong'), false);
  assert.deepEqual(inRoom(cast, CLASSROOM).map((m) => m.id), ['nari', 'sera', 'hayeon', 'yura', 'luna', 'mir', 'crowd']);
  assert.deepEqual(outOfRoom(cast, CLASSROOM).map((m) => m.id), ['soyeon', 'yuki']);
});

// ── 5. eligibility is not approval ──────────────────────────────────────────
t('a full eligible list opens no slot on its own — approval is separate (§4.3)', () => {
  const r = run();
  assert.equal(r.eligible_ids.length, 4);
  // assignSpeakers is only ever handed APPROVED ids; handed none, nobody speaks.
  const out = assignSpeakers({
    scores: {}, cast: CAST, main_character_id: 'hayeon', main_speaker_id: 'nari',
    eligible_secondary_ids: [],
  });
  assert.deepEqual(out.speakers.map((s) => s.slot), ['main']);
});

t('approval is still capped at MAX_EXTRAS even if more ids are handed over', () => {
  const out = assignSpeakers({
    scores: {}, cast: CAST, main_character_id: 'hayeon', main_speaker_id: 'nari',
    eligible_secondary_ids: ['sera', 'hayeon', 'yura', 'luna'],
  });
  assert.equal(MAX_EXTRAS, 2);
  assert.equal(out.speakers.filter((s) => s.slot === 'extra').length, 2);
});

t('with no focus there are no extras, whatever the eligible set says', () => {
  const r = run({ focus_id: null });
  assert.ok(r.eligible_ids.length > 0);
  const out = assignSpeakers({
    scores: {}, cast: CAST, main_character_id: 'hayeon', main_speaker_id: null,
    eligible_secondary_ids: r.eligible_ids,
  });
  assert.deepEqual(out.speakers, []);
});

// ── 6. shape and purity ─────────────────────────────────────────────────────
t('order follows the cast, and duplicates are collapsed', () => {
  const r = eligibleExtras({ cast: [SERA, LUNA, SERA, YURA], scene: CLASSROOM, focus_id: 'nari' });
  assert.deepEqual(r.eligible_ids, ['sera', 'luna', 'yura']);
});

t('an empty cast yields an empty set and does not throw', () => {
  assert.deepEqual(eligibleExtras({ cast: [], scene: CLASSROOM, focus_id: 'nari' }),
    { eligible_ids: [], rejected: [] });
});

t('the module is pure: no db, fetch, model, randomness', () => {
  const s = src('apps/server/src/prompt/eligibleExtras.ts');
  for (const banned of ['better-sqlite3', 'fetch(', 'ModelClient', '../db/', 'Math.random', 'secondary_triggers']) {
    assert.equal(s.includes(banned), false, `eligibleExtras must not contain ${banned}`);
  }
});

t('it names no candidate the roster does not contain', () => {
  const r = run();
  const known = new Set(CAST.map((m) => m.id));
  for (const id of r.eligible_ids) assert.ok(known.has(id), id);
  for (const x of r.rejected) assert.ok(known.has(x.id), x.id);
});

console.log(`\n${passed} passed`);
