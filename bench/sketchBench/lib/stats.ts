import type { Percentiles } from './types.ts';

/** Same estimator as Task 2 run-chat-baseline.ts (floor(p/100 * n)). */
export function pct(arr: number[], p: number): number | null {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export function percentiles(arr: number[]): Percentiles {
  const raw = [...arr].sort((a, b) => a - b);
  const excl = raw.length > 1 ? raw.slice(0, -1) : [];
  return {
    p50: pct(raw, 50),
    p95: pct(raw, 95),
    p95_excl_max: pct(excl, 95),
    n: raw.length,
    raw,
  };
}

export function intervalsOverlap(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 < b1 && b0 < a1;
}

export function compressActiveIntervals(samples: Array<{ t_poll: number; our_active: boolean }>): Array<{ start: number; end: number }> {
  // activePoller fires each tick without awaiting the previous one's completion, so
  // under network jitter a later tick can resolve (and push into the samples array)
  // before an earlier one -> array order is not guaranteed to match t_poll order.
  // Sort defensively rather than trusting push order (confirmed via synthetic repro:
  // unsorted [t=800,t=400] collapses into an inverted {start:800,end:400} interval).
  const ordered = [...samples].sort((a, b) => a.t_poll - b.t_poll);
  const out: Array<{ start: number; end: number }> = [];
  let cur: { start: number; end: number } | null = null;
  for (const s of ordered) {
    if (s.our_active) {
      if (!cur) cur = { start: s.t_poll, end: s.t_poll };
      else cur.end = s.t_poll;
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function relDelta(baseline: number | null, current: number | null): number | null {
  if (baseline == null || current == null || baseline === 0) return null;
  return (current - baseline) / baseline;
}

export function fmtPct(x: number | null): string {
  if (x == null) return 'NA';
  return `${(x * 100).toFixed(2)}%`;
}

export function fmtNum(x: number | null, digits = 2): string {
  if (x == null) return 'NA';
  return Number.isInteger(x) ? String(x) : x.toFixed(digits);
}
