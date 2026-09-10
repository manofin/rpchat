/** npx tsx bench/storyPeerCastGenerate.test.ts
 * ADR-F8e generate remainder: untagged snapshot ≥ 2 → beat cast; extras C1.
 * Isolated: no systemd, no live DB, no model call.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planBeat, storyCastForGenerate, partyCastForGenerate } from '../apps/server/src/prompt/composeBeat.ts';
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

const untagged = (id: string, name: string) => ({ id, name, tags_json: '["일상"]' });
const HAYEON = untagged('hayeon', '하연');
const NARI = untagged('nari', '나리');
const SERA = untagged('sera', '세라');

t('untagged snapshot of 2 yields a beat cast (E1, no party: tag required)', () => {
  const cast = storyCastForGenerate(
    { character_id: 'hayeon', story_id: 's1', story_participant_ids_snapshot: JSON.stringify(['hayeon', 'nari']) },
    [HAYEON, NARI],
  );
  assert.ok(cast);
  assert.equal(cast!.length, 2);
  assert.deepEqual(cast!.map((c) => c.id).sort(), ['hayeon', 'nari']);
});

t('tagged partyCastForGenerate still returns null for the same untagged roster', () => {
  assert.equal(partyCastForGenerate({ character_id: 'hayeon' }, [HAYEON, NARI]), null);
});

t('snapshot of 1 is 1:1 (F1) — null cast', () => {
  assert.equal(
    storyCastForGenerate(
      { character_id: 'hayeon', story_id: 's1', story_participant_ids_snapshot: JSON.stringify(['hayeon']) },
      [HAYEON, NARI],
    ),
    null,
  );
});

t('no story_id is null', () => {
  assert.equal(
    storyCastForGenerate(
      { character_id: 'hayeon', story_id: null, story_participant_ids_snapshot: JSON.stringify(['hayeon', 'nari']) },
      [HAYEON, NARI],
    ),
    null,
  );
});

t('NULL snapshot keeps the tagged gate (legacy rooms)', () => {
  assert.equal(
    storyCastForGenerate(
      { character_id: 'hayeon', story_id: 's1', story_participant_ids_snapshot: null },
      [HAYEON, NARI],
    ),
    null,
  );
});

const member = (o: Partial<CastMember> & { id: string; name: string }): CastMember => ({
  aliases: [],
  duties: [],
  place: '교실',
  role: 'secondary',
  ...o,
});
const CAST: CastMember[] = [
  member({ id: 'hayeon', name: '하연', place: '교실', role: 'main' }),
  member({ id: 'nari', name: '나리', place: '교실' }),
  member({ id: 'sera', name: '세라', place: '교실' }),
];
const PRESENT: Scene = { location: '교실', present_ids: ['hayeon', 'nari', 'sera'] };
const CAT = catalogFromStory(JSON.stringify({
  places: [{ id: '교실', default_focus: 'hayeon' }],
  arcs: ['entry'],
  stagesByArc: { entry: ['reg'] },
  weathers: ['맑음'],
}));
const CARDS = Object.fromEntries(CAST.map((m) => [m.id, { name: m.name, description: '', personality: '', speech_style: '', taboos: '' }]));

t('story_room focused turn opens extras among peers (C1)', () => {
  const plan = planBeat({
    scene: PRESENT,
    catalog: CAT,
    current_version: 0,
    user_text: '하연',
    cast: CAST,
    cards: CARDS,
    main_character_id: 'hayeon',
    story_room: true,
    participant_ids: ['hayeon', 'nari', 'sera'],
  });
  assert.equal(plan.focus.focus_id, 'hayeon');
  assert.ok(plan.approved_extras.length >= 1);
  assert.ok(plan.approved_extras.length <= 2);
  assert.equal(plan.approved_extras.some((e) => e.character_id === 'hayeon'), false);
});

t('story_room focus null opens zero extras', () => {
  const plan = planBeat({
    scene: PRESENT,
    catalog: CAT,
    current_version: 0,
    user_text: '안녕하세요',
    cast: CAST,
    cards: CARDS,
    main_character_id: 'hayeon',
    story_room: true,
    participant_ids: ['hayeon', 'nari', 'sera'],
  });
  assert.equal(plan.focus.focus_id, null);
  assert.deepEqual(plan.approved_extras, []);
  assert.equal(plan.pass_f, null);
});

t('non-story_room planBeat still default-rejects extras', () => {
  const plan = planBeat({
    scene: PRESENT,
    catalog: CAT,
    current_version: 0,
    user_text: '하연',
    cast: CAST,
    cards: CARDS,
    main_character_id: 'hayeon',
  });
  assert.deepEqual(plan.approved_extras, []);
});

t('self_repeat drops the previous extra', () => {
  const plan = planBeat({
    scene: { ...PRESENT, last_beat: { focus_id: 'hayeon', extra_ids: ['nari'], unresolved: [] } },
    catalog: CAT,
    current_version: 0,
    user_text: '하연',
    cast: CAST,
    cards: CARDS,
    main_character_id: 'hayeon',
    story_room: true,
    participant_ids: ['hayeon', 'nari', 'sera'],
  });
  assert.equal(plan.approved_extras.some((e) => e.character_id === 'nari'), false);
});

t('HARD_RULES and templates stay off the generate extras module', () => {
  const templates = src('apps/server/src/prompt/templates.ts');
  assert.ok(templates.includes("오직 '{{char}}' 역할만 연기한다"));
  assert.equal(templates.includes('approveStoryExtras'), false);
  const chat = src('apps/server/src/routes/chat.ts');
  assert.equal(chat.includes('approveStoryExtras'), false);
  assert.equal(chat.includes('storyCastForGenerate'), true);
  assert.equal(src('apps/server/src/prompt/composeBeat.ts').includes('approveStoryExtras'), true);
});

t('frost/kai ids are not generate-path fixtures', () => {
  const impl = src('apps/server/src/prompt/composeBeat.ts') + src('apps/server/src/routes/chat.ts');
  assert.equal(impl.includes('f89ace9b-8684-4d97-96dc-e00c4b25a819'), false);
  assert.equal(impl.includes('255f96a2-d78e-433d-9169-fb6da6e0963f'), false);
});

console.log(`\n${passed} passed`);
