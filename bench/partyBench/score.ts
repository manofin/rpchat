/** Bench-A scoring. Cuts from preregistration.md §0 — do not soften here. */
import type { AccuracyCase, ReachCase, RouterOutput } from './types.ts';

export const CUT = {
  A: 0.98,
  B: 0.9,
  C: 0.85,
  reach_explicit: 0.5,
  reach_duty: 0.3,
  reach_location: 0.1,
  reach_llm_max: 0.1,
  llm_redesign_lo: 0.4,
  llm_redesign_hi: 0.6,
} as const;

export type CaseScore = {
  id: string;
  bucket: string;
  expected_stage: number;
  expected_main_speaker_id: string | null;
  decided_stage: number;
  main_speaker_id: string | null;
  llm_reached: boolean;
  stage_ok: boolean;
  speaker_ok: boolean;
  correct: boolean;
  scores: Record<string, number>;
};

export function scoreAccuracyCase(fx: AccuracyCase, out: RouterOutput): CaseScore {
  const stage_ok = out.decided_stage === fx.expected_stage;
  const speaker_ok = out.main_speaker_id === fx.expected_main_speaker_id;
  return {
    id: fx.id,
    bucket: fx.bucket,
    expected_stage: fx.expected_stage,
    expected_main_speaker_id: fx.expected_main_speaker_id,
    decided_stage: out.decided_stage,
    main_speaker_id: out.main_speaker_id,
    llm_reached: out.llm_reached,
    stage_ok,
    speaker_ok,
    correct: stage_ok && speaker_ok,
    scores: out.scores,
  };
}

export function bucketStats(rows: CaseScore[], bucket: string) {
  const sub = rows.filter((r) => r.bucket === bucket);
  const correct = sub.filter((r) => r.correct).length;
  const n = sub.length;
  const pct = n === 0 ? 0 : correct / n;
  return { n, correct, pct };
}

export function reachOutputShares(decided: number[]) {
  const n = decided.length;
  const count = (s: number) => decided.filter((d) => d === s).length;
  const c1 = count(1);
  const c2 = count(2);
  const c3 = count(3);
  const c4 = count(4);
  return {
    n,
    stage1: c1,
    stage2: c2,
    stage3: c3,
    stage4: c4,
    pct1: n ? c1 / n : 0,
    pct2: n ? c2 / n : 0,
    pct3: n ? c3 / n : 0,
    pct4: n ? c4 / n : 0,
  };
}

export function fallbackRate(outs: RouterOutput[]) {
  const n = outs.length;
  const llm = outs.filter((o) => o.llm_reached).length;
  const s13 = n - llm;
  return {
    n,
    stages_1_3: s13,
    llm,
    stages_1_3_pct: n ? s13 / n : 0,
    llm_pct: n ? llm / n : 0,
  };
}

export function accuracyVerdict(A: { pct: number }, B: { pct: number }, C: { pct: number }) {
  return A.pct >= CUT.A && B.pct >= CUT.B && C.pct >= CUT.C;
}

export function reachVerdict(shares: { pct1: number; pct2: number; pct3: number; pct4: number }) {
  return (
    shares.pct1 >= CUT.reach_explicit &&
    shares.pct2 >= CUT.reach_duty &&
    shares.pct3 >= CUT.reach_location &&
    shares.pct4 <= CUT.reach_llm_max
  );
}

export function llmRedesignTrigger(llmPct: number) {
  return llmPct >= CUT.llm_redesign_lo && llmPct <= CUT.llm_redesign_hi;
}

export function reachInputMix(cases: ReachCase[]) {
  const n = (b: string) => cases.filter((c) => c.bucket === b).length;
  return {
    n: cases.length,
    explicit_name: n('explicit_name'),
    duty_fit: n('duty_fit'),
    scene_position: n('scene_position'),
    ambiguous: n('ambiguous'),
  };
}
