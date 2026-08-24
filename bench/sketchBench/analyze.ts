/**
 * Join Task 2 baseline + a concurrent JSON into a markdown verdict table (stdout).
 * REPORT.md is Task 4 — this only prints paste-ready rows.
 * --dry-run: synthetic concurrent (NOT A MEASUREMENT); every concurrent-dependent cell is STUB.
 * dryrun:true in the JSON also forces STUB (never PASS).
 */
import { readFileSync } from 'node:fs';
import { fmtNum, fmtPct, percentiles, relDelta } from './lib/stats.ts';
import type { BaselineResult, ConcurrentResult } from './lib/types.ts';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

type Verdict = 'PASS' | 'FAIL' | 'NA' | 'DEFERRED' | 'INSUFFICIENT_N' | 'STUB';

type Row = {
  id: string;
  metric: string;
  baseline: string;
  current: string;
  delta: string;
  gate: string;
  verdict: Verdict;
};

function tokPerS(rows: BaselineResult['rows']): number[] {
  return rows
    .filter((r) => r.status === 'complete' && r.completion_tokens && r.total_ms)
    .map((r) => r.completion_tokens! / (r.total_ms! / 1000));
}

function syntheticConcurrent(base: BaselineResult): ConcurrentResult {
  const ttfts = base.summary.ttft_ms.raw;
  const rows = ttfts.map((t, i) => ({
    i,
    t_sent: 0,
    t_done: 1,
    ttft_ms: t,
    total_ms: base.rows[i]?.total_ms ?? null,
    completion_tokens: base.rows[i]?.completion_tokens ?? null,
    status: 'complete',
    overlapped_image: i < 6,
    poll_active_start: 0,
    poll_active_end: 1,
  }));
  return {
    run: 'run-concurrent',
    dryrun: true,
    started_at: 0,
    ended_at: 0,
    convId: 'DRY_RUN_SYNTHETIC',
    chat: {
      rows,
      n_requested: ttfts.length,
      n_complete: ttfts.length,
      n_error: 0,
      n_overlapped: 6,
      ttft_ms: {
        all: percentiles(ttfts),
        overlapped: percentiles(ttfts.slice(0, 6)),
        non_overlapped: percentiles(ttfts.slice(6)),
      },
      tok_per_s: percentiles(tokPerS(base.rows)),
    },
    image: {
      rows: [],
      n_requested: 10,
      n_ok: 10,
      success_rate: 1,
      latency_ms: { p50: 2000, p95: 2000, p95_excl_max: 2000, n: 10, raw: Array(10).fill(2000) },
    },
    activePoll: { interval_ms: 400, samples: [], intervals: [] },
    memory: {
      snapshots: [],
      continuous: [],
      pid_before: null,
      pid_after: null,
      pid_stable: null,
      rss_delta_kb: null,
      swap_delta_bytes: null,
      pgrep_pattern: null,
    },
    environment: {
      hostname: 'dry-run',
      platform: 'dry-run',
      node: process.version,
      serve_base: '',
      draw_things_base: null,
      image_interval_ms: 0,
      n_chat: ttfts.length,
      n_image: 10,
    },
    notes: ['DRY_RUN_SYNTHETIC — NOT A MEASUREMENT'],
  };
}

function vOrStub(forceStub: boolean, v: Verdict): Verdict {
  return forceStub ? 'STUB' : v;
}

