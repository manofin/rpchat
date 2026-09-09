/** npx tsx bench/storyPeerCastFocus.test.ts
 * ADR-F8e C-focus-β / story-peer-cast-focus.
 * Story rooms: no conversation_partner fallback; only an explicit snapshot
 * participant becomes focus; unnamed turns stay focus null and take Pass N.
 * Isolated: no systemd, no live DB, no model call.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planBeat } from '../apps/server/src/prompt/composeBeat.ts';
import { resolveFocus } from '../apps/server/src/prompt/resolveFocus.ts';
import type { CastMember } from '../apps/server/src/prompt/cast.ts';
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

const member = (o: Partial<CastMember> & { id: string; name: string }): CastMember => ({
  aliases: [],
  duties: [],
  place: '교실',
  role: 'secondary',
  ...o,
});

const CAST: CastMember[] = [
  member({ id: 'hayeon', name: '하연', aliases: ['반장'], place: '교실', role: 'main' }),
  member({ id: 'nari', name: '나리', place: '교실' }),
  member({ id: 'sera', name: '세라', place: '교실' }),
  member({ id: 'soyeon', name: '한소연', place: '사무실' }),
];

const SNAPSHOT = ['hayeon', 'nari', 'sera'];
const PRESENT: Scene = { location: '교실', present_ids: ['hayeon', 'nari', 'sera'] };
const CAT = catalogFromStory(JSON.stringify({
  places: [{ id: '교실', default_focus: 'hayeon' }],
  arcs: ['entry'],
  stagesByArc: { entry: ['reg'] },
  weathers: ['맑음'],
}));

function storyFocus(user_text: string, extra: Record<string, unknown> = {}) {
  return resolveFocus({
    user_text,
    scene: PRESENT,
    cast: CAST,
    catalog: CAT,
    main_character_id: 'hayeon',
    story_room: true,
    participant_ids: SNAPSHOT,
    ...extra,
  } as Parameters<typeof resolveFocus>[0]);
}

function planStory(user_text: string, extra: Record<string, unknown> = {}) {
  return planBeat({
    scene: PRESENT,
    catalog: CAT,
    current_version: 0,
    user_text,
    cast: CAST,
    cards: Object.fromEntries(CAST.map((m) => [m.id, { name: m.name, description: '', personality: '', speech_style: '', taboos: '' }])),
    main_character_id: 'hayeon',
    story_room: true,
    participant_ids: SNAPSHOT,
    ...extra,
  } as Parameters<typeof planBeat>[0]);
}

t('story room: naming the host focuses the host', () => {
  const r = storyFocus('하연');
  assert.equal(r.focus_id, 'hayeon');
  assert.equal(r.reason, 'targeted');
});

t('story room: naming a roster participant focuses that character', () => {
  const r = storyFocus('나리');
  assert.equal(r.focus_id, 'nari');
  assert.equal(r.reason, 'targeted');
});

t('story room: unnamed input is focus null, not conversation_partner', () => {
  const r = storyFocus('안녕하세요');
  assert.equal(r.focus_id, null);
  assert.notEqual(r.reason, 'conversation_partner');
  assert.equal(r.reason, 'none');
});

t('story room: unnamed input does not take location default_focus either', () => {
  const r = storyFocus('교실을 둘러본다.');
  assert.equal(r.focus_id, null);
  assert.notEqual(r.reason, 'default_focus');
  assert.notEqual(r.reason, 'conversation_partner');
});

t('story room: a name outside the snapshot is not promoted', () => {
  const r = storyFocus('한소연', {
    scene: { location: '교실', present_ids: ['hayeon', 'nari', 'sera', 'soyeon'] },
  });
  assert.equal(r.focus_id, null);
  assert.notEqual(r.focus_id, 'soyeon');
  assert.equal(r.reason, 'none');
});

t('story room: alias still targets the snapshot participant', () => {
  assert.equal(storyFocus('반장').focus_id, 'hayeon');
});

t('story room: two named participants keep roster-order pickAddressed when host is not named', () => {
  const r = storyFocus('나리 세라');
  assert.equal(r.focus_id, 'nari');
  assert.equal(r.reason, 'targeted');
});

t('story room: two named participants including the host keep the existing partner tie-break', () => {
  const r = storyFocus('하연 나리');
  assert.equal(r.focus_id, 'hayeon');
  assert.equal(r.reason, 'targeted');
});

t('story room: comitative-only is not an explicit addressee, so no host fallback', () => {
  const r = storyFocus('나리랑 얘기했어');
  assert.equal(r.focus_id, null);
  assert.notEqual(r.reason, 'conversation_partner');
});

t('story room: unresolved does not auto-pick when nobody is named', () => {
  const r = storyFocus('그래서?', {
    scene: { ...PRESENT, last_beat: { focus_id: 'hayeon', extra_ids: [], unresolved: ['nari'] } },
  });
  assert.equal(r.focus_id, null);
  assert.notEqual(r.reason, 'unresolved');
});

t('story room: second person reconfirms last focus when that id is in the snapshot', () => {
  const r = storyFocus('너 지금 뭐라고 했어?', {
    scene: { ...PRESENT, last_beat: { focus_id: 'nari', extra_ids: [], unresolved: [] } },
  });
  assert.equal(r.focus_id, 'nari');
  assert.equal(r.reason, 'targeted');
});

t('NULL snapshot compat: no partner fallback, but a named cast member still focuses', () => {
  const unnamed = storyFocus('안녕하세요', { participant_ids: null });
  assert.equal(unnamed.focus_id, null);
  assert.notEqual(unnamed.reason, 'conversation_partner');
  const named = storyFocus('한소연', {
    participant_ids: null,
    scene: { location: '교실', present_ids: ['hayeon', 'nari', 'sera', 'soyeon'] },
  });
  assert.equal(named.focus_id, 'soyeon');
  assert.equal(named.reason, 'targeted');
});

t('1:1 (no story_room): conversation_partner fallback is unchanged', () => {
  const r = resolveFocus({
    user_text: '안녕하세요',
    scene: PRESENT,
    cast: CAST,
    main_character_id: 'hayeon',
  });
  assert.equal(r.focus_id, 'hayeon');
  assert.equal(r.reason, 'conversation_partner');
});

t('generate: story room unnamed turn plans Pass N and no Pass F, no invented speaker', () => {
  const plan = planStory('안녕하세요');
  assert.equal(plan.focus.focus_id, null);
  assert.notEqual(plan.focus.reason, 'conversation_partner');
  assert.ok(plan.pass_n && plan.pass_n.length > 0, 'Pass N must still be planned');
  assert.equal(plan.pass_f, null);
  assert.deepEqual(plan.assigned.speakers, []);
  assert.deepEqual(plan.approved_extras, []);
  assert.equal(plan.called_model, false);
});

t('generate: story room named participant still plans Pass F for that character', () => {
  const plan = planStory('나리');
  assert.equal(plan.focus.focus_id, 'nari');
  assert.ok(plan.pass_f && plan.pass_f.length > 0);
  assert.equal(plan.assigned.speakers[0]?.character_id, 'nari');
});

t('same story-room input is deterministic', () => {
  const runs = Array.from({ length: 25 }, () => storyFocus('안녕하세요').focus_id);
  assert.deepEqual([...new Set(runs)], [null]);
  const named = Array.from({ length: 25 }, () => storyFocus('세라').focus_id);
  assert.deepEqual([...new Set(named)], ['sera']);
});

t('resolveFocus has no randomness, no model, no extra-score flag flip', () => {
  const s = src('apps/server/src/prompt/resolveFocus.ts');
  for (const banned of ['Math.random', 'llm_reached', 'better-sqlite3', 'fetch(', 'ModelClient', 'EXTRA_SCORE_ENABLED']) {
    assert.equal(s.includes(banned), false, `resolveFocus must not contain ${banned}`);
  }
});

t('chat generate path threads story_room from story_id and reads the snapshot', () => {
  const chat = src('apps/server/src/routes/chat.ts');
  assert.equal(chat.includes('story_room:'), true, 'generate must pass story_room into the planner');
  assert.equal(chat.includes('story_id'), true);
  assert.equal(chat.includes('story_participant_ids_snapshot'), true);
  assert.equal(chat.includes('participant_ids:'), true);
});

t('composeBeat forwards story_room and participant_ids into resolveFocus', () => {
  const s = src('apps/server/src/prompt/composeBeat.ts');
  assert.equal(s.includes('story_room:'), true);
  assert.equal(s.includes('participant_ids:'), true);
});

console.log(`\n${passed} passed`);
