/**
 * npx tsx bench/composeBeat.test.ts
 * f9-swap-passes (S4) — §4 pipeline order, §6 serialization, step-9 commit.
 * The order assertion is the point: routing on a pre-apply scene produces a
 * plausible answer to the previous turn's world, which is the failure this whole
 * design is arranged to prevent (ADR-F9 §5).
 * Isolated: no systemd, no live DB, no model call, no migration, no live generate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectUnresolved, finishBeat, passFWith, planBeat, planPassE, partyCastForGenerate,
  type BeatPlanInput,
} from '../apps/server/src/prompt/composeBeat.ts';
import { splitFocusText, THOUGHT_MARKER } from '../apps/server/src/prompt/passes.ts';
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
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * generateBeat's body only. Slicing to end-of-file would swallow the route
 * handlers below it, which legitimately read `parent_id` for regenerate/branch —
 * a fence that reaches into them measures the wrong function.
 */
function beatBody(): string {
  const s = code('apps/server/src/routes/chat.ts');
  const from = s.indexOf('async function generateBeat');
  const to = s.indexOf('return async function plugin', from);
  assert.ok(from > 0 && to > from, 'generateBeat body not found');
  return s.slice(from, to);
}

// ── Notes §7 classroom. Synthetic ids; never live 서리/카이 rows. ──────────────
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

// ── 1. A-5: order is the invariant ──────────────────────────────────────────
t('A-5: everything downstream reads the POST-apply scene', () => {
  const i = input({
    scene: { ...CLASSROOM, location: '교실' },
    patch: { base_version: 0, location: '복도' },
    user_text: '이동한다',
    catalog: catalogFromStory(JSON.stringify({
      places: [{ id: '교실', default_focus: 'nari' }, { id: '복도' }],
      arcs: ['entry'],
      stagesByArc: { entry: ['reg', 'class'] },
      weathers: ['맑음'],
    })),
  });
  const plan = planBeat(i);
  assert.equal(plan.applied.state.location, '복도');
  // 교실 default_focus (나리) must not apply after leaving. The chat partner
  // (하연) may still answer an untargeted line.
  assert.notEqual(plan.focus.focus_id, 'nari');
  assert.equal(plan.ui.location_badge, '복도');
  assert.ok(plan.header!.includes('복도'));
});

t('A-5 source order: apply → focus → approve → ambient → assign', () => {
  const s = code('apps/server/src/prompt/composeBeat.ts');
  const idx = (needle: string) => {
    const at = s.indexOf(needle);
    assert.ok(at > 0, `${needle} missing`);
    return at;
  };
  const apply = idx('applySceneDelta(');
  const focus = idx('resolveFocus(');
  const approve = idx('approveExtras(');
  const ambient = idx('ambientPicks(');
  const assign = idx('assignSpeakers(');
  assert.ok(apply < focus && focus < approve && approve < ambient && ambient < assign);
});

t('안녕하세요 talks to the story opener even without party: tags on them', () => {
  const seori = member({ id: 'seori', name: '서리', place: '', role: 'main' });
  const plan = planBeat(input({
    user_text: '안녕하세요',
    main_character_id: 'seori',
    cast: [seori, NARI, SERA],
    scene: { location: 'bureau_lobby', present_ids: ['seori', 'nari', 'sera'], weather: 'clear' },
    catalog: catalogFromStory(JSON.stringify({
      places: [{ id: 'bureau_lobby', name: '로비' }],
      weathers: ['clear'],
    })),
  }));
  assert.equal(plan.focus.focus_id, 'seori');
  assert.equal(plan.focus.reason, 'conversation_partner');
  assert.equal(plan.approved_extras.length, 2);
  assert.ok(plan.approved_extras.every((e) => e.character_id !== 'seori'));
});

t('유키랑 on a 카이 chat: 카이 keeps the line, 유키 extras, 한소연 stays locked', () => {
  const kai = member({ id: 'kai', name: '카이', place: '', role: 'main' });
  const yuki = member({ id: 'yuki-smoke', name: '유키-smoke', aliases: ['유키'], place: '' });
  const soyeon = member({ id: 'soyeon-smoke', name: '한소연-smoke', aliases: ['소연'], place: '' });
  const plan = planBeat(input({
    user_text: '어 유키랑 담배피다가 온건데?',
    main_character_id: 'kai',
    cast: [kai, yuki, soyeon],
    scene: {
      location: 'bureau_lobby',
      present_ids: ['kai', 'yuki-smoke', 'soyeon-smoke'],
      last_beat: { focus_id: 'kai', extra_ids: [], unresolved: [] },
    },
    catalog: catalogFromStory(JSON.stringify({
      places: [{ id: 'bureau_lobby', name: '로비' }],
    })),
  }));
  assert.equal(plan.focus.focus_id, 'kai');
  assert.deepEqual(plan.approved_extras.map((e) => e.character_id), ['yuki-smoke']);
  assert.deepEqual(plan.assigned.speakers.map((s) => s.character_id), ['kai', 'yuki-smoke']);
});

