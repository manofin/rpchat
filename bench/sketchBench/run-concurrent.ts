/**
 * Task 3 concurrent orchestrator. Intended to run on Mac Studio (mac-exec.sh).
 * Three loops, one process clock: chat N=20, image N=10 spaced, active poller.
 * TTFT is read from hermes generation_log via SSH (or --query-via local on hermes).
 * Does not edit apps/server. Does not claim §4 verdicts (that's analyze.ts + Task 4).
 */
import { spawnSync } from 'node:child_process';
import { hostname, platform } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startActivePoller, readActiveOnce } from './lib/activePoller.ts';
import { createIsolatedConv, deleteConv, runChatLoop, serveHeaders } from './lib/chatDriver.ts';
import { generateImage, requireDrawThingsBase, smokeOnce } from './lib/drawThingsClient.ts';
import { snapshot, startContinuous } from './lib/macMemSampler.ts';
import { compressActiveIntervals, intervalsOverlap, percentiles } from './lib/stats.ts';
import type { ChatRow, ConcurrentResult, ImageRow } from './lib/types.ts';

const DEFAULT_SERVE = 'https://hermes.tailf2217c.ts.net';
const REMOTE_QUERY = 'bench/sketchBench/lib/queryGenerationLog.ts';

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

function numArg(name: string, fallback: number): number {
  const v = arg(name);
  if (v == null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} not a number: ${v}`);
  return n;
}

type LogRow = {
  ttft_ms: number | null;
  total_ms: number | null;
  completion_tokens: number | null;
  status: string;
};

function queryLog(convId: string, mode: 'read' | 'delete', via: 'ssh' | 'local'): { rows?: LogRow[]; deleted?: number; raw: string } {
  const host = process.env.RPCHAT_SSH_HOST ?? 'rpchat';
  const remote = process.env.RPCHAT_REMOTE ?? '/home/hermes/rpchat/app';
  let cmd: string;
  let args: string[];
  if (via === 'local') {
    cmd = 'npx';
    args = ['tsx', join(fileURLToPath(new URL('.', import.meta.url)), 'lib/queryGenerationLog.ts'), '--conv', convId, '--mode', mode];
  } else {
    cmd = 'ssh';
    args = [
      host,
      `cd ${remote} && PATH=/home/hermes/.local/bin:$PATH npx tsx ${REMOTE_QUERY} --conv ${convId} --mode ${mode}`,
    ];
  }
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000 });
  const raw = (r.stdout || '') + (r.stderr ? `\nSTDERR:\n${r.stderr}` : '');
  if (r.status !== 0) {
    throw new Error(`queryGenerationLog ${mode} failed (code=${r.status}): ${raw}`);
  }
  const parsed = JSON.parse(r.stdout) as { rows?: LogRow[]; deleted?: number };
  return { ...parsed, raw: r.stdout };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function preflight(serve: string, headers: Record<string, string>): Promise<string[]> {
  const notes: string[] = [];
  const healthRes = await fetch(`${serve}/api/health`, { headers, signal: AbortSignal.timeout(10000) });
  const health = (await healthRes.json()) as {
    authMode?: string;
    model?: { ok?: boolean };
    ok?: boolean;
  };
  if (healthRes.status !== 200) throw new Error(`preflight health http ${healthRes.status}`);
  if (health.authMode !== 'tailscale') notes.push(`preflight authMode=${String(health.authMode)} (expected tailscale)`);
  if (!health.model?.ok) throw new Error(`preflight model.ok != true: ${JSON.stringify(health.model)}`);
  const active = await readActiveOnce(serve, headers);
  if (active.http_status !== 200) throw new Error(`preflight active http ${active.http_status}`);
  if (active.active.length !== 0 || active.queued !== 0) {
    throw new Error(`preflight contaminated traffic: active=${active.active.length} queued=${active.queued}`);
  }
  const smoke = await smokeOnce();
  if (!smoke.ok) throw new Error(`preflight Draw Things/stub smoke failed: ${smoke.error}`);
  notes.push('preflight health+active+image-smoke ok');
  return notes;
}

function attachOverlap(chat: ChatRow[], images: ImageRow[], intervals: Array<{ start: number; end: number }>): void {
  for (const c of chat) {
    const covering = intervals.filter((iv) => intervalsOverlap(c.t_sent, c.t_done, iv.start, iv.end));
    if (covering.length === 0) {
      c.poll_active_start = null;
      c.poll_active_end = null;
      c.overlapped_image = false;
      continue;
    }
    const start = Math.min(...covering.map((iv) => iv.start));
    const end = Math.max(...covering.map((iv) => iv.end));
    c.poll_active_start = start;
    c.poll_active_end = end;
    c.overlapped_image = images.some((im) => intervalsOverlap(start, end, im.t_start, im.t_end));
  }
}

async function main() {
  if (flag('--help')) {
    console.error(`run-concurrent.ts
  --serve URL                 default ${DEFAULT_SERVE}
  --n-chat N                  default 20
  --n-image N                 default 10
  --image-interval-ms N       default 4000
  --poll-ms N                 default 400
  --mem-interval-ms N         default 1500
  --gemma-pgrep PAT           or env GEMMA_PGREP (no hardcoded model name)
  --query-via ssh|local       default ssh
  --tag NAME                  optional; sets environment.tag and results/concurrent-NAME-<ended_at>.json
  --skip-preflight
  --skip-cleanup
  --help`);
    process.exit(0);
  }

  const serve = (arg('--serve', process.env.RPCHAT_BASE_URL ?? DEFAULT_SERVE) ?? DEFAULT_SERVE).replace(/\/$/, '');
  const nChat = numArg('--n-chat', 20);
  const nImage = numArg('--n-image', 10);
  const imageInterval = numArg('--image-interval-ms', 4000);
  const pollMs = numArg('--poll-ms', 400);
  const memInterval = numArg('--mem-interval-ms', 1500);
  const pgrep = arg('--gemma-pgrep', process.env.GEMMA_PGREP ?? '') || null;
  const queryVia = (arg('--query-via', 'ssh') === 'local' ? 'local' : 'ssh') as 'ssh' | 'local';
  const tagRaw = arg('--tag');
  const tag = tagRaw == null || tagRaw === '' ? undefined : tagRaw;
  if (tag != null && !/^[A-Za-z0-9._-]{1,64}$/.test(tag)) {
    throw new Error(`--tag must match [A-Za-z0-9._-]{1,64}, got ${JSON.stringify(tag)}`);
  }
  const headers = serveHeaders();
  const notes: string[] = [];
  const dtBase = requireDrawThingsBase();

  const started_at = Date.now();
  if (!flag('--skip-preflight')) {
    notes.push(...await preflight(serve, headers));
  } else {
    notes.push('preflight skipped');
  }

  const memBefore = snapshot('before', pgrep);
  const memCont = startContinuous(pgrep, memInterval);

  const convId = await createIsolatedConv(serve, '[TEST-sketchbench-task3-concurrent]', headers);
  notes.push(`conv ${convId}`);

  const poller = startActivePoller({ serveBase: serve, conversationId: convId, intervalMs: pollMs, headers });
  const imageRows: ImageRow[] = [];
  let chatPartial: Array<Pick<ChatRow, 'i' | 't_sent' | 't_done' | 'status'>> = [];

  const chatLoop = async () => {
    chatPartial = await runChatLoop({
      serveBase: serve,
      convId,
      n: nChat,
      headers,
      onTurn: (i, _s, _d, st) => console.error(`chat ${i + 1}/${nChat} http ${st}`),
    });
  };

  const imageLoop = async () => {
    for (let j = 0; j < nImage; j++) {
      if (j > 0) await sleep(imageInterval);
      console.error(`image ${j + 1}/${nImage} fire`);
      const r = await generateImage({ prompt: `sketchBench concurrent ${j + 1}/${nImage}` });
      imageRows.push({
        j,
        t_start: r.t_start,
        t_end: r.t_end,
        ok: r.ok,
        http_status: r.http_status,
        error: r.error,
        latency_ms: r.latency_ms,
      });
    }
  };

  await Promise.all([chatLoop(), imageLoop()]);
  const pollSamples = poller.stop();
  const continuous = memCont.stop();
  const memMid = snapshot('mid', pgrep);
  const memAfter = snapshot('after', pgrep);

  let logRows: LogRow[] = [];
  try {
    const q = queryLog(convId, 'read', queryVia);
    logRows = q.rows ?? [];
  } catch (e) {
    notes.push(`generation_log read failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const chatRows: ChatRow[] = chatPartial.map((c, idx) => {
    const log = logRows[idx];
    return {
      ...c,
      ttft_ms: log?.ttft_ms ?? null,
      total_ms: log?.total_ms ?? null,
      completion_tokens: log?.completion_tokens ?? null,
      status: log?.status ?? c.status,
      overlapped_image: false,
      poll_active_start: null,
      poll_active_end: null,
    };
  });
  if (logRows.length !== chatPartial.length) {
    notes.push(`generation_log n=${logRows.length} != chat n=${chatPartial.length}`);
  }

  const intervals = compressActiveIntervals(pollSamples);
  attachOverlap(chatRows, imageRows, intervals);

  const okChat = chatRows.filter((r) => r.status === 'complete' && r.ttft_ms != null);
  const overlapped = okChat.filter((r) => r.overlapped_image);
  const nonOv = okChat.filter((r) => !r.overlapped_image);
  const ttft = (rows: typeof okChat) => rows.map((r) => r.ttft_ms!).filter((n) => Number.isFinite(n));
  const toks = okChat
    .filter((r) => r.completion_tokens && r.total_ms)
    .map((r) => r.completion_tokens! / (r.total_ms! / 1000));

  if (overlapped.length < 5) {
    notes.push(`n_overlapped=${overlapped.length} < 5 — 이번 실행 측정 불가 (재간격 후 재실행; 사전등록 위반 아님)`);
  }

  const pidBefore = memBefore.pid;
  const pidAfter = memAfter.pid;
  const pid_stable = pidBefore != null && pidAfter != null ? pidBefore === pidAfter : null;
  if (pid_stable === false) notes.push(`PID changed ${pidBefore} -> ${pidAfter} (§4.4-2)`);
  if (pgrep == null) notes.push('GEMMA_PGREP/--gemma-pgrep unset; pid_stable is null');

  const rss_delta_kb =
    memAfter.rss_kb != null && memBefore.rss_kb != null ? memAfter.rss_kb - memBefore.rss_kb : null;
  const swap_delta_bytes =
    memAfter.swap_used_bytes != null && memBefore.swap_used_bytes != null
      ? memAfter.swap_used_bytes - memBefore.swap_used_bytes
      : null;

  if (!flag('--skip-cleanup')) {
    try {
      queryLog(convId, 'delete', queryVia);
    } catch (e) {
      notes.push(`generation_log delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      await deleteConv(serve, convId, headers);
      notes.push('cleaned conversation');
    } catch (e) {
      notes.push(`conversation delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    notes.push('cleanup skipped');
  }

  const ended_at = Date.now();
  const imgOk = imageRows.filter((r) => r.ok);
  const result: ConcurrentResult = {
    run: 'run-concurrent',
    started_at,
    ended_at,
    convId,
    chat: {
      rows: chatRows,
      n_requested: nChat,
      n_complete: okChat.length,
      n_error: nChat - okChat.length,
      n_overlapped: overlapped.length,
      ttft_ms: {
        all: percentiles(ttft(okChat)),
        overlapped: percentiles(ttft(overlapped)),
        non_overlapped: percentiles(ttft(nonOv)),
      },
      tok_per_s: percentiles(toks),
    },
    image: {
      rows: imageRows,
      n_requested: nImage,
      n_ok: imgOk.length,
      success_rate: nImage === 0 ? 0 : imgOk.length / nImage,
      latency_ms: percentiles(imageRows.map((r) => r.latency_ms)),
    },
    activePoll: { interval_ms: pollMs, samples: pollSamples, intervals },
    memory: {
      snapshots: [memBefore, memMid, memAfter],
      continuous,
      pid_before: pidBefore,
      pid_after: pidAfter,
      pid_stable,
      rss_delta_kb,
      swap_delta_bytes,
      pgrep_pattern: pgrep,
    },
    environment: {
      hostname: hostname(),
      platform: platform(),
      node: process.version,
      serve_base: serve,
      draw_things_base: dtBase,
      image_interval_ms: imageInterval,
      n_chat: nChat,
      n_image: nImage,
      ...(tag != null ? { tag } : {}),
    },
    notes,
  };

  const dir = fileURLToPath(new URL('./results/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, tag != null ? `concurrent-${tag}-${ended_at}.json` : `concurrent-${ended_at}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.error('saved', file);
  console.log(JSON.stringify({ file, convId, notes, n_overlapped: overlapped.length, image_ok: imgOk.length }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
