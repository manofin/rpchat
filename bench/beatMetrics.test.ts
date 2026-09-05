/**
 * npx tsx bench/beatMetrics.test.ts
 * f9-beat-metrics (S5) — §8-5 계측.
 *
 * The measurement this exists for is "먼저 슬롯 0이 실제로 나오는지 본다": `k_opened === 0`
 * is a SUCCESS reading, so the log has to record it rather than treat an empty
 * approval as a miss. `extra_count === 3` is the bug signal, and it must be
 * structurally impossible.
 * Isolated: no systemd, no live DB, no model call, no migration, no live generate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finishBeat, planBeat, type BeatPlanInput } from '../apps/server/src/prompt/composeBeat.ts';
import { MAX_EXTRAS } from '../apps/server/src/prompt/assignSpeakers.ts';
import { EXTRA_SCORE_ENABLED } from '../apps/server/src/prompt/approveExtras.ts';
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

const member = (o: Partial<CastMember> & { id: string; name: string }): CastMember => ({
  aliases: [], duties: [], place: '교실', role: 'secondary', ...o,
});
const NARI = member({ id: 'nari', name: '나리', duties: ['이야기'] });
const SERA = member({ id: 'sera', name: '세라', duties: ['교칙'] });
const HAYEON = member({ id: 'hayeon', name: '하연', duties: ['수업'], role: 'main' });
const LUNA = member({ id: 'luna', name: '루나', talkativeness: 0.9 });
const MIR = member({ id: 'mir', name: '미르', locked: true });
const YUKI = member({ id: 'yuki', name: '유키', duties: ['경비'], place: '경비실' });
const CAST = [NARI, SERA, HAYEON, LUNA, MIR, YUKI];

const CLASSROOM: Scene = {
  location: '교실', arc: 'entry', stage: 'reg', clock_minutes: 577,
  scene_version: 0, present_ids: ['nari', 'sera', 'hayeon', 'luna', 'mir'],
};

const CAT = catalogFromStory(JSON.stringify({
  places: [{ id: '교실', default_focus: 'hayeon' }],
  arcs: ['entry'], stagesByArc: { entry: ['reg', 'class'] },
  flags: { rulebreak: { owner_duty: '교칙' } },
  stages: { class: { closer_duty: '수업' } },
}));

const input = (o: Partial<BeatPlanInput> = {}): BeatPlanInput => ({
  conversation_id: 'conv-1', scene: CLASSROOM, catalog: CAT, current_version: 0,
  user_text: '나리, 네 이야기 말인데.', cast: CAST, main_character_id: 'hayeon',
  message_id: 'msg-1', ...o,
});

/** Mirrors the shape chat.ts writes into generation_log.budget_json.beat_log. */
function beatLog(plan: ReturnType<typeof planBeat>, finished: ReturnType<typeof finishBeat>) {
  return {
    focus_id: plan.focus.focus_id,
    focus_reason: plan.focus.reason,
    extra_ids: finished.scene.last_beat?.extra_ids ?? [],
    extra_count: (finished.scene.last_beat?.extra_ids ?? []).length,
    eligible_ids: plan.eligible_ids,
    rejected: plan.rejected,
    ambient_ids: plan.ambient.map((a) => a.character_id),
    hard_events: plan.applied.appliedEvents,
    k_opened: plan.approved_extras.length,
    score_ran: false,
    ambient_as_speech: 0,
    asset_nulls: finished.blocks.filter((b) => b.kind === 'line' && !b.asset_path).length,
    unresolved: finished.scene.last_beat?.unresolved ?? [],
  };
}

const outputs = { narration: '서술.', focus_text: '"시비냐."', extra_texts: {} as Record<string, string> };

// ── 1. k_opened === 0 is a reading, not a miss ──────────────────────────────
t('a quiet turn logs k_opened 0 WITH a non-empty eligible set', () => {
  const i = input({ patch: { base_version: 0 } });
  const plan = planBeat(i);
  const log = beatLog(plan, finishBeat(i, plan, outputs));
  assert.equal(log.k_opened, 0);
  assert.equal(log.extra_count, 0);
  assert.ok(log.eligible_ids.length > 0, 'the distinction between "empty room" and "nobody earned it"');
  assert.ok(log.rejected.length > 0, 'and every cut has a reason');
});

