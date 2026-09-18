/**
 * npx tsx bench/partyChannel.test.ts
 * 수렴 B-1-full — core has no speaker policy; focused vs ensemble leftover ambient.
 * Isolated: no live DB, no model.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planBeat, type BeatPlanInput } from '../apps/server/src/prompt/composeBeat.ts';
import { planDialogBeat, type DialogPlanInput } from '../apps/server/src/prompt/composeDialog.ts';
import { catalogFromStory } from '../apps/server/src/prompt/sceneCatalog.ts';
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

t('core does not choose focused, approve extras, place ambient, or pin unresolved', () => {
  const core = src('apps/server/src/prompt/partyChannel.ts');
  assert.equal(core.includes('approveExtras'), false);
  assert.equal(core.includes('approveStoryExtras'), false);
  assert.equal(core.includes('dialogSpeakers'), false);
  assert.equal(core.includes('ambientPicks'), false);
  assert.equal(core.includes('detectUnresolved'), false);
  assert.equal(core.includes("speakerMode"), false);
  assert.equal(/focused/.test(core.split('planPartyCore')[0] ?? ''), false);
});

const member = (o: Partial<CastMember> & { id: string; name: string }): CastMember => ({
  aliases: [], duties: [], place: '교실', role: 'secondary', ...o,
});
const CAST: CastMember[] = [
  member({ id: 'nari', name: '나리', duties: ['이야기'] }),
  member({ id: 'sera', name: '세라', duties: ['교칙'] }),
  member({ id: 'hayeon', name: '하연', duties: ['수업'], role: 'main' }),
  member({ id: 'luna', name: '루나', talkativeness: 0.9 }),
];
const CLASSROOM: Scene = {
  location: '교실',
  arc: 'entry',
  stage: 'reg',
  scene_version: 0,
  present_ids: ['nari', 'sera', 'hayeon', 'luna'],
};
const CAT = catalogFromStory(JSON.stringify({
  places: [{ id: '교실' }],
  arcs: ['entry'],
  stagesByArc: { entry: ['reg', 'class'] },
  weathers: ['맑음'],
  flags: { rulebreak: { owner_duty: '교칙' } },
}));

t('focused: ambient 배치 후 extra 승인 결과 반영', () => {
  const i: BeatPlanInput = {
    conversation_id: 'conv-ch',
    scene: CLASSROOM,
    patch: { base_version: 0, flags: { rulebreak: true } },
    catalog: CAT,
    current_version: 0,
    user_text: '나리, 네 이야기 말인데.',
    cast: CAST,
    main_character_id: 'hayeon',
    message_id: 'msg-ch',
  };
  const plan = planBeat(i);
  assert.deepEqual(plan.approved_extras.map((e) => e.character_id), ['sera']);
  assert.equal(plan.ambient.some((a) => a.character_id === 'sera'), false);
  assert.ok(plan.ambient.length > 0);
});

const dMember = (o: Partial<CastMember> & { id: string; name: string }): CastMember => ({
  aliases: [], duties: [], place: '', role: 'secondary', ...o,
});
const SEORIN = dMember({ id: 'osr', name: '오세린', aliases: ['국장'] });
const YEOJIN = dMember({ id: 'hyj', name: '한여진', aliases: ['여진'] });
const GUIDE = dMember({ id: 'guide', name: '길잡이', role: 'main' });
const BACKDROP = dMember({ id: 'bg', name: '직원', role: 'background' });
const DCAST = [GUIDE, SEORIN, YEOJIN, BACKDROP];
const DCAT = catalogFromStory(JSON.stringify({
  places: [{ id: '제3검사실', name: '제3검사실' }],
  weathers: ['실내'],
}));
const T29: Scene = {
  format: 'dialog',
  turn_no: 28,
  time_phrase: '이틀 뒤·오전 10시',
  location: '제3검사실',
  weather: '실내',
  present_ids: ['osr', 'hyj', 'bg'],
  scene_version: 0,
};

t('ensemble: speakers 결정 후 남은 인물을 ambient로 배치', () => {
  const i: DialogPlanInput = {
    conversation_id: 'conv-dialog',
    scene: T29,
    catalog: DCAT,
    current_version: 0,
    user_text: '오세린 국장님, 검사부터 시작할까요?',
    user_name: '황지명',
    cast: DCAST,
    main_character_id: 'guide',
  };
  const plan = planDialogBeat(i);
  assert.ok(plan.speakers.some((s) => s.id === 'osr'));
  assert.equal(plan.speakers.some((s) => s.id === 'bg'), false);
  assert.ok(plan.ambient.some((a) => a.character_id === 'bg'));
  assert.equal(plan.ambient.some((a) => plan.speakers.some((s) => s.id === a.character_id)), false);
});

t('ensemble source order: dialogSpeakers before ambientPicks', () => {
  const s = src('apps/server/src/prompt/composeDialog.ts');
  const speakers = s.indexOf('dialogSpeakers(');
  const ambient = s.indexOf('ambientPicks(');
  assert.ok(speakers > 0 && ambient > speakers);
});

t('generateDialog model call count and order unchanged', () => {
  const chat = src('apps/server/src/routes/chat.ts');
  const from = chat.indexOf('async function generateDialog');
  const to = chat.indexOf('return async function plugin', from);
  assert.ok(from > 0 && to > from);
  const body = chat.slice(from, to);
  assert.equal(body.split('model.complete(').length - 1, 1);
  assert.equal(body.split('model.stream(').length - 1, 1);
  const complete = body.indexOf('model.complete(');
  const stream = body.indexOf('model.stream(');
  assert.ok(complete > 0 && stream > complete);
});

console.log(`\n${passed} passed`);
