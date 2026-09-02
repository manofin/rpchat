/**
 * Bench-A runner. Isolated. Live DB 0. Live generate 0. apps/** 0.
 * Writes app/bench/partyBench/results/<run-id>.json
 * Usage: npx tsx bench/partyBench/run-bench-a.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickSpeaker } from './router.ts';
import {
  accuracyVerdict,
  bucketStats,
  fallbackRate,
  llmRedesignTrigger,
  reachInputMix,
  reachOutputShares,
  reachVerdict,
  scoreAccuracyCase,
} from './score.ts';
import type { AccuracyCase, ReachCase } from './types.ts';

const dir = path.dirname(fileURLToPath(import.meta.url));

function loadJson<T>(rel: string): T {
  return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')) as T;
}

export function runBenchA() {
  const accFile = loadJson<{ n: number; cases: AccuracyCase[] }>('fixtures/accuracy.json');
  const reachFile = loadJson<{ n: number; cases: ReachCase[] }>('fixtures/reach.json');
  if (accFile.cases.length !== 200 || accFile.n !== 200) {
    throw new Error(`Accuracy corpus schema collapse N=${accFile.cases.length}`);
  }
  if (reachFile.cases.length !== 100 || reachFile.n !== 100) {
    throw new Error(`Reach corpus schema collapse N=${reachFile.cases.length}`);
  }
  const mix = reachInputMix(reachFile.cases);
  if (mix.explicit_name !== 50 || mix.duty_fit !== 30 || mix.scene_position !== 10 || mix.ambiguous !== 10) {
    throw new Error(`Reach INPUT mix invalid ${JSON.stringify(mix)}`);
  }

  const accOuts = accFile.cases.map((c) => pickSpeaker(c));
  const accRows = accFile.cases.map((c, i) => scoreAccuracyCase(c, accOuts[i]));
  const A = bucketStats(accRows, 'explicit_name');
  const B = bucketStats(accRows, 'duty_fit');
  const C = bucketStats(accRows, 'scene_position');
  const D = bucketStats(accRows, 'ambiguous');
  const D_stage = {
    n: D.n,
    stage_ok: accRows.filter((r) => r.bucket === 'ambiguous' && r.stage_ok).length,
  };

  const reachOuts = reachFile.cases.map((c) => pickSpeaker(c));
  const reachShares = reachOutputShares(reachOuts.map((o) => o.decided_stage));
  const fbAcc = fallbackRate(accOuts);
  const fbReach = fallbackRate(reachOuts);

  const report = {
    token: 'f9-bench-a-router',
    bench: 'Bench-A',
    live_db: 0,
    live_generate: 0,
    apps_product_code: 0,
    pickSpeaker_product_path: 0,
    llm_invoked: 0,
    accuracy: {
      A,
      B,
      C,
      D,
      D_stage_only: D_stage,
      N: 200,
      verdict: accuracyVerdict(A, B, C),
      note: 'D is report-only. Stage-4 does not call a model; speaker match vs npc_mina is expected to fail when main_speaker_id is null.',
    },
    reach: {
      input: mix,
      output: reachShares,
      verdict: reachVerdict(reachShares),
      llm_redesign_trigger: llmRedesignTrigger(reachShares.pct4),
    },
    fallback_rate: {
      note: 'report field, not a cut',
      accuracy_corpus: fbAcc,
      reach_corpus: fbReach,
    },
    cases_accuracy: accRows,
    cases_reach: reachFile.cases.map((c, i) => ({
      id: c.id,
      bucket: c.bucket,
      decided_stage: reachOuts[i].decided_stage,
      main_speaker_id: reachOuts[i].main_speaker_id,
      llm_reached: reachOuts[i].llm_reached,
      scores: reachOuts[i].scores,
    })),
  };
  return report;
}

function isMain() {
  const self = fileURLToPath(import.meta.url);
  const arg = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return arg === self;
}

if (isMain()) {
  const report = runBenchA();
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(dir, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${runId}.json`);
  const slim = { ...report };
  fs.writeFileSync(outPath, JSON.stringify(slim, null, 2) + '\n');
  const summary = {
    run_id: runId,
    path: outPath,
    accuracy: report.accuracy,
    reach: report.reach,
    fallback_rate: report.fallback_rate,
  };
  console.log(JSON.stringify(summary, null, 2));
  console.log(`WROTE ${outPath}`);
}
