/**
 * ⚠️ OPT-IN / DESTRUCTIVE — §4.3-3 worker-offline.
 * 실행 전 Draw Things를 수동으로 중지할 것.
 * 기본 플로우(run-concurrent.ts)에 포함하지 않음. 채팅 루프 없음.
 * 이미지 1–2건만 보내 (a) 빠른 실패(명확한 에러)인지 (b) 무한 대기/타임아웃 없는지 확인.
 *
 *   DRAW_THINGS_BASE_URL=http://127.0.0.1:<port> npx tsx run-worker-offline.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateImage, requireDrawThingsBase } from './lib/drawThingsClient.ts';

const N = Number(process.argv.includes('--n') ? process.argv[process.argv.indexOf('--n') + 1] : 2);
if (!Number.isInteger(N) || N <= 0) {
  // Vacuous-truth trap: [].every(...) is true, so a bad/missing --n value would
  // otherwise silently produce 0 requests and report fast_fail_all:true as if verified.
  console.error(`--n must be a positive integer, got ${JSON.stringify(process.argv[process.argv.indexOf('--n') + 1])} (parsed ${N})`);
  process.exit(2);
}
const TIMEOUT_MS = Number(process.env.OFFLINE_TIMEOUT_MS ?? 5000);

async function main() {
  const base = requireDrawThingsBase();
  console.error('⚠️  run-worker-offline: Draw Things must already be STOPPED. base=', base, 'timeoutMs=', TIMEOUT_MS);
  const rows = [];
  for (let i = 0; i < N; i++) {
    const r = await generateImage({
      prompt: `sketchBench worker-offline ${i + 1}`,
      timeoutMs: TIMEOUT_MS,
    });
    rows.push({ i, ...r });
    console.error(JSON.stringify({ i, ok: r.ok, error: r.error, latency_ms: r.latency_ms, http_status: r.http_status }));
  }
  const fastFail = rows.every((r) => !r.ok && r.latency_ms < TIMEOUT_MS + 500);
  const hung = rows.some((r) => (r.error ?? '').toLowerCase().includes('timeout') || r.latency_ms >= TIMEOUT_MS);
  const out = {
    run: 'run-worker-offline',
    hostname: hostname(),
    base,
    timeout_ms: TIMEOUT_MS,
    rows,
    fast_fail_all: fastFail,
    any_timeout: hung,
    notes: [
      'opt-in destructive; chat loop not run',
      '§4.3-3 is worker failure handling, not resource contention',
    ],
  };
  const dir = fileURLToPath(new URL('./results/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `worker-offline-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.error('saved', file);
  console.log(JSON.stringify({ file, fast_fail_all: fastFail, any_timeout: hung }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
