/**
 * Task 3: 로어 벤치. baseline(loreEntryActive 컴파일) vs H1 vs H2.
 * 게이트(raw): must_not_fire false-trigger 0/10 (H1·H2 공통, 판정컷 θ=0.70; 0.65/0.75는 참고).
 * 임베딩 게이트식(사전등록 §4-1): cos(문장, entry 본문) ≥ θ AND (keyword OR secondary OR always_on)
 * 실행: npx tsx bench/embeddingBench/run-lore.ts --engine all > results/lore-<id>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { loreEntryActive } from '../../apps/server/src/prompt/loreMatch.ts';
import { getEngine, cosine } from './engine.ts';

type LoreCase = { id: string; entryId: string; text: string; label: 'must_fire' | 'must_not_fire' | 'ambiguous' };
type SnapshotEntry = { id: string; title: string; keywords: string[]; secondary_keys: string[]; always_on: number; content: string };

// 스냅샷은 Task 1에서 고정한 것과 동일 (live DB 1회 읽기, sha256=c35e103d...)
const SNAPSHOT: SnapshotEntry[] = [
  { id: '1870f500-673f-4706-ba3c-15ec5a7238bc', title: '기록보관소', keywords: ['도서관', '기록보관소', '서가', '열람실', '보관소'], secondary_keys: [], always_on: 0, content: '시 외곽의 3층짜리 석조 건물. 공식 기록뿐 아니라 시민들이 기증한 일기, 편지, 사진이 보관되어 있다. 지하 서고는 서리만 출입할 수 있다. 밤에는 서리 혼자 근무한다.' },
  { id: '1be5ac19-0932-418c-b8e6-1ba6f74a3196', title: '만년필', keywords: ['만년필', '펜', '잉크'], secondary_keys: [], always_on: 0, content: '서리가 늘 지니는 낡은 만년필. 전임 사서에게 물려받은 것으로, 그녀가 유일하게 개인적인 애착을 드러내는 물건이다.' },
  { id: '6bce220c-5363-4d68-b1d6-878a45e60db3', title: '항목1', keywords: ['키'], secondary_keys: [], always_on: 0, content: '로어본문' },
  { id: '7b60162c-bee3-4e66-bb7e-6e9249272dc5', title: '협곡과 산맥', keywords: ['협곡', '산맥', '다리', '여울', '절벽'], secondary_keys: [], always_on: 0, content: '국경을 가르는 거대한 산맥. 오래된 돌다리들이 곳곳에 있지만 대부분 낡아 무너지고 있다. 밤에는 포식자와 산적이 출몰한다. 상류로 가면 건널 수 있는 여울이 있다.' },
  { id: '810e7ed3-31a7-4b9a-9038-bcaf44e4b5f5', title: '쫓아오는 것', keywords: ['쫓', '추격', '소리', '포식자', '그것'], secondary_keys: [], always_on: 0, content: '정체가 불분명한 추격자. 카이도 그 실체를 확실히 알지 못한다. 어둠 속에서 빠르게 움직이며, 소리로만 위치를 가늠할 수 있다.' },
];

const THETAS = [0.65, 0.70, 0.75];
const JUDGE_THETA = 0.70;

function keywordHit(entry: SnapshotEntry, text: string): boolean {
  return loreEntryActive({
    always_on: entry.always_on,
    keywords: entry.keywords,
    secondary_keys: entry.secondary_keys,
    selective: 0,
    scanText: text.toLowerCase(),
  });
}

async function main() {
  const which = (process.argv[process.argv.indexOf('--engine') + 1] ?? 'all') as 'H1' | 'H2' | 'all';
  const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/lore-v1.json', import.meta.url), 'utf8'));
  const cases: LoreCase[] = fixtures.cases;

  // ---- baseline (keyword only, live code) ----
  const baseRows = cases.map((c) => {
    const entry = SNAPSHOT.find((e) => e.id === c.entryId)!;
    const hit = entry.always_on === 1 || entry.keywords.some((k) => c.text.toLowerCase().includes(k.toLowerCase()));
    return { id: c.id, label: c.label, fired: hit };
  });
  const baseSummary = summarize(baseRows);
  console.error('BASELINE:', JSON.stringify(baseSummary));

  const engines = which === 'all' ? (['H1', 'H2'] as const) : [which];
  const out: any = { run: 'run-lore', thetas: THETAS, judge_theta: JUDGE_THETA, snapshot_sha256_of_lines: 'c35e103de58dd62330b516faf290e5da10969fd44d8a8ba28453561a68bce1af', baseline: baseRows, engines: {} };

  for (const name of engines) {
    const eng = getEngine(name);
    // 사전 임베딩: entry 본문(passage), 문장(query)
    const entryVecs = new Map<string, number[]>();
    for (const e of SNAPSHOT) {
      const v = await eng.embed([e.content], name === 'H2' ? 'passage' : undefined as any);
      entryVecs.set(e.id, v[0]);
    }
    const sentVecs = new Map<string, number[]>();
    for (const c of cases) {
      const v = await eng.embed([c.text], name === 'H2' ? 'query' : undefined as any);
      sentVecs.set(c.id, v[0]);
    }

    const rows = cases.map((c) => {
      const entry = SNAPSHOT.find((e) => e.id === c.entryId)!;
      const cos = cosine(sentVecs.get(c.id)!, entryVecs.get(c.entryId)!);
      const kw = keywordHit(entry, c.text);
      const perTheta: Record<string, boolean> = {};
      for (const th of THETAS) perTheta[String(th)] = cos >= th && kw;
      // top1 across all entries (ambiguous 측정용 — 게이트와 무관한 순수 의미유사도)
      let bestId = '', bestCos = -2;
      for (const e of SNAPSHOT) {
        if (e.title === '항목1') continue; // 플레이스홀더 엔트리
        const cv = cosine(sentVecs.get(c.id)!, entryVecs.get(e.id)!);
        if (cv > bestCos) { bestCos = cv; bestId = e.id; }
      }
      return { id: c.id, label: c.label, cos: Number(cos.toFixed(4)), keyword_hit: kw, fired_per_theta: perTheta, top1_entry: bestId, top1_cos: Number(bestCos.toFixed(4)) };
    });

    const summary: Record<string, any> = {};
    for (const th of THETAS) {
      const key = String(th);
      const fired = rows.map((r) => ({ ...r, fired: r.fired_per_theta[key] }));
      summary[key] = summarize(fired as any);
    }
    console.error(`${name}:`, JSON.stringify(summary));
    out.engines[name] = { rows, summary };
  }

  out.judgment_note = `판정컷 θ=${JUDGE_THETA}. 0.65/0.75는 민감도 참고 전용(사전등록 §5).`;
  const dir = new URL('./results/', import.meta.url).pathname;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `lore-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ saved: file, baseline: baseSummary, engines: Object.fromEntries(Object.entries(out.engines).map(([k, v]: any) => [k, v.summary])) }, null, 2));
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

main().catch((e) => { console.error(e); process.exit(1); });
