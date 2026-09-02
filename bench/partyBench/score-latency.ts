/** Bench-Latency scoring. Cuts from preregistration.md §0-3 — do not soften here. */

export const LATENCY_CUT = {
  n: 50,
  p50_s: 90,
  p95_s: 120,
  overflow: 0,
  queue_depth: 1,
  context_tokens: 16384,
  p50_redesign_s: 150,
} as const;

/** Same estimator as sketchBench/lib/stats.ts pct: floor(p/100 * n). */
export function percentile(arr: number[], p: number): number | null {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export function turnMs(row: { call1_ms: number; call2_ms: number }): number {
  return row.call1_ms + row.call2_ms;
}

export function overflowCount(promptTokens: number[]): number {
  return promptTokens.filter((n) => n > LATENCY_CUT.context_tokens).length;
}

export function latencyVerdict(args: { p50_s: number; p95_s: number; overflow: number; n: number }): boolean {
  return (
    args.n === LATENCY_CUT.n &&
    args.p50_s <= LATENCY_CUT.p50_s &&
    args.p95_s <= LATENCY_CUT.p95_s &&
    args.overflow === LATENCY_CUT.overflow
  );
}

export function redesignTrigger(p50_s: number): boolean {
  return p50_s >= LATENCY_CUT.p50_redesign_s;
}