t('the party path never calls buildPrompt', () => {
  const s = code('apps/server/src/prompt/composeBeat.ts');
  assert.equal(s.includes('buildPrompt'), false);
  const chat = code('apps/server/src/routes/chat.ts');
  const beatAt = chat.indexOf('async function generateBeat');
  assert.ok(beatAt > 0);
  assert.equal(chat.slice(beatAt).includes('buildPrompt('), false, 'generateBeat must not build a 1:1 prompt');
  // the 1:1 path still does
  assert.ok(chat.slice(0, beatAt).includes('buildPrompt('));
});

// ── 2. the §7 walkthrough end to end ────────────────────────────────────────
t('§7: 교칙 flag flips → focus 나리, extra 세라, ambient from the rest', () => {
  const plan = planBeat(input({ patch: { base_version: 0, flags: { rulebreak: true } } }));
  assert.equal(plan.focus.focus_id, 'nari');
  assert.deepEqual(plan.approved_extras.map((e) => e.character_id), ['sera']);
  for (const a of plan.ambient) {
    assert.notEqual(a.character_id, 'nari');
    assert.notEqual(a.character_id, 'sera');
  }
  assert.equal(plan.assigned.speakers.filter((s) => s.slot === 'extra').length, 1);
});

t('a quiet turn: focus speaks alone, everyone else is ambient or 🔒', () => {
  const plan = planBeat(input({ patch: { base_version: 0 } }));
  assert.equal(plan.focus.focus_id, 'nari');
  assert.deepEqual(plan.approved_extras, []);
  assert.deepEqual(plan.assigned.speakers.map((s) => s.slot), ['main']);
  const chips = Object.fromEntries(plan.ui.roster.map((r) => [r.id, r.chip]));
  assert.equal(chips.nari, '😡');
  assert.equal(chips.sera, '🔒');
});

t('a beat with no focus still plans Pass N, and plans no Pass F', () => {
  const plan = planBeat(input({
    user_text: '둘러본다',
    scene: { location: '옥상', present_ids: ['nari'] },
    catalog: catalogFromStory(JSON.stringify({ places: [{ id: '옥상' }], weathers: ['맑음'] })),
    main_character_id: 'hayeon',
  }));
  assert.equal(plan.focus.focus_id, null);
  assert.ok(plan.pass_n.length > 0);
  assert.equal(plan.pass_f, null);
  assert.deepEqual(plan.assigned.speakers, []);
  assert.deepEqual(plan.approved_extras, []);
});

// ── 3. §6 serialization ─────────────────────────────────────────────────────
const outputs = (o: Partial<Parameters<typeof finishBeat>[2]> = {}) => ({
  narration: '지명이 나리를 돌아본다.',
  focus_text: `"시비냐."\n${THOUGHT_MARKER} 어떻게 알았지.`,
  extra_texts: {},
  ...o,
});

t('blocks come out in §6 order with a UI block last', () => {
  const i = input({ patch: { base_version: 0, flags: { rulebreak: true } } });
  const plan = planBeat(i);
  const done = finishBeat(i, plan, outputs({ extra_texts: { sera: '"교칙 위반이야."' } }));
  assert.deepEqual(done.blocks.map((b) => b.kind),
    ['header', 'narration', 'line', 'thought', 'line', 'ui']);
  assert.deepEqual(done.blocks.map((b) => b.seq), [0, 1, 2, 3, 4, 5]);
  assert.equal(done.blocks[0].text, '12일차 · 화 · 09:37 · 맑음 · 교실');
  assert.equal(done.blocks[2].speaker_character_id, 'nari');
  assert.equal(done.blocks[4].speaker_character_id, 'sera');
});

