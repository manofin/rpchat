/** npx tsx bench/storyPeerCastGenerateContract.test.ts
 * ADR-F8e C-focus-β generate contract / story-peer-cast-generate-contract.
 * Story rooms: unnamed turns stay focus null and plan Pass N only.
 * Host or other participants must not receive an auto-dialogue slot.
 * Isolated: no systemd, no live DB, no model call.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planBeat } from '../apps/server/src/prompt/composeBeat.ts';
import { planDialogBeat } from '../apps/server/src/prompt/composeDialog.ts';
import { planHunterBeat } from '../apps/server/src/prompt/composeHunter.ts';
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

const CARDS = Object.fromEntries(
  CAST.map((m) => [m.id, { name: m.name, description: '', personality: '', speech_style: '', taboos: '' }]),
);

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

function planStoryBeat(user_text: string, extra: Record<string, unknown> = {}) {
  return planBeat({
    scene: PRESENT,
    catalog: CAT,
    current_version: 0,
    user_text,
    cast: CAST,
    cards: CARDS,
    main_character_id: 'hayeon',
    story_room: true,
    participant_ids: SNAPSHOT,
    ...extra,
  } as Parameters<typeof planBeat>[0]);
}

function planStoryDialog(user_text: string, extra: Record<string, unknown> = {}) {
  return planDialogBeat({
    scene: PRESENT,
    catalog: CAT,
    current_version: 0,
    user_text,
    cast: CAST,
    cards: CARDS,
    main_character_id: 'hayeon',
    story_room: true,
    participant_ids: SNAPSHOT,
    ...extra,
  } as Parameters<typeof planDialogBeat>[0]);
}

function planStoryHunter(user_text: string, extra: Record<string, unknown> = {}) {
  return planHunterBeat({
    scene: PRESENT,
    catalog: CAT,
    current_version: 0,
    user_text,
    cast: CAST,
    cards: CARDS,
    main_character_id: 'hayeon',
    story_room: true,
    participant_ids: SNAPSHOT,
    ...extra,
  } as Parameters<typeof planHunterBeat>[0]);
}

t('ok 1 story room with no explicit mention resolves focus:null', () => {
  const r = storyFocus('안녕하세요');
  assert.equal(r.focus_id, null);
  assert.equal(r.reason, 'none');
});

t('ok 2 focus:null produces Pass N narration', () => {
  const plan = planStoryBeat('교실을 둘러본다.');
  assert.equal(plan.focus.focus_id, null);
  assert.ok(plan.pass_n && plan.pass_n.length > 0);
  assert.ok(plan.pass_n.includes('어떤 인물의 대사도 쓰지 않는다'));
  assert.equal(plan.pass_f, null);
});

t('ok 3 focus:null does not inject host dialogue', () => {
  const beat = planStoryBeat('안녕하세요');
  assert.equal(beat.pass_f, null);
  assert.equal(beat.assigned.speakers.some((s) => s.character_id === 'hayeon'), false);
  assert.equal(beat.messages.some((m) => m.speaker_character_id === 'hayeon'), false);

  const dialog = planStoryDialog('안녕하세요');
  assert.equal(dialog.focus.focus_id, null);
  assert.equal(dialog.speakers.some((s) => s.id === 'hayeon'), false);

  const hunter = planStoryHunter('안녕하세요');
  assert.equal(hunter.focus.focus_id, null);
  assert.equal(hunter.speakers.some((s) => s.id === 'hayeon'), false);
});

t('ok 4 focus:null does not inject another participant dialogue', () => {
  const beat = planStoryBeat('안녕하세요');
  assert.deepEqual(beat.assigned.speakers, []);
  assert.deepEqual(beat.approved_extras, []);
  assert.deepEqual(beat.messages, []);

  const dialog = planStoryDialog('안녕하세요');
  assert.deepEqual(dialog.speakers, []);

  const hunter = planStoryHunter('안녕하세요');
  assert.deepEqual(hunter.speakers, []);
});

t('ok 5 explicit participant mention permits that participant focus', () => {
  const beat = planStoryBeat('나리');
  assert.equal(beat.focus.focus_id, 'nari');
  assert.ok(beat.pass_f && beat.pass_f.length > 0);
  assert.equal(beat.assigned.speakers[0]?.character_id, 'nari');

  const dialog = planStoryDialog('나리');
  assert.equal(dialog.focus.focus_id, 'nari');
  assert.equal(dialog.speakers[0]?.id, 'nari');

  const hunter = planStoryHunter('나리');
  assert.equal(hunter.focus.focus_id, 'nari');
  assert.equal(hunter.speakers[0]?.id, 'nari');
});

t('ok 6 participant outside snapshot is not promoted', () => {
  const extra = {
    scene: { location: '교실', present_ids: ['hayeon', 'nari', 'sera', 'soyeon'] },
  };
  assert.equal(storyFocus('한소연', extra).focus_id, null);
  assert.equal(planStoryBeat('한소연', extra).focus.focus_id, null);
  assert.equal(planStoryBeat('한소연', extra).pass_f, null);
  assert.equal(planStoryDialog('한소연', extra).focus.focus_id, null);
  assert.deepEqual(planStoryDialog('한소연', extra).speakers, []);
  assert.equal(planStoryHunter('한소연', extra).focus.focus_id, null);
  assert.deepEqual(planStoryHunter('한소연', extra).speakers, []);
});

t('ok 7 conversation_partner fallback is absent in story rooms', () => {
  const r = storyFocus('안녕하세요');
  assert.notEqual(r.reason, 'conversation_partner');
  assert.equal(planStoryBeat('안녕하세요').focus.reason, 'none');
  assert.equal(planStoryDialog('안녕하세요').focus.reason, 'none');
  assert.equal(planStoryHunter('안녕하세요').focus.reason, 'none');
});

t('ok 8 one-to-one conversation retains its existing fallback', () => {
  const r = resolveFocus({
    user_text: '안녕하세요',
    scene: PRESENT,
    cast: CAST,
    main_character_id: 'hayeon',
  });
  assert.equal(r.focus_id, 'hayeon');
  assert.equal(r.reason, 'conversation_partner');

  const beat = planBeat({
    scene: PRESENT,
    catalog: CAT,
    current_version: 0,
    user_text: '안녕하세요',
    cast: CAST,
    cards: CARDS,
    main_character_id: 'hayeon',
  });
  assert.equal(beat.focus.focus_id, 'hayeon');
  assert.notEqual(beat.focus.focus_id, null);
  assert.notEqual(beat.focus.reason, 'none');
  assert.ok(beat.pass_f && beat.pass_f.length > 0);
  assert.equal(beat.assigned.speakers[0]?.character_id, 'hayeon');

  const dialog = planDialogBeat({
    scene: PRESENT,
    catalog: CAT,
    current_version: 0,
    user_text: '안녕하세요',
    cast: CAST,
    cards: CARDS,
    main_character_id: 'hayeon',
  });
  assert.equal(dialog.focus.focus_id, 'hayeon');
  assert.equal(dialog.speakers[0]?.id, 'hayeon');
});

t('ok 9 no scoring, randomness, or extra router call is introduced', () => {
  const banned = ['Math.random', 'llm_reached', 'fetch(', 'ModelClient', 'EXTRA_SCORE_ENABLED'];
  for (const rel of [
    'apps/server/src/prompt/composeBeat.ts',
    'apps/server/src/prompt/composeDialog.ts',
    'apps/server/src/prompt/composeHunter.ts',
    'apps/server/src/prompt/resolveFocus.ts',
    'apps/server/src/routes/chat.ts',
  ]) {
    const s = src(rel);
    for (const token of banned) {
      assert.equal(s.includes(token), false, `${rel} must not contain ${token}`);
    }
  }
  const chat = src('apps/server/src/routes/chat.ts');
  assert.equal(chat.includes('approveStoryExtras'), false);
  assert.equal(chat.includes('storyFocusPlanFields'), true);
});

t('ok 10 start-ui and schema contracts remain unchanged', () => {
  const helper = src('apps/web/src/lib/storyStartRequest.ts');
  assert.equal(helper.includes('mode: \'story\''), true);
  assert.equal(helper.includes('participantIds'), true);
  const page = src('apps/web/src/pages/StoryPage.tsx');
  assert.equal(page.includes('buildStoryStartRequest'), true);
  const conv = src('apps/server/src/routes/conversations.ts');
  assert.equal(conv.includes('participantIds'), true);
  assert.equal(conv.includes('story_participant_ids_snapshot'), true);
});

console.log(`\n${passed} passed`);
