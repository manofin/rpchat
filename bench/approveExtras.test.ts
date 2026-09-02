/**
 * npx tsx bench/approveExtras.test.ts
 * f9-extra-approve (S3) — §4.3. Default: reject everybody.
 * Test names carry the contract: each is a row of the notes' 통과/탈락 표.
 * Isolated: no systemd, no live DB, no model call, no migration, no live generate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTRA_SCORE_ENABLED, approveExtras } from '../apps/server/src/prompt/approveExtras.ts';
import { planBeat } from '../apps/server/src/prompt/composeBeat.ts';
import { MAX_EXTRAS } from '../apps/server/src/prompt/assignSpeakers.ts';
import { catalogFromStory } from '../apps/server/src/prompt/sceneCatalog.ts';
import type { CastMember } from '../apps/server/src/prompt/cast.ts';
import type { AppliedEvent, PartyCatalog } from '../apps/server/src/prompt/applySceneDelta.ts';
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

// ── Notes §7 classroom. Synthetic ids; never live 서리/카이 rows. ──────────────
const member = (o: Partial<CastMember> & { id: string; name: string }): CastMember => ({
  aliases: [], duties: [], place: '교실', role: 'secondary', ...o,
});

const NARI = member({ id: 'nari', name: '나리', duties: ['이야기'] });
const SERA = member({ id: 'sera', name: '세라', duties: ['교칙'] });
const HAYEON = member({ id: 'hayeon', name: '하연', duties: ['수업'], role: 'main' });
const YURA = member({ id: 'yura', name: '유라' });
const LUNA = member({ id: 'luna', name: '루나', talkativeness: 0.8 });
const MIR = member({ id: 'mir', name: '미르', talkativeness: 0.1 });
const SOYEON = member({ id: 'soyeon', name: '한소연', duties: ['서류'], place: '사무실' });
const YUKI = member({ id: 'yuki', name: '유키', duties: ['경비'], place: '경비실' });

const CAST = [NARI, SERA, HAYEON, YURA, LUNA, MIR, SOYEON, YUKI];

const CLASSROOM: Scene = {
  location: '교실',
  arc: 'entry',
  stage: 'reg',
  clock_minutes: 9 * 60 + 37,
  present_ids: ['nari', 'sera', 'hayeon', 'yura', 'luna', 'mir'],
};

const CATALOG_JSON = JSON.stringify({
  places: [{ id: '교실', default_focus: 'hayeon' }],
  arcs: ['entry'],
  stagesByArc: { entry: ['reg', 'class'] },
  weathers: ['맑음'],
  // 교칙 위반이 실제로 일어남 → 교칙 담당(세라)의 슬롯이 열린다
  flags: { rulebreak: { owner_stage: 'reg', owner_duty: '교칙' } },
  // 수업 개시 → 담임(하연)이 비트를 닫는다
  stages: { class: { closer_duty: '수업' } },
});
const CAT: PartyCatalog = catalogFromStory(CATALOG_JSON);

const RULEBREAK: AppliedEvent = { kind: 'flag', id: 'rulebreak' };
const CLASS_START: AppliedEvent = { kind: 'stage', id: 'class' };

const run = (o: Partial<Parameters<typeof approveExtras>[0]> = {}) =>
  approveExtras({ cast: CAST, scene: CLASSROOM, focus_id: 'nari', catalog: CAT, applied_events: [], ...o });

const ids = (r: ReturnType<typeof approveExtras>) => r.approved.map((a) => a.character_id);
const why = (r: ReturnType<typeof approveExtras>, id: string) => r.rejected.find((x) => x.id === id)?.reason;

// ── the default ─────────────────────────────────────────────────────────────
t('rejects_all_when_no_signal — a quiet turn opens zero slots', () => {
  const r = run();
  assert.deepEqual(r.approved, []);
  assert.equal(r.k_opened, 0);
  assert.ok(r.eligible_ids.length >= 4, 'the eligible set is NOT empty — nothing earned a slot');
  for (const id of r.eligible_ids) assert.equal(why(r, id), 'no_hard_event');
});

t('a discarded patch opens nothing, and the turn still happens', () => {
  const out = planBeat({
    scene: { ...CLASSROOM, scene_version: 1 },
    patch: { base_version: 99 },   // stale → discarded
    catalog: CAT,
    current_version: 1,
    user_text: '나리, 네 이야기 말인데.',
    cast: CAST,
    main_character_id: 'hayeon',
  });
  assert.equal(out.applied.discarded, true);
  assert.equal(out.focus.focus_id, 'nari');
  assert.deepEqual(out.approved_extras, []);
  assert.deepEqual(out.messages.map((m) => m.slot), ['main']);
});

// ── §4.3 통과 ────────────────────────────────────────────────────────────────
t('passes_sera_rule_break — 교칙 위반 flag가 켜지면 교칙 담당이 열린다', () => {
  const r = run({ applied_events: [RULEBREAK] });
  assert.deepEqual(ids(r), ['sera']);
  assert.equal(r.approved[0].duty, '교칙');
  assert.deepEqual(r.approved[0].hard_event, RULEBREAK);
  assert.equal(r.k_opened, 1);
});

t('passes_hayeon_class_start — 수업 개시 stage가 담임의 비트 종료를 연다', () => {
  const r = run({ applied_events: [CLASS_START] });
  assert.deepEqual(ids(r), ['hayeon']);
  assert.equal(r.approved[0].duty, '수업');
  assert.deepEqual(r.approved[0].hard_event, CLASS_START);
});

t('§7 both: 교칙 + 수업 개시 → [세라, 하연], K=2', () => {
  const r = run({ applied_events: [RULEBREAK, CLASS_START] });
  assert.deepEqual(ids(r), ['sera', 'hayeon']);
  assert.equal(r.k_opened, 2);
});

// ── §4.3 탈락 ────────────────────────────────────────────────────────────────
t('rejects_yura_narration_enough — 조소는 서술 한 줄, 슬롯이 아니다', () => {
  const r = run({ applied_events: [RULEBREAK, CLASS_START] });
  for (const id of ['yura', 'luna', 'mir']) {
    assert.equal(ids(r).includes(id), false, id);
    assert.equal(why(r, id), 'no_hard_event', id);
  }
});

t('rejects_place_gate — 한소연·유키는 직무가 맞아도 이 장소에 없다', () => {
  // Give both a hard_event their duty owns; presence must still cut them.
  const cat = catalogFromStory(JSON.stringify({
    ...JSON.parse(CATALOG_JSON),
    flags: { rulebreak: { owner_duty: '경비' } },
    stages: { class: { closer_duty: '서류' } },
  }));
  const r = run({ catalog: cat, applied_events: [RULEBREAK, CLASS_START] });
  assert.deepEqual(r.approved, []);
  assert.equal(why(r, 'yuki'), 'place');
  assert.equal(why(r, 'soyeon'), 'place');
});

t('duty_overlap — 포커스가 이미 가진 직무는 extra로 옮겨가지 않는다 (duty_transfer)', () => {
  // 나리 is the focus AND holds 교칙 here: the extra would restate the focus.
  const cast = CAST.map((m) => (m.id === 'nari' ? { ...m, duties: ['이야기', '교칙'] } : m));
  const r = run({ cast, applied_events: [RULEBREAK] });
  assert.deepEqual(r.approved, []);
  assert.equal(why(r, 'sera'), 'duty_overlap');
});

t('cuts_duplicate_quiet_slot — 세라·하연이 같은 기능 슬롯이면 한 명만', () => {
  const cat = catalogFromStory(JSON.stringify({
    ...JSON.parse(CATALOG_JSON),
    duties: { '교칙': { slot: 'quiet' }, '수업': { slot: 'quiet' } },
  }));
  const r = run({ catalog: cat, applied_events: [RULEBREAK, CLASS_START] });
  assert.deepEqual(ids(r), ['sera']);
  assert.equal(why(r, 'hayeon'), 'dup_slot');
  assert.equal(r.k_opened, 1);
});

t('caps_at_2 — OR로 3명을 열지 않는다', () => {
  const cast = [
    NARI,
    member({ id: 'a', name: 'A', duties: ['교칙'] }),
    member({ id: 'b', name: 'B', duties: ['수업'] }),
    member({ id: 'c', name: 'C', duties: ['보건'] }),
  ];
  const cat = catalogFromStory(JSON.stringify({
    ...JSON.parse(CATALOG_JSON),
    flags: { rulebreak: { owner_duty: '교칙' }, injury: { owner_duty: '보건' } },
  }));
  const r = approveExtras({
    cast, scene: { location: '교실', present_ids: ['nari', 'a', 'b', 'c'] },
    focus_id: 'nari', catalog: cat,
    applied_events: [RULEBREAK, CLASS_START, { kind: 'flag', id: 'injury' }],
  });
  assert.equal(MAX_EXTRAS, 2);
  assert.equal(r.approved.length, 2);
  assert.equal(why(r, 'c'), 'cap');
});

t('no_focus — 포커스가 없으면 승인 0, eligible 계산조차 하지 않는다', () => {
  const r = run({ focus_id: null, applied_events: [RULEBREAK, CLASS_START] });
  assert.deepEqual(r.approved, []);
  assert.deepEqual(r.eligible_ids, []);
  assert.equal(r.k_opened, 0);
  for (const m of CAST) assert.equal(why(r, m.id), 'no_focus', m.id);
});

t('the focus is never their own extra even when their duty owns the event', () => {
  const r = run({ focus_id: 'sera', applied_events: [RULEBREAK] });
  assert.equal(ids(r).includes('sera'), false);
  assert.equal(why(r, 'sera'), 'is_focus');
});

t('self_repeat still applies: last beat extras cannot reopen immediately', () => {
  const scene: Scene = { ...CLASSROOM, last_beat: { focus_id: 'nari', extra_ids: ['sera'], unresolved: [] } };
  const r = run({ scene, applied_events: [RULEBREAK] });
  assert.deepEqual(r.approved, []);
  assert.equal(why(r, 'sera'), 'self_repeat');
});

// ── an event that owns nothing opens nothing ────────────────────────────────
t('a transition with no owner_duty / closer_duty opens no slot', () => {
  const cat = catalogFromStory(JSON.stringify({
    ...JSON.parse(CATALOG_JSON),
    flags: { rulebreak: { owner_stage: 'reg' } },   // no owner_duty
    stages: { class: {} },                          // no closer_duty
  }));
  const r = run({ catalog: cat, applied_events: [RULEBREAK, CLASS_START] });
  assert.deepEqual(r.approved, []);
  assert.deepEqual(r.hard_events, []);
});

t('an empty catalog rejects everything rather than inventing an owner', () => {
  const r = run({ catalog: catalogFromStory('{}'), applied_events: [RULEBREAK, CLASS_START] });
  assert.deepEqual(r.approved, []);
});

// ── the model cannot open a slot ────────────────────────────────────────────
t('EXTRA_SCORE_ENABLED is false, and scores change nothing while it is', () => {
  assert.equal(EXTRA_SCORE_ENABLED, false);
  const withScores = run({ scores: { sera: 99, hayeon: 99, yura: 99, luna: 99 }, tau: 1 });
  assert.deepEqual(withScores.approved, []);
  assert.equal(withScores.score_ran, false);
});

t('secondary_triggers is gone from the delta prompt and from product code', () => {
  const prompt = src('apps/server/src/prompt/sceneDeltaPrompt.ts');
  assert.equal(/secondary_triggers/.test(code('apps/server/src/prompt/sceneDeltaPrompt.ts')), false);
  // present_ids advertising survives — only the trigger nomination is removed
  assert.ok(prompt.includes('present_ids_add'));
  assert.ok(prompt.includes('present_ids_remove'));
  assert.equal(fs.existsSync(path.join(appRoot, 'apps/server/src/prompt/auxGate.ts')), false);

  const promptDir = path.join(appRoot, 'apps/server/src/prompt');
  for (const f of fs.readdirSync(promptDir)) {
    const s = code(`apps/server/src/prompt/${f}`);
    assert.equal(/secondary_triggers|parseSecondaryTriggers|trigger_exists/.test(s), false, f);
  }
});

t('approveExtras does not read the model patch at all', () => {
  const s = code('apps/server/src/prompt/approveExtras.ts');
  // No model patch, no model-written justification, no IO. The `reason` field it
  // does emit is the SERVER's rejection reason, which is the opposite thing.
  for (const banned of ['patch', 'trigger', 'better-sqlite3', 'fetch(', 'ModelClient', 'Math.random']) {
    assert.equal(s.includes(banned), false, `approveExtras must not contain ${banned}`);
  }
  // its only opener is a server-applied event
  assert.ok(s.includes('applied_events'));
});

t('the tau constant file exists but is not imported by product code', () => {
  const prereg = path.join(appRoot, 'bench/approveExtras/preregistration.md');
  assert.ok(fs.existsSync(prereg), 'TAU must be sealed before the signal can be enabled');
  const promptDir = path.join(appRoot, 'apps/server/src/prompt');
  for (const f of fs.readdirSync(promptDir)) {
    assert.equal(code(`apps/server/src/prompt/${f}`).includes('approveExtras/preregistration'), false, f);
  }
});

// ── ordering: approval runs after apply and after focus (A-5) ───────────────
t('A-5: approval consumes the POST-apply events, never a pre-apply guess', () => {
  const s = code('apps/server/src/prompt/composeBeat.ts');
  const apply = s.indexOf('applySceneDelta(');
  const focus = s.indexOf('resolveFocus(');
  const approve = s.indexOf('approveExtras(');
  const assign = s.indexOf('assignSpeakers(');
  assert.ok(apply < focus, 'focus after apply');
  assert.ok(focus < approve, 'approval after focus');
  assert.ok(approve < assign, 'assignment last');
  assert.ok(s.includes('applied.appliedEvents'));
});

t('end-to-end through composePartyTurn: flag flip opens exactly 세라', () => {
  const out = planBeat({
    scene: { ...CLASSROOM, scene_version: 0 },
    patch: { base_version: 0, flags: { rulebreak: true } },
    catalog: CAT,
    current_version: 0,
    user_text: '나리, 네 이야기 말인데.',
    cast: CAST,
    main_character_id: 'hayeon',
  });
  assert.equal(out.focus.focus_id, 'nari');
  assert.deepEqual(out.applied.appliedEvents, [RULEBREAK]);
  assert.deepEqual(out.approved_extras.map((a) => a.character_id), ['sera']);
  assert.deepEqual(out.messages.map((m) => `${m.slot}:${m.speaker_name}`), ['main:나리', 'extra:세라']);
});

t('end-to-end with no world change: focus speaks alone', () => {
  const out = planBeat({
    scene: { ...CLASSROOM, scene_version: 0 },
    patch: { base_version: 0 },
    catalog: CAT,
    current_version: 0,
    user_text: '나리, 네 이야기 말인데.',
    cast: CAST,
    main_character_id: 'hayeon',
  });
  assert.deepEqual(out.applied.appliedEvents, []);
  assert.deepEqual(out.approved_extras, []);
  assert.deepEqual(out.messages.map((m) => m.slot), ['main']);
});

// ── K=1 must not come back ──────────────────────────────────────────────────
t('no K=1 experiment: the cap is 2 and the default is 0, not 1', () => {
  assert.equal(MAX_EXTRAS, 2);
  assert.equal(run().k_opened, 0);
  assert.equal(run({ applied_events: [RULEBREAK, CLASS_START] }).k_opened, 2);
  const s = code('apps/server/src/prompt/approveExtras.ts');
  assert.equal(/K_MAX\s*=\s*1|MAX_EXTRAS\s*=\s*1/.test(s), false);
});

t('1:1 prompt text is untouched by this slice', () => {
  const templates = src('apps/server/src/prompt/templates.ts');
  assert.ok(templates.includes("오직 '{{char}}' 역할만 연기한다"));
  assert.equal(/approveExtras|hard_event/.test(templates), false);
  assert.equal(/approveExtras/.test(src('apps/server/src/prompt/builder.ts')), false);
});

console.log(`\n${passed} passed`);
