/**
 * npx tsx bench/beatByteBaseline.test.ts
 * 수렴 B-1-full S1 — focused beat byte-for-byte baseline.
 * Deterministic planBeat + finishBeat + planPassE. No live DB, no model, no time.
 * Synthetic classroom ids; never live 서리/카이 rows.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { THOUGHT_MARKER } from '../apps/server/src/prompt/passes.ts';
import {
  finishBeat, planBeat, planPassE, type BeatPlanInput,
} from '../apps/server/src/prompt/composeBeat.ts';
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

const member = (o: Partial<CastMember> & { id: string; name: string }): CastMember => ({
  aliases: [], duties: [], place: '교실', role: 'secondary', ...o,
});
const NARI = member({ id: 'nari', name: '나리', duties: ['이야기'] });
const SERA = member({ id: 'sera', name: '세라', duties: ['교칙'] });
const HAYEON = member({ id: 'hayeon', name: '하연', duties: ['수업'], role: 'main' });
const YURA = member({ id: 'yura', name: '유라' });
const LUNA = member({ id: 'luna', name: '루나', talkativeness: 0.9 });
const MIR = member({ id: 'mir', name: '미르', talkativeness: 0.1 });
const CAST = [NARI, SERA, HAYEON, YURA, LUNA, MIR];
const CLASSROOM: Scene = {
  location: '교실',
  arc: 'entry',
  stage: 'reg',
  clock_minutes: 9 * 60 + 37,
  day_index: 12,
  weekday: '화',
  weather: '맑음',
  scene_version: 0,
  present_ids: ['nari', 'sera', 'hayeon', 'yura', 'luna', 'mir'],
  roster: { nari: { emotion: '😡', outfit: '교복' } },
};
const CAT = catalogFromStory(JSON.stringify({
  places: [{ id: '교실', default_focus: 'hayeon' }, { id: '복도' }],
  arcs: ['entry'],
  stagesByArc: { entry: ['reg', 'class'] },
  weathers: ['맑음'],
  flags: { rulebreak: { owner_duty: '교칙' } },
  stages: { class: { closer_duty: '수업' } },
  outfits: ['교복'],
  emotions: { '😡': 8, '😟': 1 },
}));
const CARDS = Object.fromEntries(CAST.map((m) => [m.id, { name: m.name, personality: `${m.name}의 성격` }]));
const input = (o: Partial<BeatPlanInput> = {}): BeatPlanInput => ({
  conversation_id: 'conv-1',
  scene: CLASSROOM,
  catalog: CAT,
  current_version: 0,
  user_text: '나리, 네 이야기 말인데.',
  user_name: '황지명',
  cast: CAST,
  cards: CARDS,
  main_character_id: 'hayeon',
  message_id: 'msg-1',
  ...o,
});

type Payload = {
  approved_ids: string[];
  ambient_ids: string[];
  last_beat: Scene['last_beat'];
  blocks: Array<{ seq: number; kind: string; speaker_character_id: string | null; text: string }>;
  pass_n: string;
  pass_f: string | null;
  pass_e: Array<{ character_id: string; prompt: string }>;
};

function payloadOf(
  i: BeatPlanInput,
  extra_texts: Record<string, string>,
  focus_text: string,
): { json: string; sha: string; len: number; payload: Payload } {
  const plan = planBeat(i);
  const outputs = {
    narration: '지명이 나리를 돌아본다.',
    focus_text,
    extra_texts,
  };
  const finished = finishBeat(i, plan, outputs);
  const payload: Payload = {
    approved_ids: plan.approved_extras.map((e) => e.character_id),
    ambient_ids: plan.ambient.map((a) => a.character_id),
    last_beat: finished.scene.last_beat,
    blocks: finished.blocks.map((b) => ({
      seq: b.seq,
      kind: b.kind,
      speaker_character_id: b.speaker_character_id,
      text: b.text,
    })),
    pass_n: plan.pass_n,
    pass_f: plan.pass_f,
    pass_e: planPassE(i, plan, outputs.narration, outputs.focus_text).map((p) => ({
      character_id: p.character_id,
      prompt: p.prompt,
    })),
  };
  const json = JSON.stringify(payload);
  const sha = createHash('sha256').update(json, 'utf8').digest('hex');
  return { json, sha, len: Buffer.byteLength(json, 'utf8'), payload };
}

function expectCase(
  name: string,
  got: { sha: string; len: number; payload: Payload },
  sha: string,
  len: number,
  kinds: string[],
) {
  t(`${name} SHA-256+len+kinds`, () => {
    assert.equal(got.len, len, `${name} len`);
    assert.equal(got.sha, sha, `${name} sha`);
    assert.deepEqual(got.payload.blocks.map((b) => b.kind), kinds, `${name} kinds`);
  });
}

const quiet = payloadOf(input({ patch: { base_version: 0 } }), {}, '"시비냐."');
const extra1 = payloadOf(
  input({ patch: { base_version: 0, flags: { rulebreak: true } } }),
  { sera: '교칙이다.' },
  '"시비냐."',
);
const extra2 = payloadOf(
  input({ patch: { base_version: 0, flags: { rulebreak: true }, stage: 'class' } }),
  { sera: '교칙이다.', hayeon: '수업 시작한다.' },
  '"시비냐."',
);
const unresolved = payloadOf(input({ patch: { base_version: 0 } }), {}, '"왜 그래?"');
const thought = payloadOf(
  input({ patch: { base_version: 0 } }),
  {},
  `"시비냐."\n${THOUGHT_MARKER} 어떻게 알았지.`,
);

expectCase(
  '1 focus-only',
  quiet,
  'eb59b21cc1956d6720a9541833ee2b144af62d4a0a8d2953c77e73741dca9abe',
  3956,
  ['header', 'narration', 'line', 'ui'],
);
t('1 focus-only speaker is nari and extras empty', () => {
  assert.deepEqual(quiet.payload.approved_ids, []);
  assert.equal(quiet.payload.blocks.find((b) => b.kind === 'line')?.speaker_character_id, 'nari');
  assert.deepEqual(quiet.payload.last_beat, { focus_id: 'nari', extra_ids: [], unresolved: [] });
});

expectCase(
  '2 hard_event extra 1',
  extra1,
  '6a8a504c9f29f2792150bf867a79593ec40a8e6e98751437ebf2e91ccc52460a',
  5219,
  ['header', 'narration', 'line', 'line', 'ui'],
);
t('2 extra 1 is sera after focus', () => {
  assert.deepEqual(extra1.payload.approved_ids, ['sera']);
  assert.deepEqual(
    extra1.payload.blocks.filter((b) => b.kind === 'line').map((b) => b.speaker_character_id),
    ['nari', 'sera'],
  );
});

expectCase(
  '3 extra 2 approval boundary',
  extra2,
  '8eccd5b5fde3c0483f09c5cd098c3cec3d7dc012543859a06036c2b355d88ebb',
  6494,
  ['header', 'narration', 'line', 'line', 'line', 'ui'],
);
t('3 extra 2 are hayeon then sera', () => {
  assert.deepEqual(extra2.payload.approved_ids, ['hayeon', 'sera']);
  assert.deepEqual(
    extra2.payload.blocks.filter((b) => b.kind === 'line').map((b) => b.speaker_character_id),
    ['nari', 'hayeon', 'sera'],
  );
});

expectCase(
  '4 ambient present',
  quiet,
  'eb59b21cc1956d6720a9541833ee2b144af62d4a0a8d2953c77e73741dca9abe',
  3956,
  ['header', 'narration', 'line', 'ui'],
);
t('4 ambient includes luna and excludes focus', () => {
  assert.ok(quiet.payload.ambient_ids.includes('luna'));
  assert.equal(quiet.payload.ambient_ids.includes('nari'), false);
});

expectCase(
  '5 unresolved focus pin',
  unresolved,
  '393e13581bfde727affe9123b214c65150c0b70e27005a4c4af38211c94efd3c',
  3963,
  ['header', 'narration', 'line', 'ui'],
);
t('5 last_beat.unresolved pins nari', () => {
  assert.deepEqual(unresolved.payload.last_beat?.unresolved, ['nari']);
  assert.equal(unresolved.payload.last_beat?.focus_id, 'nari');
});

expectCase(
  '6 thought block',
  thought,
  '5ebd42804db3b4f5546f44287d19d312da9bd0b417fff4994b88ab59faa02d6c',
  4043,
  ['header', 'narration', 'line', 'thought', 'ui'],
);
t('6 thought speaker is focus nari', () => {
  const th = thought.payload.blocks.find((b) => b.kind === 'thought');
  assert.equal(th?.speaker_character_id, 'nari');
  assert.ok((th?.text ?? '').includes('어떻게 알았지'));
});

t('focused: after ambient, extra approval is still reflected', () => {
  assert.deepEqual(extra1.payload.approved_ids, ['sera']);
  assert.equal(extra1.payload.ambient_ids.includes('sera'), false);
});

t('generateBeat model call count and order unchanged', () => {
  const chat = src('apps/server/src/routes/chat.ts');
  const from = chat.indexOf('async function generateBeat');
  const to = chat.indexOf('async function generateDialog', from);
  assert.ok(from > 0 && to > from);
  const body = chat.slice(from, to);
  assert.equal(body.split('model.complete(').length - 1, 4);
  assert.equal(body.split('model.stream(').length - 1, 1);
  const n = body.indexOf('model.complete(');
  const f = body.indexOf('passFWith(');
  const stream = body.indexOf('model.stream(');
  const e = body.indexOf('planPassE(');
  const c = body.indexOf('passCWith(');
  assert.ok(n > 0 && f > n && stream > f && e > stream && c > e);
});

// N changes intentionally; the other prompt/state/render bytes stay pinned to #75.
t('F/E, speaker approval, persisted scene and render blocks remain byte-identical', () => {
  const cases = [quiet, extra1, extra2, quiet, unresolved, thought];
  const expected = ["dcbf05bc63f6de2d7f0693c38d88a853aa854ff76ba856e84188462513a7257d", "d4e006e2651c9dbefaa782d67aaa6fe454be47222216388443bf74ed9a1ce3bc", "42aaaefbfdd23595c82d87168c20b022e2c0d5f52ddf2e3e3985ed91eaa3a9d7", "dcbf05bc63f6de2d7f0693c38d88a853aa854ff76ba856e84188462513a7257d", "aabfde7dbcb4839dc36f6d04aed54366ac1c44c034fe5fd931cbea7a9147dcba", "9ce543a2bbfc7c2a34c265b0a265ddcee3530f565a76d28299f52070b57dfdd7"];
  cases.forEach((got, i) => {
    const { pass_n, ...unchanged } = got.payload;
    assert.equal(createHash('sha256').update(JSON.stringify(unchanged)).digest('hex'), expected[i]);
  });
});


console.log(`\n${passed} passed`);