function analyze(base: BaselineResult, cur: ConcurrentResult, forceStub: boolean): Row[] {
  const rows: Row[] = [];
  const bTtft = base.summary.ttft_ms;
  const bTok = base.summary.tok_per_s.p50;
  const cAll = cur.chat.ttft_ms.all;
  const cTok = cur.chat.tok_per_s.p50;
  const d50 = relDelta(bTtft.p50, cAll.p50);
  const dTok = relDelta(bTok, cTok);
  const chatErrBase = 1 - base.summary.n_complete / base.summary.n_requested;
  const chatErrCur = cur.chat.n_requested === 0 ? null : cur.chat.n_error / cur.chat.n_requested;

  rows.push({
    id: '§4.1.1',
    metric: 'TTFT p50 change vs baseline',
    baseline: fmtNum(bTtft.p50, 0) + ' ms',
    current: fmtNum(cAll.p50, 0) + ' ms',
    delta: fmtPct(d50),
    gate: '|Δ| ≤ 10%',
    verdict: vOrStub(forceStub, d50 == null ? 'NA' : Math.abs(d50) <= 0.10 ? 'PASS' : 'FAIL'),
  });
  rows.push({
    id: '§4.1.3',
    metric: 'tok/s p50 change vs baseline',
    baseline: fmtNum(bTok, 4),
    current: fmtNum(cTok, 4),
    delta: fmtPct(dTok),
    gate: '|Δ| ≤ 10%',
    verdict: vOrStub(forceStub, dTok == null ? 'NA' : Math.abs(dTok) <= 0.10 ? 'PASS' : 'FAIL'),
  });

  const ovN = cur.chat.n_overlapped;
  const ovP95 = cur.chat.ttft_ms.overlapped.p95;
  const ovP95x = cur.chat.ttft_ms.overlapped.p95_excl_max;
  const dP95 = relDelta(bTtft.p95, ovP95);
  const dP95x = relDelta(bTtft.p95, ovP95x);
  const ovVerdict: Verdict = ovN < 5 ? 'INSUFFICIENT_N' : dP95 == null ? 'NA' : Math.abs(dP95) <= 0.20 ? 'PASS' : 'FAIL';
  rows.push({
    id: '§4.1.2 / §4.4.5',
    metric: `overlapped TTFT p95 (n_overlapped=${ovN}); raw-p95 and max-excluded p95 side-by-side (transparency, not a relax)`,
    baseline: `p95=${fmtNum(bTtft.p95, 0)} ms`,
    current: `raw-p95=${fmtNum(ovP95, 0)} ms; excl-max-p95=${fmtNum(ovP95x, 0)} ms`,
    delta: `raw ${fmtPct(dP95)}; excl-max ${fmtPct(dP95x)}`,
    gate: '|Δ raw-p95| ≤ 20% if n_overlapped≥5 else 이번 실행 측정 불가',
    verdict: vOrStub(forceStub, ovVerdict),
  });

  const errDelta = chatErrCur == null ? null : chatErrCur - chatErrBase;
  rows.push({
    id: '§4.1.4',
    metric: 'chat error-rate delta',
    baseline: fmtPct(chatErrBase),
    current: fmtPct(chatErrCur),
    delta: errDelta == null ? 'NA' : fmtPct(errDelta),
    gate: 'increase = 0',
    verdict: vOrStub(forceStub, errDelta == null ? 'NA' : errDelta <= 0 ? 'PASS' : 'FAIL'),
  });

  rows.push({
    id: '§4.3.1',
    metric: 'image success rate (same N=10 load+evidence)',
    baseline: 'NA',
    current: fmtPct(cur.image.success_rate) + ` (${cur.image.n_ok}/${cur.image.n_requested})`,
    delta: 'NA',
    gate: '≥ 95%',
    verdict: vOrStub(forceStub, cur.image.n_requested === 0 ? 'NA' : cur.image.success_rate >= 0.95 ? 'PASS' : 'FAIL'),
  });
  rows.push({
    id: '§4.2.6',
    metric: 'image arrival p95',
    baseline: 'NA',
    current: fmtNum(cur.image.latency_ms.p95, 0) + ' ms',
    delta: 'NA',
    gate: '≤ 30000 ms',
    verdict: vOrStub(
      forceStub,
      cur.image.latency_ms.p95 == null ? 'NA' : cur.image.latency_ms.p95 <= 30_000 ? 'PASS' : 'FAIL',
    ),
  });

  rows.push({
    id: '§4.3.2',
    metric: 'timeout does not affect chat (observation only, not fault injection)',
    baseline: 'NA',
    current: 'observe failed/slow image vs same-window chat TTFT',
    delta: 'NA',
    gate: 'correlation only',
    verdict: vOrStub(forceStub, 'NA'),
  });

  rows.push({
    id: '§4.4.1',
    metric: 'swap used delta (sysctl vm.swapusage)',
    baseline: '0 expected',
    current: cur.memory.swap_delta_bytes == null ? 'NA (unparsed)' : String(cur.memory.swap_delta_bytes) + ' B',
    delta: 'NA',
    gate: 'no increase',
    verdict: vOrStub(
      forceStub,
      cur.memory.swap_delta_bytes == null ? 'NA' : cur.memory.swap_delta_bytes <= 0 ? 'PASS' : 'FAIL',
    ),
  });
  const lastImageEnd = cur.image.rows.length ? Math.max(...cur.image.rows.map((r) => r.t_end)) : null;
  const completeChat = cur.chat.rows.filter((r) => r.status === 'complete' && r.ttft_ms != null);
  const postImageChat = lastImageEnd == null ? [] : completeChat.filter((r) => r.t_sent > lastImageEnd!);
  const postImageTtft = percentiles(postImageChat.map((r) => r.ttft_ms!));
  const dColdStart = relDelta(bTtft.p50, postImageTtft.p50);
  rows.push({
    id: '§4.4.3',
    metric: `TTFT cold-start after last image job ends (n_post_image=${postImageChat.length}); no explicit numeric gate in prereg, judged qualitatively in REPORT.md`,
    baseline: `p50=${fmtNum(bTtft.p50, 0)} ms`,
    current: postImageChat.length === 0 ? 'no chat request occurred after the last image job — not measurable this run' : `post-image TTFT p50=${fmtNum(postImageTtft.p50, 0)} ms (raw ${JSON.stringify(postImageTtft.raw)})`,
    delta: postImageChat.length === 0 ? 'NA' : fmtPct(dColdStart),
    gate: 'qualitative — no cold-start spike vs baseline (interpret in REPORT.md, like §4.4.4)',
    verdict: vOrStub(forceStub, 'NA'),
  });

  rows.push({
    id: '§4.4.2',
    metric: 'Gemma PID stable (pgrep pattern, not hardcoded name)',
    baseline: String(cur.memory.pid_before),
    current: String(cur.memory.pid_after),
    delta: String(cur.memory.pid_stable),
    gate: 'same PID',
    verdict: vOrStub(forceStub, cur.memory.pid_stable == null ? 'NA' : cur.memory.pid_stable ? 'PASS' : 'FAIL'),
  });
  rows.push({
    id: '§4.4.4',
    metric: 'RSS reclaim (after - before)',
    baseline: 'NA',
    current: cur.memory.rss_delta_kb == null ? 'NA' : `${cur.memory.rss_delta_kb} kB`,
    delta: 'NA',
    gate: 'reclaim after image load (interpret in REPORT.md)',
    verdict: vOrStub(forceStub, cur.memory.rss_delta_kb == null ? 'NA' : 'NA'),
  });

  const deferred = [
    ['§4.2-1', 'accept ≤500ms'],
    ['§4.2-3', 'status poll UX'],
    ['§4.2-4', 'retry UX'],
    ['§4.2-2', '0-job blocking'],
    ['§4.3-4', 'double-click guard'],
    ['§4.3-5', 'static store copy'],
  ] as const;
  for (const [id, metric] of deferred) {
    rows.push({
      id,
      metric,
      baseline: 'NA',
      current: 'deferred — 사전등록 §0-3 스코핑 참조',
      delta: 'NA',
      gate: 'not measurable by raw Draw Things API / this bench does not edit apps/server',
      verdict: 'DEFERRED',
    });
  }
  rows.push({
    id: '§4.2-5',
    metric: 'refresh recovery',
    baseline: 'NA',
    current: '참고, 판정 무관 (prereg §0-3) — GenerationQueue 선례. 이 벤치가 재검증한다고 재주장하지 않음',
    delta: 'NA',
    gate: 'out of verdict',
    verdict: 'DEFERRED',
  });
  rows.push({
    id: '§4.3-3',
    metric: 'worker offline fast-fail',
    baseline: 'NA',
    current: 'run-worker-offline.ts only (opt-in, destructive; not default flow)',
    delta: 'NA',
    gate: 'separate script',
    verdict: 'NA',
  });

  return rows;
}

