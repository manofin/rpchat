/**
 * P3-v2 Task 1 — C1 (H2-relative) 단독 실행. §5-1 트리: C1만 먼저, PASS 아니면 즉시 종료.
 * 게이트: cos(문장, entry 본문) >= percentile_95(배경분포, 그 entry 기준) AND keyword_hit
 *   (keyword 로직은 loreEntryActive 그대로, §2 대조군 수정 금지 준수)
 * 퍼센타일은 entry별 계산(entry마다 임베딩 공간상 기저 유사도 스케일이 다를 수 있어
 * 전역 pooled 컷보다 entry별 컷이 "모델별 스케일 문제"를 entry 단위까지 일관되게 해소함
 * — 이 설계는 실행 전, case 결과를 보기 전에 고정한다).
 * v1(run-lore.ts) 무수정, v1 SNAPSHOT을 이 파일에 새로 복제(같은 sha256 고정값).
 * 실행: npx tsx bench/embeddingBench/run-lore-v2.ts > results/lore-v2-c1-<id>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { loreEntryActive } from '../../apps/server/src/prompt/loreMatch.ts';
import { getEngine, cosine } from './engine.ts';

type LoreCase = { id: string; entryId: string; text: string; label: 'must_fire' | 'must_not_fire' | 'ambiguous' };
type SnapshotEntry = { id: string; title: string; keywords: string[]; secondary_keys: string[]; always_on: number; content: string };

// snapshot: run-lore.ts(v1)와 동일 값을 그대로 복제 — sha256=c35e103d... (lore-v1.json _meta 확인)
const SNAPSHOT: SnapshotEntry[] = [
  { id: '1870f500-673f-4706-ba3c-15ec5a7238bc', title: '기록보관소', keywords: ['도서관', '기록보관소', '서가', '열람실', '보관소'], secondary_keys: [], always_on: 0, content: '시 외곽의 3층짜리 석조 건물. 공식 기록뿐 아니라 시민들이 기증한 일기, 편지, 사진이 보관되어 있다. 지하 서고는 서리만 출입할 수 있다. 밤에는 서리 혼자 근무한다.' },
  { id: '1be5ac19-0932-418c-b8e6-1ba6f74a3196', title: '만년필', keywords: ['만년필', '펜', '잉크'], secondary_keys: [], always_on: 0, content: '서리가 늘 지니는 낡은 만년필. 전임 사서에게 물려받은 것으로, 그녀가 유일하게 개인적인 애착을 드러내는 물건이다.' },
  { id: '6bce220c-5363-4d68-b1d6-878a45e60db3', title: '항목1', keywords: ['키'], secondary_keys: [], always_on: 0, content: '로어본문' },
  { id: '7b60162c-bee3-4e66-bb7e-6e9249272dc5', title: '협곡과 산맥', keywords: ['협곡', '산맥', '다리', '여울', '절벽'], secondary_keys: [], always_on: 0, content: '국경을 가르는 거대한 산맥. 오래된 돌다리들이 곳곳에 있지만 대부분 낡아 무너지고 있다. 밤에는 포식자와 산적이 출몰한다. 상류로 가면 건널 수 있는 여울이 있다.' },
  { id: '810e7ed3-31a7-4b9a-9038-bcaf44e4b5f5', title: '쫓아오는 것', keywords: ['쫓', '추격', '소리', '포식자', '그것'], secondary_keys: [], always_on: 0, content: '정체가 불분명한 추격자. 카이도 그 실체를 확실히 알지 못한다. 어둠 속에서 빠르게 움직이며, 소리로만 위치를 가늠할 수 있다.' },
];
const SNAPSHOT_SHA = 'c35e103de58dd62330b516faf290e5da10969fd44d8a8ba28453561a68bce1af';
const ALPHA = 0.95; // §0-1 확정값, 실행 전 고정

function keywordHit(entry: SnapshotEntry, text: string): boolean {
  return loreEntryActive({
    always_on: entry.always_on,
    keywords: entry.keywords,
    secondary_keys: entry.secondary_keys,
    selective: 0,
    scanText: text.toLowerCase(),
  });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function summarize(rows: Array<{ id: string; label: string; fired: boolean }>) {
  const mf = rows.filter((r) => r.label === 'must_fire');
  const mnf = rows.filter((r) => r.label === 'must_not_fire');
  return {
    must_fire_recall: `${mf.filter((r) => r.fired).length}/${mf.length}`,
    false_triggers: mnf.filter((r) => r.fired).length,
    false_trigger_ids: mnf.filter((r) => r.fired).map((r) => r.id),
  };
}

async function main() {
  const t0 = Date.now();
  const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/lore-v1.json', import.meta.url), 'utf8'));
  const cases: LoreCase[] = fixtures.cases;
  if (fixtures._meta.lore_snapshot_sha !== SNAPSHOT_SHA) {
    console.error('SNAPSHOT SHA MISMATCH — abort, do not proceed (엔진 재현 실패 분기)');
    process.exit(1);
  }

  const bg = JSON.parse(fs.readFileSync(new URL('./fixtures/background-corpus-v2.json', import.meta.url), 'utf8'));
  const bgSentences: string[] = bg.background_sentences;
  if (bgSentences.length < 100) {
    console.error(`배경 코퍼스 N=${bgSentences.length} < 100 — §4-4 기준 미달, abort`);
    process.exit(1);
  }

  const realEntries = SNAPSHOT.filter((e) => e.title !== '항목1'); // v1과 동일하게 placeholder 제외

  const eng = getEngine('H2');

  // entry 본문(passage) 임베딩 — real entries만
  const entryVecs = new Map<string, number[]>();
  for (const e of realEntries) {
    const v = await eng.embed([e.content], 'passage');
    entryVecs.set(e.id, v[0]);
  }

  // 배경 코퍼스(query) 임베딩 — 시간 측정 대상(§4-5: 100문장 encode <=30s)
  const encStart = Date.now();
  const bgVecs: number[][] = [];
  for (const s of bgSentences) {
    const v = await eng.embed([s], 'query');
    bgVecs.push(v[0]);
  }
  const encMs = Date.now() - encStart;

  // entry별 배경 코사인 분포 → 95th percentile 컷
  const perEntryThreshold = new Map<string, number>();
  const perEntryBgDist = new Map<string, number[]>();
  for (const e of realEntries) {
    const dist = bgVecs.map((v) => cosine(v, entryVecs.get(e.id)!)).sort((a, b) => a - b);
    perEntryBgDist.set(e.id, dist);
    perEntryThreshold.set(e.id, percentile(dist, ALPHA));
  }

  // case 문장(query) 임베딩
  const sentVecs = new Map<string, number[]>();
  for (const c of cases) {
    const v = await eng.embed([c.text], 'query');
    sentVecs.set(c.id, v[0]);
  }

  const rows = cases.map((c) => {
    const entry = realEntries.find((e) => e.id === c.entryId);
    if (!entry) {
      // 이 lore-v1.json 케이스셋엔 항목1을 가리키는 case가 없음(v1 데이터 확인) — 방어적 처리
      return { id: c.id, label: c.label, cos: null, threshold: null, keyword_hit: false, fired: false, note: 'entryId not in realEntries' };
    }
    const cos = cosine(sentVecs.get(c.id)!, entryVecs.get(entry.id)!);
    const th = perEntryThreshold.get(entry.id)!;
    const kw = keywordHit(entry, c.text);
    const fired = cos >= th && kw;
    // top1 across real entries (ambiguous 정확도용, 게이트와 무관)
    let bestId = '', bestCos = -2;
    for (const e of realEntries) {
      const cv = cosine(sentVecs.get(c.id)!, entryVecs.get(e.id)!);
      if (cv > bestCos) { bestCos = cv; bestId = e.id; }
    }
    return {
      id: c.id, label: c.label,
      cos: Number(cos.toFixed(4)), threshold: Number(th.toFixed(4)),
      percentile_rank_pct: Number((100 * perEntryBgDist.get(entry.id)!.filter((x) => x <= cos).length / perEntryBgDist.get(entry.id)!.length).toFixed(1)),
      keyword_hit: kw, fired,
      top1_entry: bestId, top1_cos: Number(bestCos.toFixed(4)),
    };
  });

  const gateSummary = summarize(rows as any);
  const ambiguousRows = rows.filter((r) => r.label === 'ambiguous') as Array<{ id: string; top1_entry: string }>;
  const ambigCorrect = cases
    .filter((c) => c.label === 'ambiguous')
    .filter((c) => {
      const r = ambiguousRows.find((rr) => rr.id === c.id);
      return r && r.top1_entry === c.entryId;
    }).length;

  const rssMB = Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1));
  const totalMs = Date.now() - t0;

  const criteria = {
    'must_fire_recall_10/10': gateSummary.must_fire_recall === '10/10',
    'false_trigger_0/10': gateSummary.false_triggers === 0,
    'ambiguous_top1_>=3/5': ambigCorrect >= 3,
    'encode_100_bg_sentences_<=30s': encMs <= 30000,
    'idle_rss_<=8GB': rssMB <= 8192,
  };
  const allPass = Object.values(criteria).every(Boolean);

  const out = {
    run: 'run-lore-v2-C1',
    candidate: 'C1 (H2-relative)',
    engine: 'H2 multilingual-e5-small',
    alpha: ALPHA,
    background_corpus: { source: 'bench/longRp/beats-v1.json via background-corpus-v2.json', n: bgSentences.length, corpus_sha256: bg._meta.corpus_sha256 },
    snapshot_sha256_of_lines: SNAPSHOT_SHA,
    per_entry_threshold: Object.fromEntries([...perEntryThreshold.entries()].map(([k, v]) => [k, Number(v.toFixed(4))])),
    rows,
    gate_summary: gateSummary,
    ambiguous_top1_correct: `${ambigCorrect}/5`,
    perf: { encode_100_bg_ms: encMs, idle_rss_mb: rssMB, total_ms: totalMs },
    criteria,
    verdict: allPass ? 'PASS' : 'FAIL',
  };

  const dir = new URL('./results/', import.meta.url).pathname;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `lore-v2-c1-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ saved: file, gate_summary: gateSummary, ambiguous_top1_correct: out.ambiguous_top1_correct, criteria, verdict: out.verdict, perf: out.perf }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
