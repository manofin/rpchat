/**
 * npm run test:benches -- partyRequestPlan --output-dir <new directory>
 * named lock 코드-party-u2-plan-2-20261021 §7. 기대값은 이 파일 안에 사람이 쓴 상수다.
 * fixture(bench/fixtures/party-u2-plan/cases.json)는 입력만 담고 계약을 정하지 않는다.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  planRequests,
  userProjection,
  isValidObservation,
  type Candidate,
  type PlanResult,
  type Snapshot,
  type Options,
} from '../apps/server/src/prompt/partyRequestPlan.ts';
import { audienceSchema } from '../apps/server/src/prompt/observation.ts';

let checks = 0;
let assertions = 0;
const equal = (a: unknown, b: unknown) => { assertions++; assert.deepEqual(a, b); };
const truth = (value: unknown, message?: string) => { assertions++; assert.ok(value, message); };
function t(name: string, fn: () => void) {
  const before = assertions; fn(); assert.ok(assertions > before, 'test must assert');
  console.log(`ok ${++checks} ${name}`);
}

type Case = { doc_case: string; snapshot: Snapshot; candidates: Candidate[]; options: Options };
const casesFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/party-u2-plan/cases.json');
const cases = JSON.parse(fs.readFileSync(casesFile, 'utf8')) as Case[];
const byCase = (id: string): Case => {
  const found = cases.find((c) => c.doc_case === id);
  if (!found) throw new Error(`fixture missing: ${id}`);
  return found;
};
const run = (id: string): PlanResult => {
  const c = byCase(id);
  return planRequests(c.snapshot, c.candidates, c.options);
};
const bytes = (r: PlanResult): string => JSON.stringify({ internal: r, projection: userProjection(r) });
const order = (r: PlanResult): string[] => (r.execution_plan ?? []).map((e) => e.candidate_id);
const ctxOf = (r: PlanResult, cand: string, item: string) =>
  (r.context[cand] ?? []).find((v) => v.item_id === item);

t('1 1-A: root set kept, order delta then script', () => {
  const r = run('1-A');
  equal(r.status, 'ok');
  equal(order(r), ['delta', 'script']);
  equal(r.candidates['delta'].verdict, 'kept');
  equal(r.candidates['script'].verdict, 'kept');
});

t('2 1-B: whisper kept, storage/exposure per request kind', () => {
  const r = run('1-B');
  equal(r.status, 'ok');
  equal(order(r), ['delta', 'script', 'whisper']);
  const byId = Object.fromEntries((r.execution_plan ?? []).map((e) => [e.candidate_id, e]));
  equal([byId['whisper'].storage, byId['whisper'].exposure], ['messages', 'private_hold_until_turn_success']);
  equal([byId['script'].storage, byId['script'].exposure], ['messages', 'public_verified_stream']);
  equal([byId['delta'].storage, byId['delta'].exposure], ['none', 'none']);
});

t('3 1-C: unsupported candidate outside N is omitted', () => {
  const r = run('1-C');
  equal(r.status, 'ok');
  equal(r.candidates['x'].verdict, 'omitted');
  equal(order(r), ['delta', 'script']);
});

t('4 1-D: public script depending on {a} candidate is plan_rejected', () => {
  const r = run('1-D');
  equal(r.status, 'plan_rejected');
  equal(r.reason, 'unsupported_in_needed');
  equal(r.reason_candidate_id, 'x');
});

t('5 1-E: scene depending on {gm} candidate is plan_rejected', () => {
  const r = run('1-E');
  equal(r.status, 'plan_rejected');
  equal(r.reason, 'unsupported_in_needed');
  equal(r.reason_candidate_id, 'g');
});

t('6 1-F: {a,b} candidate without dependents is omitted', () => {
  const r = run('1-F');
  equal(r.status, 'ok');
  equal(r.candidates['x'].verdict, 'omitted');
});

t('7 1-G: unsupported chain outside N is omitted', () => {
  const r = run('1-G');
  equal(r.status, 'ok');
  equal(r.candidates['x'].verdict, 'omitted');
  equal(r.candidates['y'].verdict, 'omitted');
  equal(order(r), ['delta', 'script']);
});

t('8 1-H: candidate array order does not change the result bytes', () => {
  equal(bytes(run('1-H')), bytes(run('1-G')));
});

t('9 1-I: supported whisper depending on unsupported x is plan_rejected', () => {
  const r = run('1-I');
  equal(r.status, 'plan_rejected');
  equal(r.reason, 'unsupported_in_needed');
  equal(r.reason_candidate_id, 'x');
});

t('10 1-J: supported but unused auxiliary candidate is omitted', () => {
  const r = run('1-J');
  equal(r.status, 'ok');
  equal(r.candidates['z'].verdict, 'omitted');
});

t('11 1-K/1-L/1-M: structural errors are invalid_plan', () => {
  const k = run('1-K');
  equal(k.status, 'invalid_plan');
  equal(k.reason, 'missing_predecessor');
  equal(k.reason_candidate_id, 'script');
  const l = run('1-L');
  equal(l.status, 'invalid_plan');
  equal(l.reason, 'duplicate_id');
  equal(l.reason_candidate_id, 'script');
  const m = run('1-M');
  equal(m.status, 'invalid_plan');
  equal(m.reason, 'cycle');
  equal(m.reason_candidate_id, 'p');
});

t('12 1-N/1-P: internal control with no user-less output segment is kept', () => {
  for (const id of ['1-N', '1-P']) {
    const r = run(id);
    equal(r.status, 'ok');
    equal(r.candidates['delta'].verdict, 'kept');
    truth((r.execution_plan ?? []).some((e) => e.candidate_id === 'delta'), 'delta must be in the execution plan');
  }
});

t('13 1-O: private path context into public-scope candidate is input_permission', () => {
  const r = run('1-O');
  equal(r.status, 'invalid_plan');
  equal(r.reason, 'input_permission');
  equal(r.reason_candidate_id, 'delta');
});

t('14 1-Q: internal candidate whose scope lacks user, outside N, is omitted', () => {
  const r = run('1-Q');
  equal(r.status, 'ok');
  equal(r.candidates['q'].verdict, 'omitted');
  equal(r.candidates['x'].verdict, 'omitted');
});

t('15 1-R: transitive reachable consumers widen S(x); private context fails input_permission', () => {
  const r = run('1-R');
  equal(r.status, 'invalid_plan');
  equal(r.reason, 'input_permission');
  equal(r.reason_candidate_id, 'x');
});

t('16 1-S: declared_scope differing from computed S(x) is declared_scope_mismatch', () => {
  const r = run('1-S');
  equal(r.status, 'invalid_plan');
  equal(r.reason, 'declared_scope_mismatch');
  equal(r.reason_candidate_id, 'x');
});

t('17 1-T: public-only internal chain into public script is ok', () => {
  const r = run('1-T');
  equal(r.status, 'ok');
  equal(order(r), ['delta', 'x', 'y', 'script']);
});

t('18 order rule: among executable candidates the smallest id by codepoint is picked', () => {
  const base = byCase('1-T');
  const candidates = base.candidates.map((c) => {
    if (c.id === 'x') return { ...c, id: 'q2' };
    if (c.id === 'y') return { ...c, id: 'q1', predecessors: [] as string[] };
    if (c.id === 'script') return { ...c, predecessors: ['delta', 'q1', 'q2'] };
    return c;
  }).map((c) => (c.id === 'q2' ? { ...c, predecessors: [] as string[] } : c));
  const r = planRequests(base.snapshot, candidates, base.options);
  equal(r.status, 'ok');
  equal(order(r), ['delta', 'q1', 'q2', 'script']);
});

function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr.slice()];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}
function seededShuffle<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

t('19 order independence: all inputs of tests 1-18 under permuted candidate arrays', () => {
  const base1T = byCase('1-T');
  const renamed18 = base1T.candidates.map((c) => {
    if (c.id === 'x') return { ...c, id: 'q2', predecessors: [] as string[] };
    if (c.id === 'y') return { ...c, id: 'q1', predecessors: [] as string[] };
    if (c.id === 'script') return { ...c, predecessors: ['delta', 'q1', 'q2'] };
    return c;
  });
  const inputs: { snapshot: Snapshot; candidates: Candidate[]; options: Options }[] = [
    ...['1-A', '1-B', '1-C', '1-D', '1-E', '1-F', '1-G', '1-H', '1-I', '1-J', '1-K', '1-L', '1-M', '1-N', '1-P', '1-O', '1-Q', '1-R', '1-S', '1-T'].map((id) => byCase(id)),
    { snapshot: base1T.snapshot, candidates: renamed18, options: base1T.options },
  ];
  for (const input of inputs) {
    const expected = bytes(planRequests(input.snapshot, input.candidates, input.options));
    const variants = input.candidates.length <= 6
      ? permutations(input.candidates)
      : Array.from({ length: 50 }, (_, i) => seededShuffle(input.candidates, i + 1));
    truth(variants.length >= 1, 'permutation variants must exist');
    for (const v of variants) {
      equal(bytes(planRequests(input.snapshot, v, input.options)), expected);
    }
  }
});

t('20 3-G: valid past row with non-participant recipient is not corruption', () => {
  const ga = run('3-G-ga');
  equal(ga.status, 'ok');
  equal(ga.candidates['whisper2'].verdict, 'kept');
  const r1 = ctxOf(ga, 'whisper2', 'r1');
  truth(r1 && r1.included === true, 'r1 must be included');
  equal(r1?.reason, undefined);
  const na = run('3-G-na');
  equal(na.status, 'invalid_plan');
  equal(na.reason, 'input_permission');
  equal(na.reason_candidate_id, 'script');
});

t('21 3-H: schema-violating observation is excluded; required exclusion is invalid_plan', () => {
  const ga = run('3-H-ga');
  equal(ga.status, 'ok');
  equal(ctxOf(ga, 'script', 'r2')?.reason, 'audience_invalid');
  equal(ctxOf(ga, 'script', 'r2')?.included, false);
  const na = run('3-H-na');
  equal(na.status, 'invalid_plan');
  equal(na.reason, 'required_context_excluded');
});

t('22 3-I/3-J: unknown audience is excluded; required unknown is invalid_plan', () => {
  const i = run('3-I');
  equal(i.status, 'ok');
  equal(ctxOf(i, 'script', 'mem-x')?.reason, 'audience_unknown');
  const j = run('3-J');
  equal(j.status, 'invalid_plan');
  equal(j.reason, 'required_context_excluded');
});

t('23 3-K/3-L: legacy rows without observation follow the observation filter', () => {
  const k = run('3-K');
  equal(k.status, 'ok');
  const r3k = ctxOf(k, 'script', 'r3');
  truth(r3k && r3k.included === true, 'filter off: legacy row is public context');
  equal(r3k?.scope, { visibility: 'public' });
  const l = run('3-L');
  equal(l.status, 'ok');
  const r3l = ctxOf(l, 'script', 'r3');
  equal(r3l?.included, false);
  equal(r3l?.reason, 'legacy_unclassified');
});

t('24 3-M: row outside the current path is excluded out_of_path', () => {
  const r = run('3-M');
  equal(r.status, 'ok');
  const v = ctxOf(r, 'script', 'r-out');
  equal(v?.included, false);
  equal(v?.reason, 'out_of_path');
});

t('25 schema parity: planner validity equals audienceSchema.safeParse on 12 fixed samples', () => {
  const samples: unknown[] = [
    { visibility: 'public' },
    { visibility: 'private', recipient_ids: ['a'] },
    { visibility: 'private', recipient_ids: ['user', 'a'], observer_ids: ['b'] },
    { visibility: 'private', recipient_ids: [] },
    { visibility: 'private' },
    { visibility: 'private', recipient_ids: ['a'], extra: 1 },
    { visibility: 'friends', recipient_ids: ['a'] },
    { visibility: 'private', recipient_ids: [1] },
    { visibility: 'private', recipient_ids: [''] },
    { visibility: 'private', recipient_ids: Array.from({ length: 101 }, () => 'a') },
    { visibility: 'public', observer_ids: ['a'] },
    'private',
  ];
  equal(samples.length, 12);
  for (const s of samples) {
    equal(isValidObservation(s), audienceSchema.safeParse(s).success);
  }
});

t('26 4-A/4-B: existence of hidden material does not change the user projection bytes', () => {
  const withX = byCase('1-C');
  const withoutX = { ...withX, candidates: withX.candidates.filter((c) => c.id !== 'x') };
  equal(
    JSON.stringify(userProjection(planRequests(withX.snapshot, withX.candidates, withX.options))),
    JSON.stringify(userProjection(planRequests(withoutX.snapshot, withoutX.candidates, withoutX.options))),
  );
  const base1A = byCase('1-A');
  const withHidden: Snapshot = {
    ...base1A.snapshot,
    approved_items: [{ id: 'mem-hidden', allowed: { visibility: 'private', recipient_ids: ['a'] } }],
  };
  equal(
    JSON.stringify(userProjection(planRequests(base1A.snapshot, base1A.candidates, base1A.options))),
    JSON.stringify(userProjection(planRequests(withHidden, base1A.candidates, base1A.options))),
  );
});

t('27 4-5: rejected/invalid plans project to exactly the unavailable object without identifiers', () => {
  const expected = { status: 'unavailable', code: 'party_plan_unavailable' };
  for (const id of ['1-D', '1-E', '1-I', '1-K', '1-L', '1-M', '1-O', '1-R', '1-S']) {
    const p = userProjection(run(id));
    equal(p, expected);
    const text = JSON.stringify(p);
    for (const ident of ['"delta"', '"script"', '"whisper"', '"x"', '"g"', '"p"', '"q"', '"y"', '"r1"', '"mem-a"', '"setting"']) {
      truth(!text.includes(ident), `projection must not contain ${ident}`);
    }
  }
});

t('28 4-1 invariant: every ok execution plan has only user-including segments and none/none internal storage', () => {
  for (const id of ['1-A', '1-B', '1-C', '1-F', '1-G', '1-H', '1-J', '1-N', '1-P', '1-Q', '1-T', '3-G-ga', '3-H-ga', '3-I', '3-K', '3-L', '3-M']) {
    const r = run(id);
    equal(r.status, 'ok');
    for (const e of r.execution_plan ?? []) {
      for (const s of e.segments ?? []) {
        truth(
          s.recipients.visibility === 'public' || s.recipients.recipient_ids.includes('user'),
          `segment without user in ${id}`,
        );
      }
      if (e.kind === 'internal_control') {
        equal([e.storage, e.exposure], ['none', 'none']);
      }
    }
  }
});

t('29 3-2/3-3: permission version includes and excludes exactly the contracted inputs', () => {
  const snap: Snapshot = {
    snapshot_id: 'snap-v',
    participants: ['b', 'a'],
    observation_filter: true,
    present_ids: ['a', 'b'],
    path: [{ id: 'r1', generation_id: 'gen-1', observation: { visibility: 'public' } }],
    approved_items: [{ id: 'm1', allowed: { visibility: 'public' } }],
  };
  const own = 'gen-own';
  const base = planRequests(snap, byCase('1-A').candidates, { own_generation_id: own }).permission_version;
  const ownRow: Snapshot = { ...snap, path: [...snap.path, { id: 'r2', generation_id: own, observation: { visibility: 'private', recipient_ids: ['user'] } }] };
  equal(planRequests(ownRow, byCase('1-A').candidates, { own_generation_id: own }).permission_version, base);
  const otherRow: Snapshot = { ...snap, path: [...snap.path, { id: 'r2', generation_id: 'gen-other', observation: { visibility: 'public' } }] };
  truth(planRequests(otherRow, byCase('1-A').candidates, { own_generation_id: own }).permission_version !== base);
  const changedAllowed: Snapshot = { ...snap, approved_items: [{ id: 'm1', allowed: { visibility: 'private', recipient_ids: ['a'] } }] };
  truth(planRequests(changedAllowed, byCase('1-A').candidates, { own_generation_id: own }).permission_version !== base);
  const changedPresent: Snapshot = { ...snap, present_ids: ['a'] };
  truth(planRequests(changedPresent, byCase('1-A').candidates, { own_generation_id: own }).permission_version !== base);
  const reordered: Snapshot = { ...snap, participants: ['a', 'b'] };
  equal(planRequests(reordered, byCase('1-A').candidates, { own_generation_id: own }).permission_version, base);
});

t('30 determinism: the same input twice yields identical internal and projection bytes', () => {
  const c = byCase('1-B');
  equal(bytes(planRequests(c.snapshot, c.candidates, c.options)), bytes(planRequests(c.snapshot, c.candidates, c.options)));
});

t('31 purity: partyRequestPlan.ts imports and forbidden constructs stay within §5-1', () => {
  const srcPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../apps/server/src/prompt/partyRequestPlan.ts');
  const src = fs.readFileSync(srcPath, 'utf8');
  const importLines = src.split('\n').filter((l) => /^import\s/.test(l));
  truth(importLines.length >= 2, 'expected at least the zod and node:crypto imports');
  for (const line of importLines) {
    truth(
      /from 'zod'/.test(line) || /from 'node:crypto'/.test(line) || /^import\s+type\s.*from '\.\//.test(line),
      `import outside §5-1 allowlist: ${line}`,
    );
  }
  for (const banned of ['process.env', 'Date.now', 'Math.random', 'fetch']) {
    truth(!src.includes(banned), `source must not contain ${banned}`);
  }
});
