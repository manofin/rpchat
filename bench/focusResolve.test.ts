/**
 * npx tsx bench/focusResolve.test.ts
 * f9-focus-eligible (S2) — §4.1 focus priority. Server-only: no scoring, no model,
 * no random fallback, and "nobody" is a legal answer.
 * Isolated: no systemd, no live DB, no model call, no migration, no live generate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveFocus,
  targetedIds,
  usesSecondPerson,
} from '../apps/server/src/prompt/resolveFocus.ts';
import type { CastMember } from '../apps/server/src/prompt/cast.ts';
import { applySceneDelta, type PartyCatalog } from '../apps/server/src/prompt/applySceneDelta.ts';
import { catalogFromStory } from '../apps/server/src/prompt/sceneCatalog.ts';
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

// ── Notes §7 classroom fixture. Synthetic ids; never live 서리/카이 rows. ──────
const member = (o: Partial<CastMember> & { id: string; name: string }): CastMember => ({
  aliases: [], duties: [], place: '교실', role: 'secondary', ...o,
});

const NARI = member({ id: 'nari', name: '나리', aliases: ['나리쨩'], duties: ['이야기'] });
const SERA = member({ id: 'sera', name: '세라', duties: ['교칙'] });
const HAYEON = member({ id: 'hayeon', name: '하연', duties: ['수업', '담임'], role: 'main' });
const YURA = member({ id: 'yura', name: '유라' });
const LUNA = member({ id: 'luna', name: '루나', talkativeness: 0.8 });
const MIR = member({ id: 'mir', name: '미르', talkativeness: 0.1, locked: true });
const SOYEON = member({ id: 'soyeon', name: '한소연', duties: ['서류'], place: '사무실' });
const YUKI = member({ id: 'yuki', name: '유키', duties: ['경비'], place: '경비실' });
const CROWD = member({ id: 'crowd', name: '학생들', role: 'background' });

const CAST = [NARI, SERA, HAYEON, YURA, LUNA, MIR, SOYEON, YUKI, CROWD];

const CLASSROOM: Scene = {
  location: '교실',
  clock_minutes: 9 * 60 + 37,
  present_ids: ['nari', 'sera', 'hayeon', 'yura', 'luna', 'mir', 'crowd'],
};

const CAT: PartyCatalog = catalogFromStory(JSON.stringify({
  places: [
    { id: '교실', default_focus: 'hayeon' },
    { id: '복도', default_focus: 'mir' },      // locked → not selectable
    { id: '사무실', default_focus: 'soyeon' }, // not in the room → not selectable
  ],
  arcs: ['entry'],
  stagesByArc: { entry: ['reg', 'class'] },
  weathers: ['맑음'],
}));

const focus = (user_text: string, scene: Scene = CLASSROOM) =>
  resolveFocus({ user_text, scene, cast: CAST, catalog: CAT });

// ── 1. §4.1-1 explicit targeting ────────────────────────────────────────────
t('§7 walkthrough: aiming at 나리 makes 나리 the focus', () => {
  const r = focus('나리, 네 이야기 말인데.');
  assert.equal(r.focus_id, 'nari');
  assert.equal(r.reason, 'targeted');
  assert.deepEqual(r.matched_ids, ['nari']);
});

t('@ prefix, bare name, alias and id all target the same person', () => {
  for (const text of ['@나리 왜 그래', '나리 왜 그래', '나리쨩 왜 그래', '@nari 왜 그래']) {
    assert.equal(focus(text).focus_id, 'nari', text);
  }
});

t('Korean particles are stripped, so 나리가 / 나리에게 / 나리를 all target 나리', () => {
  for (const p of ['가', '는', '를', '에게', '한테', '야', '아', '도', '의']) {
    assert.equal(focus(`나리${p} 대답해`).focus_id, 'nari', p);
  }
});

t('matching is exact, never a substring: 세라 does not match 세라핌', () => {
  const cast = [...CAST, member({ id: 'seraphim', name: '세라핌' })];
  const r = resolveFocus({ user_text: '세라핌, 이리 와', scene: { present_ids: ['sera', 'seraphim'] }, cast, catalog: CAT });
  assert.equal(r.focus_id, 'seraphim');
});

// Rules 1-3 each either yield a focus or pass. An unusable *candidate* is not a
// decision, so it falls through. The one exception is genuine ambiguity (two
// usable candidates), which is a hard stop — see the next block.
t('a background character is never matched; the turn falls through to rule 3', () => {
  const r = focus('학생들, 조용히 해');
  assert.deepEqual(r.matched_ids, []);
  assert.notEqual(r.focus_id, 'crowd');
  assert.equal(r.focus_id, 'hayeon');
  assert.equal(r.reason, 'default_focus');
});

// ── 2. ambiguity is silence, not a coin flip ────────────────────────────────
t('naming two present characters yields NO focus (no random pick, no LLM)', () => {
  const r = focus('세라, 하연, 둘 다 들어.');
  assert.equal(r.focus_id, null);
  assert.equal(r.reason, 'none');
  assert.deepEqual(r.matched_ids.sort(), ['hayeon', 'sera']);
});

t('naming an absent character never puts words in their mouth', () => {
  const r = focus('한소연, 서류 좀요.');
  assert.notEqual(r.focus_id, 'soyeon');
  assert.equal(r.reason, 'default_focus');   // 하연 answers; 한소연 is not in the room
  // and with no default available, the beat is simply narration
  assert.equal(focus('한소연, 서류 좀요.', { location: '옥상', present_ids: ['nari'] }).focus_id, null);
});

t('naming a locked character never selects them', () => {
  const r = focus('미르, 헤드폰 벗어');
  assert.notEqual(r.focus_id, 'mir');
  assert.equal(focus('미르, 헤드폰 벗어', { location: '옥상', present_ids: ['mir'] }).focus_id, null);
});

t('naming one present and one absent character resolves to the present one', () => {
  const r = focus('나리랑 한소연 얘기 중이었어');
  assert.equal(r.focus_id, 'nari');
});

// ── 3. §4.1-1b second person only confirms a standing focus ─────────────────
t('second person + a previous focus re-targets that person', () => {
  const scene: Scene = { ...CLASSROOM, last_beat: { focus_id: 'nari', extra_ids: [], unresolved: [] } };
  const r = focus('너 지금 뭐라고 했어?', scene);
  assert.equal(r.focus_id, 'nari');
  assert.equal(r.reason, 'targeted');
});

t('second person with NO previous focus targets nobody (a pronoun is not an introduction)', () => {
  const r = focus('너 지금 뭐라고 했어?');
  assert.notEqual(r.reason, 'targeted');
  assert.deepEqual(r.matched_ids, []);
  // with no location default to fall through to, the beat is narration
  assert.equal(focus('너 지금 뭐라고 했어?', { location: '옥상', present_ids: ['nari'] }).focus_id, null);
});

t('second person does not override an explicit name', () => {
  const scene: Scene = { ...CLASSROOM, last_beat: { focus_id: 'nari', extra_ids: [], unresolved: [] } };
  assert.equal(focus('세라, 너 말이야', scene).focus_id, 'sera');
});

t('a stale previous focus who has left the room is not re-targeted', () => {
  const scene: Scene = { ...CLASSROOM, last_beat: { focus_id: 'soyeon', extra_ids: [], unresolved: [] } };
  const r = focus('너 어디 있어?', scene);
  assert.notEqual(r.focus_id, 'soyeon');
  assert.notEqual(r.reason, 'targeted');
  const noDefault: Scene = { location: '옥상', present_ids: ['nari'], last_beat: { focus_id: 'soyeon', extra_ids: [], unresolved: [] } };
  assert.equal(focus('너 어디 있어?', noDefault).focus_id, null);
});

t('usesSecondPerson matches standalone pronouns only', () => {
  assert.equal(usesSecondPerson('너 뭐해'), true);
  assert.equal(usesSecondPerson('네가 했지'), true);
  assert.equal(usesSecondPerson('당신은 누구'), true);
  assert.equal(usesSecondPerson('너구리를 봤어'), false);
  assert.equal(usesSecondPerson(''), false);
});

// ── 4. §4.1-2 unresolved ────────────────────────────────────────────────────
t('an unresolved party from the last beat takes the focus when nobody is named', () => {
  const scene: Scene = { ...CLASSROOM, last_beat: { focus_id: 'hayeon', extra_ids: [], unresolved: ['nari'] } };
  const r = focus('그래서?', scene);
  assert.equal(r.focus_id, 'nari');
  assert.equal(r.reason, 'unresolved');
});

t('two unresolved parties are ambiguous, so nobody speaks', () => {
  const scene: Scene = { ...CLASSROOM, last_beat: { focus_id: null, extra_ids: [], unresolved: ['nari', 'sera'] } };
  assert.equal(focus('그래서?', scene).focus_id, null);
});

t('an unresolved party who left the room falls through to the location default', () => {
  const scene: Scene = { ...CLASSROOM, last_beat: { focus_id: null, extra_ids: [], unresolved: ['soyeon'] } };
  const r = focus('그래서?', scene);
  assert.equal(r.focus_id, 'hayeon');
  assert.equal(r.reason, 'default_focus');
});

// ── 5. §4.1-3 location default focus ────────────────────────────────────────
t('the location default focus applies when nothing else names anyone', () => {
  const r = focus('교실을 둘러본다.');
  assert.equal(r.focus_id, 'hayeon');
  assert.equal(r.reason, 'default_focus');
});

t('a default focus who is locked or absent is skipped, not forced', () => {
  const hallway: Scene = { location: '복도', present_ids: ['mir'] };      // default = locked 미르
  assert.equal(resolveFocus({ user_text: '걷는다', scene: hallway, cast: CAST, catalog: CAT }).focus_id, null);
  const office: Scene = { location: '사무실', present_ids: ['nari'] };    // default = absent 한소연
  assert.equal(resolveFocus({ user_text: '걷는다', scene: office, cast: CAST, catalog: CAT }).focus_id, null);
});

t('a location with no catalog entry has no default focus', () => {
  assert.equal(focus('둘러본다', { location: '옥상', present_ids: ['nari'] }).focus_id, null);
  // and with no catalog at all
  assert.equal(resolveFocus({ user_text: '둘러본다', scene: CLASSROOM, cast: CAST }).focus_id, null);
});

// ── 6. §4.1-4 no focus at all ───────────────────────────────────────────────
t('an empty room yields no focus', () => {
  assert.equal(focus('아무도 없다', { location: '교실', present_ids: [] }).focus_id, null);
});

t('an empty cast yields no focus and does not throw', () => {
  assert.equal(resolveFocus({ user_text: '나리', scene: CLASSROOM, cast: [], catalog: CAT }).focus_id, null);
});

t('empty user text still resolves through priority 2 and 3, never randomly', () => {
  assert.equal(focus('').focus_id, 'hayeon');
  assert.equal(focus('', { location: '옥상', present_ids: ['nari'] }).focus_id, null);
});

// ── 7. determinism and A-5 ordering ─────────────────────────────────────────
t('the same input always yields the same focus (no draw anywhere)', () => {
  const runs = Array.from({ length: 25 }, () => focus('교실을 둘러본다.').focus_id);
  assert.deepEqual([...new Set(runs)], ['hayeon']);
});

t('A-5: focus is read from the POST-apply scene, not the pre-apply one', () => {
  const before: Scene = { location: '교실', present_ids: ['nari', 'hayeon'], scene_version: 0 };
  // The user moves the scene to a location whose default focus is someone else.
  const applied = applySceneDelta(before, { base_version: 0, location: '사무실' }, CAT, 0);
  assert.equal(applied.state.location, '사무실');

  const pre = resolveFocus({ user_text: '이동한다', scene: before, cast: CAST, catalog: CAT });
  const post = resolveFocus({ user_text: '이동한다', scene: applied.state, cast: CAST, catalog: CAT });
  assert.equal(pre.focus_id, 'hayeon');   // stale: still answering as the classroom
  assert.equal(post.focus_id, null);      // 한소연 is the office default but is not present
  assert.notEqual(pre.focus_id, post.focus_id);
});

t('targetedIds is exported for reuse and reports every match', () => {
  assert.deepEqual(targetedIds('세라 하연', CAST).sort(), ['hayeon', 'sera']);
  assert.deepEqual(targetedIds('', CAST), []);
});

// ── 8. source fences ────────────────────────────────────────────────────────
t('the focus resolver has no randomness, no model, no DB', () => {
  const s = src('apps/server/src/prompt/resolveFocus.ts');
  for (const banned of ['Math.random', 'llm_reached', 'decided_stage', 'better-sqlite3', 'fetch(', 'ModelClient', '../db/']) {
    assert.equal(s.includes(banned), false, `resolveFocus must not contain ${banned}`);
  }
});

t('the retired F9C router is gone from product code', () => {
  assert.equal(fs.existsSync(path.join(appRoot, 'apps/server/src/prompt/pickSpeaker.ts')), false);
  const files = fs.readdirSync(path.join(appRoot, 'apps/server/src/prompt'));
  for (const f of files) {
    const s = src(`apps/server/src/prompt/${f}`);
    assert.equal(/from '\.\/pickSpeaker/.test(s), false, `${f} still imports the retired router`);
  }
});

t('assignSpeakers no longer falls back to the conversation main character', () => {
  const s = src('apps/server/src/prompt/assignSpeakers.ts');
  assert.equal(/\? main_speaker_id\s*\n?\s*: main_character_id/.test(s), false);
  assert.ok(s.includes(': null'), 'no focus must resolve to null, not to a host');
});

console.log(`\n${passed} passed`);