function mdTable(rows: Row[]): string {
  const head = '| id | metric | baseline | current | delta | gate | verdict |';
  const sep = '|---|---|---|---|---|---|---|';
  const body = rows.map((r) => `| ${r.id} | ${r.metric.replace(/\|/g, '/')} | ${r.baseline} | ${r.current} | ${r.delta} | ${r.gate} | ${r.verdict} |`);
  return [head, sep, ...body].join('\n');
}

function main() {
  const basePath = arg('--baseline');
  if (!basePath) {
    console.error('usage: analyze.ts --baseline results/chat-baseline-*.json [--concurrent results/concurrent-*.json] [--dry-run]');
    process.exit(2);
  }
  const base = JSON.parse(readFileSync(basePath, 'utf8')) as BaselineResult;
  const dry = flag('--dry-run');
  const concPath = arg('--concurrent');
  let cur: ConcurrentResult;
  let forceStub = dry;
  if (dry && !concPath) {
    cur = syntheticConcurrent(base);
    forceStub = true;
  } else if (concPath) {
    cur = JSON.parse(readFileSync(concPath, 'utf8')) as ConcurrentResult;
    if (cur.dryrun) forceStub = true;
  } else {
    console.error('need --concurrent PATH or --dry-run');
    process.exit(2);
  }

  const rows = analyze(base, cur, forceStub);
  const lines = [
    '## sketchBench concurrent analyze',
    forceStub ? '**DRY_RUN_SYNTHETIC / dryrun:true — NOT A MEASUREMENT. Verdict column forced STUB (except DEFERRED/NA structural rows).**' : 'live join (Task 4 interpretation still belongs in REPORT.md)',
    `baseline: ${basePath}`,
    `concurrent: ${concPath ?? '(synthetic --dry-run)'}`,
    `baseline n_complete=${base.summary.n_complete}/${base.summary.n_requested} TTFT p50=${base.summary.ttft_ms.p50} p95=${base.summary.ttft_ms.p95} tok/s p50=${base.summary.tok_per_s.p50}`,
    `concurrent n_complete=${cur.chat.n_complete}/${cur.chat.n_requested} n_overlapped=${cur.chat.n_overlapped} image ${cur.image.n_ok}/${cur.image.n_requested}`,
    `notes: ${(cur.notes ?? []).join(' | ') || '(none)'}`,
    '',
    mdTable(rows),
    '',
    'Baseline p95 side-note: Task 2 N=20 p95 estimator lands on the max (5527). analyze reports raw-p95 and max-excluded p95; this is not a post-hoc gate relax (§5).',
  ];
  console.log(lines.join('\n'));
}

main();
