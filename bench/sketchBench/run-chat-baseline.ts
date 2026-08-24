/**
 * P4 sketchBench Task 2: 채팅 baseline (이미지 생성 미도입 상태).
 * 사전등록 §7: N=20 격리 요청, TTFT p50/p95, tok/s p50.
 * 서버가 이미 각 생성마다 generation_log(ttft_ms/total_ms/completion_tokens)를 기록하므로
 * SSE 직접 파싱 불필요 — 격리 대화에 N회 순차 발화 후 그 테이블만 조회한다.
 * 실행: npx tsx bench/sketchBench/run-chat-baseline.ts
 */
import Database from 'better-sqlite3';

const HOST = 'http://localhost:8787';
const HEADER = { 'Tailscale-User-Login': 'manofin@github' };
const CHARACTER_ID = 'a5073af0-14b3-4c3f-8750-04d76b547504'; // 임포트테스트 (실제 캐릭터 아님)
const N = 20;
const DB_PATH = '/home/hermes/rpchat/data/rpchat.db';

const LINES = [
  '문을 열고 안으로 들어선다', '주변을 천천히 둘러본다', '조용히 숨을 고른다',
  '창밖을 바라본다', '손에 든 물건을 살핀다', '발걸음을 옮긴다',
  '깊게 숨을 들이쉰다', '고개를 돌려 반응을 본다', '한 걸음 다가선다',
  '잠시 멈춰 생각한다', '주머니를 뒤진다', '의자에 앉는다',
  '벽에 기댄다', '작게 웃는다', '고개를 끄덕인다',
  '눈을 감았다 뜬다', '팔짱을 낀다', '뒤로 물러난다',
  '손을 내민다', '조용히 지켜본다',
];

async function main() {
  // 1) 격리 대화 생성
  const createRes = await fetch(`${HOST}/api/conversations`, {
    method: 'POST',
    headers: { ...HEADER, 'Content-Type': 'application/json' },
    body: JSON.stringify({ characterId: CHARACTER_ID, mode: 'chat', title: '[TEST-sketchbench-task2]' }),
  });
  const conv = await createRes.json() as { id: string };
  const convId = conv.id;
  console.error('conv created', convId);

  // 2) N회 순차 발화 (curl과 동일하게 fetch로 스트림 끝까지 소비만, body 파싱 불필요)
  for (let i = 0; i < N; i++) {
    const t0 = Date.now();
    const res = await fetch(`${HOST}/api/conversations/${convId}/messages`, {
      method: 'POST',
      headers: { ...HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: LINES[i % LINES.length] }),
    });
    // 스트림 끝까지 소비(연결 종료 대기) — 내용은 버림, 서버가 generation_log에 정확히 기록.
    const reader = res.body?.getReader();
    if (reader) { while (!(await reader.read()).done) {/* drain */} }
    console.error(`req ${i + 1}/${N} done in ${Date.now() - t0}ms (wall clock, not TTFT)`);
  }

  // 3) generation_log 조회
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare(
    `SELECT ttft_ms, total_ms, completion_tokens, status FROM generation_log WHERE conversation_id = ? ORDER BY created_at ASC`,
  ).all(convId) as Array<{ ttft_ms: number | null; total_ms: number | null; completion_tokens: number | null; status: string }>;
  db.close();

  const ok = rows.filter((r) => r.status === 'complete' && r.ttft_ms != null);
  const ttfts = ok.map((r) => r.ttft_ms!).sort((a, b) => a - b);
  const toksPerSec = ok
    .filter((r) => r.completion_tokens && r.total_ms)
    .map((r) => (r.completion_tokens! / (r.total_ms! / 1000)))
    .sort((a, b) => a - b);

  function pct(arr: number[], p: number): number | null {
    if (arr.length === 0) return null;
    const idx = Math.min(arr.length - 1, Math.floor((p / 100) * arr.length));
    return arr[idx];
  }

  const summary = {
    n_requested: N,
    n_logged: rows.length,
    n_complete: ok.length,
    ttft_ms: { p50: pct(ttfts, 50), p95: pct(ttfts, 95), raw: ttfts },
    tok_per_s: { p50: pct(toksPerSec, 50), raw: toksPerSec },
    statuses: rows.map((r) => r.status),
  };

  console.log(JSON.stringify({ convId, summary }, null, 2));

  // 4) 결과 저장
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = new URL('./results/', import.meta.url).pathname;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `chat-baseline-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ run: 'run-chat-baseline', convId, rows, summary }, null, 2));
  console.error('saved', file);

  // 5) 정화: 격리 대화 삭제 + generation_log (FK cascade 없음, 명시 삭제 필요)
  await fetch(`${HOST}/api/conversations/${convId}`, { method: 'DELETE', headers: HEADER });
  const db2 = new Database(DB_PATH);
  db2.prepare('DELETE FROM generation_log WHERE conversation_id = ?').run(convId);
  db2.close();
  console.error('cleaned up', convId);
}

main().catch((e) => { console.error(e); process.exit(1); });