t('every rejection reason is recorded, so a 0 can be explained', () => {
  const i = input({ patch: { base_version: 0 } });
  const plan = planBeat(i);
  const reasons = new Set(plan.rejected.map((r) => r.reason));
  assert.ok(reasons.has('is_focus'));
  assert.ok(reasons.has('locked'));
  assert.ok(reasons.has('place'));
  assert.ok(reasons.has('no_hard_event'), 'the default outcome must be nameable');
});

// ── 2. the histogram cannot reach 3 ─────────────────────────────────────────
t('extra_count is structurally bounded to {0,1,2} — 3 is impossible, not just rare', () => {
  assert.equal(MAX_EXTRAS, 2);
  const cast = [
    NARI,
    member({ id: 'a', name: 'A', duties: ['교칙'] }),
    member({ id: 'b', name: 'B', duties: ['수업'] }),
    member({ id: 'c', name: 'C', duties: ['보건'] }),
  ];
  const cat = catalogFromStory(JSON.stringify({
    places: [{ id: '교실' }], arcs: ['entry'], stagesByArc: { entry: ['reg', 'class'] },
    flags: { rulebreak: { owner_duty: '교칙' }, injury: { owner_duty: '보건' } },
    stages: { class: { closer_duty: '수업' } },
  }));
  const i = input({
    cast, catalog: cat,
    scene: { location: '교실', arc: 'entry', stage: 'reg', scene_version: 0, present_ids: ['nari', 'a', 'b', 'c'] },
    patch: { base_version: 0, stage: 'class', flags: { rulebreak: true, injury: true } },
  });
  const plan = planBeat(i);
  assert.equal(plan.applied.appliedEvents.length, 3, 'three transitions really did happen');
  assert.equal(plan.approved_extras.length, 2, 'and only two slots exist');
  const log = beatLog(plan, finishBeat(i, plan, { ...outputs, extra_texts: { a: 'x', b: 'y' } }));
  assert.equal(log.extra_count, 2);
  assert.ok(log.rejected.some((r) => r.reason === 'cap'));
});

// ── 3. the signal stayed off ────────────────────────────────────────────────
t('score_ran is logged and is false, so "the signal was off" is evidence not memory', () => {
  assert.equal(EXTRA_SCORE_ENABLED, false);
  const i = input({ patch: { base_version: 0 } });
  const plan = planBeat(i);
  assert.equal(beatLog(plan, finishBeat(i, plan, outputs)).score_ran, false);
  const chat = code('apps/server/src/routes/chat.ts');
  assert.ok(chat.includes('score_ran: false'));
});

// ── 4. ambient never became speech ──────────────────────────────────────────
t('ambient_as_speech is 0 because ambient ids never appear as line speakers', () => {
  const i = input({ patch: { base_version: 0, flags: { rulebreak: true } } });
  const plan = planBeat(i);
  const finished = finishBeat(i, plan, { ...outputs, extra_texts: { sera: '"교칙 위반이야."' } });
  const log = beatLog(plan, finished);
  const speakers = new Set(finished.blocks.filter((b) => b.kind === 'line').map((b) => b.speaker_character_id));
  for (const id of log.ambient_ids) assert.equal(speakers.has(id), false, id);
  assert.equal(log.ambient_as_speech, 0);
  // and narration blocks carry no speaker at all
  for (const b of finished.blocks.filter((x) => x.kind === 'narration')) {
    assert.equal(b.speaker_character_id, null);
  }
});

// ── 5. fp_scene proxies: nobody out of place got a slot ─────────────────────
t('an absent or locked character never appears in extra_ids', () => {
  const i = input({ patch: { base_version: 0, flags: { rulebreak: true } } });
  const plan = planBeat(i);
  const log = beatLog(plan, finishBeat(i, plan, { ...outputs, extra_texts: { sera: 'x' } }));
  assert.equal(log.extra_ids.includes('yuki'), false);
  assert.equal(log.extra_ids.includes('mir'), false);
  assert.deepEqual(log.extra_ids, ['sera']);
});

t('duty_transfer is visible: an overlap is logged as a reason, not silently dropped', () => {
  const cast = CAST.map((m) => (m.id === 'nari' ? { ...m, duties: ['이야기', '교칙'] } : m));
  const i = input({ cast, patch: { base_version: 0, flags: { rulebreak: true } } });
  const plan = planBeat(i);
  const log = beatLog(plan, finishBeat(i, plan, outputs));
  assert.equal(log.k_opened, 0);
  assert.ok(log.rejected.some((r) => r.id === 'sera' && r.reason === 'duty_overlap'));
});

