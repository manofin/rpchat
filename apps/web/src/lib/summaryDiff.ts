import type { Summary } from '../types';

export type DiffSegment = { type: 'same' | 'add' | 'del'; text: string };

function tokenize(text: string): string[] {
  return text.length ? text.split(/(\s+)/).filter((t) => t.length > 0) : [];
}

/**
 * Word-level LCS diff, display-only. No dependency (repo stays dependency-minimal).
 * O(n*m) DP table — summary content is capped at 6000 chars server-side (`summaryPatch`), so this stays cheap.
 */
export function diffWords(before: string, after: string): DiffSegment[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const segments: DiffSegment[] = [];
  function push(type: DiffSegment['type'], text: string) {
    const last = segments[segments.length - 1];
    if (last && last.type === type) last.text += text;
    else segments.push({ type, text });
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push('same', a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push('del', a[i]); i++; }
    else { push('add', b[j]); j++; }
  }
  while (i < n) { push('del', a[i]); i++; }
  while (j < m) { push('add', b[j]); j++; }
  return segments;
}

/** state is a single rolling baseline — always the latest approved row, regardless of the target's own timestamp (restore candidates predate it). */
export function currentApprovedState(summaries: Summary[]): Summary | null {
  const rows = summaries.filter((s) => s.tier === 'state' && s.status === 'approved');
  if (rows.length === 0) return null;
  return rows.reduce((latest, s) => (s.created_at > latest.created_at ? s : latest));
}

/** whole is self-referential (each new whole is generated from the prior approved whole as `prev`) — diff against the nearest earlier approved whole, never the row itself. */
export function priorApprovedWhole(summaries: Summary[], target: Summary): Summary | null {
  const rows = summaries.filter(
    (s) => s.tier === 'whole' && s.status === 'approved' && s.id !== target.id && s.created_at < target.created_at,
  );
  if (rows.length === 0) return null;
  return rows.reduce((latest, s) => (s.created_at > latest.created_at ? s : latest));
}
