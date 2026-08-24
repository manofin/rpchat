/**
 * Mac memory / swap sampler (§4.4, §7).
 * Commands: sysctl vm.swapusage (primary), vm_stat (aux), pgrep + ps RSS.
 * PID pattern comes from CLI/env — do not hardcode a model name.
 * Missing/unparseable fields stay null (MEASUREMENT-FAKE-ZERO).
 */
import { execFileSync } from 'node:child_process';
import type { CmdCapture, MemSnapshot } from './types.ts';

function capture(cmd: string, args: string[]): CmdCapture {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { cmd: [cmd, ...args].join(' '), stdout: stdout ?? '', stderr: '', code: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; status?: number; message?: string };
    return {
      cmd: [cmd, ...args].join(' '),
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? err.message ?? ''),
      code: typeof err.status === 'number' ? err.status : null,
    };
  }
}

const UNIT: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** Parse `sysctl vm.swapusage` (Darwin). Returns nulls if the text is not that format. */
export function parseSwapUsage(raw: string): { used: number | null; total: number | null } {
  const usedM = raw.match(/used\s*=\s*([0-9.]+)\s*([KMGT])/i);
  const totalM = raw.match(/total\s*=\s*([0-9.]+)\s*([KMGT])/i);
  const toBytes = (m: RegExpMatchArray | null): number | null => {
    if (!m) return null;
    const n = Number(m[1]);
    const u = UNIT[m[2].toUpperCase()];
    if (!Number.isFinite(n) || !u) return null;
    return n * u;
  };
  return { used: toBytes(usedM), total: toBytes(totalM) };
}

export function parseVmStat(raw: string): { pageSize: number | null; counts: Record<string, number> } {
  const pageM = raw.match(/page size of\s+(\d+)\s+bytes/i);
  const pageSize = pageM ? Number(pageM[1]) : null;
  const counts: Record<string, number> = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z0-9 ]+?):\s+([0-9]+)/);
    if (!m) continue;
    const key = m[1].trim().replace(/\s+/g, '_').toLowerCase();
    counts[key] = Number(m[2]);
  }
  return { pageSize: pageSize != null && Number.isFinite(pageSize) ? pageSize : null, counts };
}

export function parsePgrep(raw: string): number[] {
  return raw
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export function snapshot(label: string, pgrepPattern: string | null): MemSnapshot {
  const swapCap = capture('sysctl', ['vm.swapusage']);
  const vmCap = capture('vm_stat', []);
  const pgrepCap = pgrepPattern
    ? capture('pgrep', ['-f', pgrepPattern])
    : { cmd: '(skipped — no pgrep pattern)', stdout: '', stderr: '', code: null };
  const swap = parseSwapUsage(swapCap.stdout);
  const vm = parseVmStat(vmCap.stdout);
  const pids = pgrepPattern ? parsePgrep(pgrepCap.stdout) : [];
  const pid = pids.length === 1 ? pids[0] : pids.length > 1 ? pids[0] : null;
  let psCap: CmdCapture | null = null;
  let rss_kb: number | null = null;
  if (pid != null) {
    psCap = capture('ps', ['-o', 'pid=,rss=', '-p', String(pid)]);
    const m = psCap.stdout.trim().match(/(\d+)\s+(\d+)/);
    if (m) rss_kb = Number(m[2]);
  }
  return {
    label,
    t: Date.now(),
    swap_used_bytes: swap.used,
    swap_total_bytes: swap.total,
    swap_raw: swapCap.stdout.trim(),
    vm_stat: vm.counts,
    vm_stat_page_size: vm.pageSize,
    pid,
    pids,
    rss_kb,
    commands: { swap: swapCap, vm_stat: vmCap, pgrep: pgrepCap, ps: psCap },
  };
}

export function startContinuous(pgrepPattern: string | null, intervalMs: number): { samples: MemSnapshot[]; stop: () => MemSnapshot[] } {
  const samples: MemSnapshot[] = [];
  const tick = () => {
    samples.push(snapshot(`cont-${samples.length}`, pgrepPattern));
  };
  const handle = setInterval(tick, intervalMs);
  return {
    samples,
    stop: () => {
      clearInterval(handle);
      return samples;
    },
  };
}