t('the focus line carries the server-chosen asset path, extras without one do not', () => {
  const i = input({ patch: { base_version: 0, flags: { rulebreak: true } } });
  const plan = planBeat(i);
  const done = finishBeat(i, plan, outputs({ extra_texts: { sera: '"교칙 위반이야."' } }));
  const nari = done.blocks.find((b) => b.kind === 'line' && b.speaker_character_id === 'nari')!;
  const sera = done.blocks.find((b) => b.kind === 'line' && b.speaker_character_id === 'sera')!;
  assert.equal(nari.asset_path, `/media/assets/nari/${encodeURIComponent('교복')}/8.webp`);
  assert.equal(sera.asset_path, null, '세라 has no roster emotion/outfit — no image, still a line');
  assert.ok(!nari.asset_path!.startsWith('http'));
});

t('a failed Pass E drops that extra only; the rest of the beat stands', () => {
  const i = input({ patch: { base_version: 0, flags: { rulebreak: true } } });
  const plan = planBeat(i);
  const done = finishBeat(i, plan, outputs({ extra_texts: {} }));
  assert.deepEqual(done.blocks.map((b) => b.kind), ['header', 'narration', 'line', 'thought', 'ui']);
  assert.deepEqual(done.scene.last_beat!.extra_ids, [], 'only extras that actually spoke are committed');
});

t('a failed Pass N drops the narration block only', () => {
  const i = input({ patch: { base_version: 0 } });
  const plan = planBeat(i);
  const done = finishBeat(i, plan, outputs({ narration: '' }));
  assert.deepEqual(done.blocks.map((b) => b.kind), ['header', 'line', 'thought', 'ui']);
});

t('a no-focus beat serializes header + narration + ui with zero line slots', () => {
  const i = input({
    user_text: '둘러본다',
    scene: { location: '옥상', present_ids: ['nari'], scene_version: 0 },
    catalog: catalogFromStory(JSON.stringify({ places: [{ id: '옥상' }], weathers: ['맑음'] })),
    main_character_id: 'hayeon',
  });
  const plan = planBeat(i);
  const done = finishBeat(i, plan, outputs({ focus_text: '' }));
  assert.deepEqual(done.blocks.map((b) => b.kind), ['header', 'narration', 'ui']);
  assert.equal(done.blocks.filter((b) => b.kind === 'line').length, 0);
  assert.equal(done.scene.last_beat!.focus_id, null);
});

// ── 4. 속마음 split (A-6) ────────────────────────────────────────────────────
t('the thought marker splits the focus text', () => {
  assert.deepEqual(splitFocusText(`"뭐."\n${THOUGHT_MARKER} 싫다.`), { line: '"뭐."', thought: '싫다.' });
});

t('a missing marker keeps everything as the line, with no THOUGHT block', () => {
  assert.deepEqual(splitFocusText('"뭐."'), { line: '"뭐."', thought: null });
  const i = input({ patch: { base_version: 0 } });
  const plan = planBeat(i);
  const done = finishBeat(i, plan, outputs({ focus_text: '"뭐." 나리가 고개를 돌렸다.' }));
  assert.equal(done.blocks.some((b) => b.kind === 'thought'), false);
  assert.ok(done.blocks.some((b) => b.kind === 'line'));
});

t('a marker with nothing after it, or nothing before it, is not a split', () => {
  assert.deepEqual(splitFocusText(`"뭐." ${THOUGHT_MARKER}`), { line: `"뭐." ${THOUGHT_MARKER}`, thought: null });
  assert.deepEqual(splitFocusText(`${THOUGHT_MARKER} 싫다.`), { line: `${THOUGHT_MARKER} 싫다.`, thought: null });
  assert.deepEqual(splitFocusText(''), { line: '', thought: null });
});

// ── 5. step 9 commit ────────────────────────────────────────────────────────
t('last_beat commits focus, the extras that spoke, and unresolved', () => {
  const i = input({ patch: { base_version: 0, flags: { rulebreak: true } } });
  const plan = planBeat(i);
  const done = finishBeat(i, plan, outputs({
    focus_text: '"너야말로 왜 그래?"',
    extra_texts: { sera: '"교칙 위반이야."' },
  }));
  assert.deepEqual(done.scene.last_beat, { focus_id: 'nari', extra_ids: ['sera'], unresolved: ['nari'] });
});