// ── 6. focus accuracy and asset coverage ────────────────────────────────────
t('focus_id and focus_reason are both logged, so a miss is attributable', () => {
  const targeted = beatLog(...(() => { const i = input({ patch: { base_version: 0 } }); const p = planBeat(i); return [p, finishBeat(i, p, outputs)] as const; })());
  assert.equal(targeted.focus_id, 'nari');
  assert.equal(targeted.focus_reason, 'targeted');

  const i2 = input({ user_text: '교실을 둘러본다.', patch: { base_version: 0 } });
  const p2 = planBeat(i2);
  const fallback = beatLog(p2, finishBeat(i2, p2, outputs));
  assert.equal(fallback.focus_id, 'hayeon');
  assert.equal(fallback.focus_reason, 'default_focus');
});

t('asset_nulls counts the lines that rendered without an image', () => {
  const i = input({ patch: { base_version: 0 } });
  const plan = planBeat(i);
  const log = beatLog(plan, finishBeat(i, plan, outputs));
  assert.equal(log.asset_nulls, 1, 'no roster emotion/outfit here — name + line only, and that is fine');
});

t('unresolved is logged so the next beat focus is traceable', () => {
  const i = input({ patch: { base_version: 0 } });
  const plan = planBeat(i);
  assert.deepEqual(beatLog(plan, finishBeat(i, plan, { ...outputs, focus_text: '"왜 그래?"' })).unresolved, ['nari']);
  assert.deepEqual(beatLog(plan, finishBeat(i, plan, { ...outputs, focus_text: '"그래."' })).unresolved, []);
});

// ── 7. wiring ───────────────────────────────────────────────────────────────
t('chat.ts writes one beat_log row per beat with every field', () => {
  const s = code('apps/server/src/routes/chat.ts');
  const beat = s.slice(s.indexOf('async function generateBeat'));
  assert.ok(beat.includes('beat_log:'));
  for (const field of [
    'focus_id', 'focus_reason', 'extra_ids', 'extra_count', 'eligible_ids', 'rejected',
    'ambient_ids', 'hard_events', 'k_opened', 'score_ran', 'ambient_as_speech',
    'asset_nulls', 'unresolved', 'pass_ms',
  ]) {
    assert.ok(beat.includes(`${field}:`), `beat_log must record ${field}`);
  }
  assert.ok(beat.includes('INSERT INTO generation_log'));
});

t('per-pass latency is recorded, including one entry per Pass E and the choices pass', () => {
  const s = code('apps/server/src/routes/chat.ts');
  const beat = s.slice(s.indexOf('async function generateBeat'));
  // beat-post-extras-choices: `c` joined this shape when Pass C did. It is the one
  // pass whose cost is paid after the turn is already readable, so it is the one
  // whose latency most needs to stay visible.
  assert.ok(/passMs: \{ delta: number; n: number; f: number; e: number\[\]; c: number \}/.test(beat));
  assert.ok(beat.includes('passMs.delta ='));
  assert.ok(beat.includes('passMs.n ='));
  assert.ok(beat.includes('passMs.f ='));
  assert.ok(beat.includes('passMs.e.push('));
  assert.ok(beat.includes('passMs.c ='));
});

t('the choices pass records whether it fell open, not only how long it took', () => {
  const s = code('apps/server/src/routes/chat.ts');
  const beat = s.slice(s.indexOf('async function generateBeat'));
  for (const field of ['choices_ok', 'choices_count']) {
    assert.ok(beat.includes(`${field}:`), `beat_log must record ${field}`);
  }
});

t('the metrics row never blocks the turn: it is written after the beat is assembled', () => {
  const s = code('apps/server/src/routes/chat.ts');
  const beat = s.slice(s.indexOf('async function generateBeat'));
  const commitAt = beat.indexOf('UPDATE conversations SET scene_json = ?, updated_at = ?, last_message_at');
  const logAt = beat.indexOf('INSERT INTO generation_log');
  assert.ok(commitAt > 0 && logAt > commitAt, 'state is committed before the log row');
});

t('K=1 is not reintroduced anywhere in the beat path', () => {
  for (const f of ['approveExtras.ts', 'assignSpeakers.ts', 'composeBeat.ts']) {
    const s = code(`apps/server/src/prompt/${f}`);
    assert.equal(/MAX_EXTRAS\s*=\s*1|K_MAX\s*=\s*1|slice\(0,\s*1\)/.test(s), false, f);
  }
  assert.equal(MAX_EXTRAS, 2);
});

console.log(`\n${passed} passed`);
