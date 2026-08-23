/**
 * Task 4: 기억 벤치 (참고자료 전용 — 채택 판정은 Task 3에서 비채택 확정, 본 결과는 판정에 영향 없음).
 * baseline = live classify 컴파일. 임베딩 판정: duplicate=cos≥θ(0.70), conflict=cos≥θ AND 극성 반대 휴리스틱 없음
 * → 사전등록에 conflict 정의가 없어 raw 코사인 분포만 기록한다(측정, 판정 아님).
 * 실행: npx tsx bench/embeddingBench/run-memory.ts --engine all
 */
import fs from 'node:fs';
import path from 'node:path';
import { classify } from '../../apps/server/src/memory/conflict.ts';
import { getEngine, cosine } from './engine.ts';

type Pair = { id: string; cand: string; existing: string; existingId: string; label: 'new' | 'duplicate' | 'complement' | 'conflict' | 'transient' };
const THETAS = [0.65, 0.7, 0.75];
const JUDGE_THETA = 0.7;

async function main() {
  const which = (process.argv[process.argv.indexOf('--engine') + 1] ?? 'all') as 'H1' | 'H2' | 'all';
  const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/memory-v1.json', import.meta.url), 'utf8'));
  const pairs: Pair[] = fixtures.pairs;

  // ---- baseline: live classify ----
  const baseRows = pairs.map((p) => {
    const v = classify({ id: p.id, content: p.cand }, [{ id: p.existingId, content: p.existing }]);
    return { id: p.id, label: p.label, kind: v.kind, reason: v.reason };
  });
  const dupB = pairs.map((_, i) => i).filter((i) => pairs[i].label === 'duplicate');
  const confB = pairs.map((_, i) => i).filter((i) => pairs[i].label === 'conflict');
  const baseSummary = {
    duplicate_recall: `${dupB.filter((i) => baseRows[i].kind === 'duplicate').length}/${dupB.length}`,
    duplicate_false_positive_on_new: `${baseRows.filter((r) => r.label === 'new' && r.kind === 'duplicate').length}/5`,
    conflict_detected_suppressed: `${confB.filter((i) => baseRows[i].reason.startsWith('conflict-suppressed')).length}/${confB.length}`,
  };
  console.error('BASELINE:', JSON.stringify(baseSummary));

  const engines = which === 'all' ? (['H1', 'H2'] as const) : [which];
  const out: any = { run: 'run-memory', note: '참고자료 전용 — 비채택 확정 후 실행. 판정 불영향.', judge_theta: JUDGE_THETA, baseline: baseRows, baseline_summary: baseSummary, engines: {} };

  for (const name of engines) {
    const eng = getEngine(name);
    const rows: Array<{ id: string; label: string; cos: number; fired_per_theta: Record<string, boolean> }> = [];
    for (const p of pairs) {
      // e5: 기존 기억=passage, 후보 문장=query (사전등록 §3 고정)
      const [cv] = await eng.embed([p.cand], name === 'H2' ? 'query' : undefined as any);
      const [ev] = await eng.embed([p.existing], name === 'H2' ? 'passage' : undefined as any);
      const cos = cosine(cv, ev);
      const perTheta: Record<string, boolean> = {};
      for (const th of THETAS) perTheta[String(th)] = cos >= th;
      rows.push({ id: p.id, label: p.label, cos: Number(cos.toFixed(4)), fired_per_theta: perTheta });
    }

    const summary: Record<string, any> = {};
    for (const th of THETAS) {
      const key = String(th);
      const fired = (label: string) => rows.filter((r) => r.label === label && r.fired_per_theta[key]).length;
      const nOf = (label: string) => rows.filter((r) => r.label === label).length;
      summary[key] = {
        duplicate_recall: `${fired('duplicate')}/${nOf('duplicate')}`,
        false_duplicate_on_new: `${fired('new')}/${nOf('new')}`,
        conflict_cos_ge_cut: `${fired('conflict')}/${nOf('conflict')} (cos-only 참고 — 극성 판정 미구현)`,
        complement_misfire_as_dup_or_conf: `${fired('complement')}/${nOf('complement')}`,
        transient_misfire: `${fired('transient')}/${nOf('transient')}`,
      };
    }
    console.error(`${name}:`, JSON.stringify(summary));
    out.engines[name] = { rows, summary };
  }

  const dir = new URL('./results/', import.meta.url).pathname;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `memory-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ saved: file, baseline_summary: baseSummary, engines: Object.fromEntries(Object.entries(out.engines).map(([k, v]: any) => [k, v.summary])) }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