t('unresolved is server-computed and deliberately under-detects', () => {
  assert.deepEqual(detectUnresolved('nari', '"왜 그래?"'), ['nari']);
  assert.deepEqual(detectUnresolved('nari', '"대답해."'), ['nari']);
  assert.deepEqual(detectUnresolved('nari', '"말해 줘."'), ['nari']);
  // a statement leaves nothing hanging
  assert.deepEqual(detectUnresolved('nari', '"그래."'), []);
  // a question early in a long turn was already answered inside it
  assert.deepEqual(detectUnresolved('nari', '"왜 그래?" 나리는 대답을 기다리지 않고 자리에 앉아 창밖을 오래 바라보았다.'), []);
  assert.deepEqual(detectUnresolved(null, '"왜 그래?"'), []);
  assert.deepEqual(detectUnresolved('nari', ''), []);
});

t('the committed scene keeps every applied key and adds only last_beat', () => {
  const i = input({ patch: { base_version: 0, flags: { rulebreak: true }, advance_minutes: 5 } });
  const plan = planBeat(i);
  const done = finishBeat(i, plan, outputs());
  assert.equal(done.scene.clock_minutes, 9 * 60 + 42);
  assert.equal(done.scene.location, '교실');
  assert.deepEqual(done.scene.flags, [{ key: 'rulebreak' }]);
  assert.equal(done.scene.scene_version, 1);
  assert.ok(done.scene.last_beat);
});

t('the model still cannot write last_beat or roster', () => {
  const i = input({ patch: { base_version: 0, last_beat: { focus_id: 'yuki', extra_ids: [], unresolved: [] }, roster: { nari: { emotion: '😊' } } } });
  const plan = planBeat(i);
  assert.ok(plan.applied.ignored.some((x) => x.key === 'last_beat' && x.reason === 'not_in_allowlist'));
  assert.ok(plan.applied.ignored.some((x) => x.key === 'roster' && x.reason === 'not_in_allowlist'));
  assert.equal(plan.applied.state.roster!.nari.emotion, '😡', 'the scene keeps its own value');
});

// ── 6. pass prompt wiring ───────────────────────────────────────────────────
t('Pass F is rebuilt with the narration Pass N actually produced', () => {
  const i = input({ patch: { base_version: 0 } });
  const plan = planBeat(i);
  const withN = passFWith(i, plan, '교실이 조용해졌다.')!;
  assert.ok(withN.includes('교실이 조용해졌다.'));
  assert.ok(withN.includes('다시 쓰지 말 것'));
  assert.equal(passFWith(i, planBeat(input({
    user_text: '둘러본다',
    scene: { location: '옥상', present_ids: ['nari'] },
    catalog: catalogFromStory(JSON.stringify({ places: [{ id: '옥상' }] })),
    main_character_id: 'hayeon',
  })), 'x'), null);
});

t('Pass E is planned once per approved extra, carrying its opening duty', () => {
  const i = input({ patch: { base_version: 0, flags: { rulebreak: true } } });
  const plan = planBeat(i);
  const plans = planPassE(i, plan, '서술.', '"시비냐."');
  assert.equal(plans.length, 1);
  assert.equal(plans[0].character_id, 'sera');
  assert.equal(plans[0].duty, '교칙');
  assert.ok(plans[0].prompt.includes('교칙'));
  assert.ok(plans[0].prompt.includes('"시비냐."'), 'the extra reacts to the focus line it must not repeat');
});

t('server facts are injected into Pass E as given', () => {
  const i = input({ patch: { base_version: 0, flags: { rulebreak: true } }, facts: ['빈자리는 나리 옆자리'] });
  const plan = planBeat(i);
  const plans = planPassE(i, plan, '', '"시비냐."');
  assert.ok(plans[0].prompt.includes('빈자리는 나리 옆자리'));
  assert.ok(plans[0].prompt.includes('새로 지어내지 말 것'));
});

t('planBeat calls no model and no DB', () => {
  const plan = planBeat(input());
  assert.equal(plan.called_model, false);
  const s = code('apps/server/src/prompt/composeBeat.ts');
  for (const banned of ['better-sqlite3', 'fetch(', 'ModelClient', '../db/', 'Math.random']) {
    assert.equal(s.includes(banned), false, banned);
  }
});

t('partyCastForGenerate still returns null for an untagged roster', () => {
  assert.equal(partyCastForGenerate({ character_id: 'a' }, []), null);
  assert.equal(partyCastForGenerate({ character_id: 'a' }, [
    { id: 'a', name: 'A', tags_json: '["일상"]' },
    { id: 'b', name: 'B', tags_json: '["모험"]' },
  ]), null);
});

