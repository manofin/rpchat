/**
 * Task 5: 성능 벤치 (참고자료 전용 — 판정 불영향).
 * 100문장 고정 워크로드: 픽스처 전체(25+20×2문장=65) + 일반 한국어 문장 35.
 * 측정: 인코딩 ms, peak RSS(MB), Gemma :8083 health 응답시간 idle vs busy.
 * 실행: npx tsx bench/embeddingBench/run-perf.ts --engine all
 */
import fs from 'node:fs';
import path from 'node:path';
import { getEngine } from './engine.ts';

const GENERAL = [
  '오늘 아침에 커피를 마셨다', '지하철이 5분 늦게 도착했다', '책상 위에 종이가 쌓여 있다', '창밖에 비가 내리고 있다',
  '점심으로 김치찌개를 먹었다', '회의가 오후 3시에 시작된다', '새 신발을 샀다', '주말에 등산을 갈 계획이다',
  '고양이가 소파에서 자고 있다', '휴대폰 배터리가 부족하다', '어제 친구와 영화를 봤다', '청소기를 돌렸다',
  '편의점에서 물을 사 왔다', '노트북을 최신 모델로 바꿨다', '저녁 메뉴를 고민한다', '버스 정류장에서 기다렸다',
  '음악을 크게 틀었다', '우산을 집에 두고 왔다', '아침 일찍 출근했다', '택배가 도착했다',
  '설거지를 아직 안 했다', '운동을 시작하기로 했다', '냉장고에 우유가 없다', '창문을 활짝 열었다',
  '도서관에서 공부했다', '커피숍에서 작업했다', '빨래를 널었다', '쓰레기를 버렸다',
  '알람을 맞추는 걸 잊었다', '지갑을 두고 나왔다', '약속 시간에 늦었다', '비 오는 날엔 차가 밀린다',
  '계단을 걸어 올라갔다', '엘리베이터를 탔다', '신문을 대충 훑었다',
];

function rssMB(): number {
  return Math.round(process.memoryUsage.rss() / 1024 / 1024);
}

async function healthCheck(): Promise<number | null> {
  try {
    const t0 = Date.now();
    const res = await fetch('http://127.0.0.1:8083/health', { signal: AbortSignal.timeout(3000) });
    const ms = Date.now() - t0;
    return res.ok ? ms : null;
  } catch {
    return null;
  }
}

async function main() {
  const which = (process.argv[process.argv.indexOf('--engine') + 1] ?? 'all') as 'H1' | 'H2' | 'all';
  const lore = JSON.parse(fs.readFileSync(new URL('./fixtures/lore-v1.json', import.meta.url), 'utf8'));
  const mem = JSON.parse(fs.readFileSync(new URL('./fixtures/memory-v1.json', import.meta.url), 'utf8'));
  const texts: string[] = [...lore.cases.map((c: any) => c.text), ...mem.pairs.flatMap((p: any) => [p.cand, p.existing]), ...GENERAL];
  if (texts.length !== 100) throw new Error(`workload n=${texts.length}, expected 100`);

  const engines = which === 'all' ? (['H1', 'H2'] as const) : [which];
  const out: any = { run: 'run-perf', note: '참고자료 전용 — 판정 불영향.', workload_n: texts.length, gemma_health_idle_ms: await healthCheck(), engines: {} };

  for (const name of engines) {
    const eng = getEngine(name);
    // 워밍업(모델 로드) 후 측정
    await eng.embed(['워밍업']);
    const rssIdle = rssMB();
    const t0 = Date.now();
    await eng.embed(texts);
    const elapsedMs = Date.now() - t0;
    const rssPeak = rssMB(); // 근사: 프로세스 RSS (동일 프로세스 내 두 엔진 누적 주의 — 개별 해석 시 단독 실행 권장)
    const busyDuring: number[] = [];
    const half = eng.embed(texts.slice(0, 50)).then(async () => { busyDuring.push(await healthCheck() ?? -1); });
    await half;
    console.error(`${name}: ${elapsedMs}ms, rss_idle=${rssIdle}MB, rss_after=${rssPeak}MB, health_during_busy=${JSON.stringify(busyDuring)}`);
    out.engines[name] = {
      encode_100_ms: elapsedMs,
      per_sentence_ms: Number((elapsedMs / 100).toFixed(2)),
      rss_idle_mb: rssIdle,
      rss_after_mb: rssPeak,
      gemma_health_busy_ms: busyDuring.filter((x) => x >= 0),
    };
  }

  const dir = new URL('./results/', import.meta.url).pathname;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `perf-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