// ── 6b. the invariant that lets the client skip a second clock ──────────────
// The web renderer deliberately does NOT sort by beat_seq: the block rows form a
// parent chain, so `getPath` already returns them in beat order and adding a
// second ordering key would fight the tree order against older messages. That
// choice is only safe while chat.ts appends blocks in serialization order and
// never inserts between them or rewrites a parent. This is that contract.
t('chat.ts appends blocks in serialize order: monotonic chain, no insert, no reorder', () => {
  const beat = beatBody();

  // every block row is parented on the current head, and head advances to it
  assert.ok(beat.includes("insertMessage(db, conv.id, head, 'assistant'"), 'blocks parent on head');
  assert.ok(beat.includes('head = row.id'), 'and head advances');
  assert.ok(beat.includes('head = focusRow.id'), 'including across the streamed row');

  // nothing rewrites a parent or re-sorts after the fact
  assert.equal(/parent_id\s*[:=]/.test(beat), false, 'no parent_id is ever recomputed');
  assert.equal(/\.sort\(/.test(beat), false, 'no reordering of persisted blocks');
  assert.equal(/UPDATE messages SET parent_id/.test(beat), false);

  // the emit order matches the §6 slot order the serializer produces
  const order = ['header', 'narration', 'line', 'thought', 'line', 'ui'].map((k) => k);
  void order;
  const headerAt = beat.indexOf("addBlock('header'");
  const narrAt = beat.indexOf("addBlock('narration'");
  const focusAt = beat.indexOf('focusRow = insertMessage');
  const thoughtAt = beat.indexOf("addBlock('thought'");
  const uiAt = beat.indexOf("addBlock('ui'");
  assert.ok(headerAt > 0 && narrAt > headerAt, 'narration after header');
  assert.ok(focusAt > narrAt, 'focus line after narration');
  assert.ok(thoughtAt > focusAt, 'thought after the focus line');
  assert.ok(uiAt > thoughtAt, 'ui last');
});

t('the client adds no ordering of its own', () => {
  const page = src('apps/web/src/pages/ChatPage.tsx');
  const chatHook = src('apps/web/src/pages/useChat.ts');
  for (const [name, s] of [['ChatPage', page], ['useChat', chatHook]] as const) {
    assert.equal(/\.sort\(/.test(s), false, `${name} must not sort messages`);
    assert.equal(/beat_seq[\s\S]{0,40}sort|sort[\s\S]{0,40}beat_seq/.test(s), false,
      `${name}: beat_seq is diagnostic, not a second clock`);
  }
  // created_at exists only on the optimistic placeholder, never as an order key
  assert.equal(/sort[\s\S]{0,60}created_at/.test(chatHook), false);
});

// ── 7. retired modules and the 1:1 path ─────────────────────────────────────
t('composePartyTurn and auxSpeakerPrompt are gone from product code', () => {
  for (const f of ['composePartyTurn.ts', 'auxSpeakerPrompt.ts', 'auxGate.ts', 'pickSpeaker.ts']) {
    assert.equal(fs.existsSync(path.join(appRoot, `apps/server/src/prompt/${f}`)), false, f);
  }
  const chat = code('apps/server/src/routes/chat.ts');
  assert.equal(/composePartyTurn|renderAuxSpeakerPrompt/.test(chat), false);
});

t('1:1 prompt text and builder are untouched by this slice', () => {
  const templates = src('apps/server/src/prompt/templates.ts');
  assert.ok(templates.includes("오직 '{{char}}' 역할만 연기한다"));
  assert.ok(templates.includes('<choices>'));
  assert.equal(/composeBeat|renderPassF|block_kind/.test(templates), false);
  assert.equal(/composeBeat|renderPassF/.test(src('apps/server/src/prompt/builder.ts')), false);
});

t('the 1:1 generate path kept its stream/choices contract', () => {
  const chat = code('apps/server/src/routes/chat.ts');
  const beatAt = chat.indexOf('async function generateBeat');
  const oneToOne = chat.slice(0, beatAt);
  assert.ok(oneToOne.includes('extractChoices('));
  assert.ok(oneToOne.includes('dumpGenerationPrompt('));
  assert.ok(oneToOne.includes('updateCalibration('));
  // and the beat path deliberately does none of those
  const beat = chat.slice(beatAt);
  assert.equal(beat.includes('extractChoices('), false);
});

console.log(`\n${passed} passed`);
