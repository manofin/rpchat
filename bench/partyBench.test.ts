/**
 * npx tsx bench/partyBench.test.ts
 * f9-bench-a-router — isolated Bench-A (accuracy + reach).
 * Helper/bench PASS is not a product PASS (helper-vs-live-contract).
 * Does not start systemd, touch live DB, call a model, or write apps/**.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORBIDDEN_SUBSTRINGS } from './partyBench/cast.ts';
import { pickSpeaker } from './partyBench/router.ts';
import { runBenchA } from './partyBench/run-bench-a.ts';
import { CUT } from './partyBench/score.ts';
import type { AccuracyCase, ReachCase } from './partyBench/types.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const accPath = path.join(dir, 'partyBench/fixtures/accuracy.json');
const reachPath = path.join(dir, 'partyBench/fixtures/reach.json');

function dump(obj: unknown): string {
  return JSON.stringify(obj);
}

async function main() {
await t('accuracy fixture exists N=200', () => {
  assert.equal(fs.existsSync(accPath), true, 'fixtures/accuracy.json missing');
  const j = JSON.parse(fs.readFileSync(accPath, 'utf8')) as { n: number; cases: AccuracyCase[] };
  assert.equal(j.n, 200);
  assert.equal(j.cases.length, 200);
});

await t('reach fixture exists INPUT 50/30/10/10 N=100', () => {
  assert.equal(fs.existsSync(reachPath), true, 'fixtures/reach.json missing');
  const j = JSON.parse(fs.readFileSync(reachPath, 'utf8')) as { n: number; cases: ReachCase[] };
  assert.equal(j.n, 100);
  assert.equal(j.cases.length, 100);
  const n = (b: string) => j.cases.filter((c) => c.bucket === b).length;
  assert.equal(n('explicit_name'), 50);
  assert.equal(n('duty_fit'), 30);
  assert.equal(n('scene_position'), 10);
  assert.equal(n('ambiguous'), 10);
});

await t('accuracy bucket n A50 B50 C50 D50', () => {
  const j = JSON.parse(fs.readFileSync(accPath, 'utf8')) as { cases: AccuracyCase[] };
  const n = (b: string) => j.cases.filter((c) => c.bucket === b).length;
  assert.equal(n('explicit_name'), 50);
  assert.equal(n('duty_fit'), 50);
  assert.equal(n('scene_position'), 50);
  assert.equal(n('ambiguous'), 50);
});

await t('no live character ids or forbidden names in fixtures', () => {
  const blob = fs.readFileSync(accPath, 'utf8') + fs.readFileSync(reachPath, 'utf8');
  for (const s of FORBIDDEN_SUBSTRINGS) {
    assert.equal(blob.includes(s), false, `forbidden substring ${s}`);
  }
});

await t('router output is scores not a bare id', () => {
  const j = JSON.parse(fs.readFileSync(accPath, 'utf8')) as { cases: AccuracyCase[] };
  const out = pickSpeaker(j.cases[0]);
  assert.equal(typeof out.scores, 'object');
  assert.equal(Array.isArray(out.scores), false);
  assert.equal(typeof out.decided_stage, 'number');
  assert.ok(out.main_speaker_id === null || typeof out.main_speaker_id === 'string');
});

await t('stage 1 unique mention does not fall through to LLM', () => {
  const out = pickSpeaker({
    user_text: '민아, 이쪽이요.',
    scene: { place: '로비', time: '오전', goal: 'x', genre: 'x', conflict: 'x', mood: 'x' },
    cast: JSON.parse(fs.readFileSync(accPath, 'utf8')).cases[0].cast,
  });
  assert.equal(out.decided_stage, 1);
  assert.equal(out.llm_reached, false);
  assert.equal(out.main_speaker_id, 'npc_mina');
  assert.equal(out.scores['npc_mina'], 95);
});

// Written 2026-09-01, when these asserted that no product router and no 0010
// existed yet. Both shipped later that day, so the pair went stale on its own —
// this bench was already failing before f9-beat touched anything. (An automated
// import retarget in that work briefly pointed the first one at `cast.ts`, which
// made it assert something it never meant; this is the repair.)
//
// Bench-A's actual claim is that it measured its OWN router, in isolation, never
// product code. That is what is asserted now.
await t('Bench-A measured its own isolated router, not product code', () => {
  const local = path.join(dir, 'partyBench/router.ts');
  assert.equal(fs.existsSync(local), true, 'the isolated router must still be here');
  const runner = fs.readFileSync(path.join(dir, 'partyBench/run-bench-a.ts'), 'utf8');
  assert.equal(runner.includes('apps/server/src/'), false, 'the runner must not import product code');
  assert.equal(/better-sqlite3|rpchat\.db/.test(runner), false, 'and must not touch a DB');
});

const report = runBenchA();

await t('Accuracy A∧B∧C uses sealed cuts', () => {
  assert.equal(CUT.A, 0.98);
  assert.equal(CUT.B, 0.9);
  assert.equal(CUT.C, 0.85);
  assert.equal(report.accuracy.A.n, 50);
  assert.equal(report.accuracy.B.n, 50);
  assert.equal(report.accuracy.C.n, 50);
  assert.equal(report.accuracy.D.n, 50);
});

await t('Reach OUTPUT reported (not INPUT recounted as reach)', () => {
  assert.equal(report.reach.input.explicit_name, 50);
  assert.equal(report.reach.output.n, 100);
  assert.ok('pct1' in report.reach.output);
  assert.ok('pct4' in report.reach.output);
});

await t('Fallback Rate present and not used as cut field', () => {
  assert.equal(typeof report.fallback_rate.reach_corpus.llm_pct, 'number');
  assert.equal(report.fallback_rate.note.includes('not a cut'), true);
});

await t('stage 4 does not invent an LLM speaker', () => {
  const d = report.cases_accuracy.filter((r) => r.bucket === 'ambiguous');
  assert.equal(d.length, 50);
  for (const row of d) {
    assert.equal(row.decided_stage, 4);
    assert.equal(row.main_speaker_id, null);
    assert.equal(row.llm_reached, true);
  }
});

console.log(`passed ${passed}`);
console.log(
  JSON.stringify(
    {
      accuracy_verdict: report.accuracy.verdict,
      A: report.accuracy.A,
      B: report.accuracy.B,
      C: report.accuracy.C,
      D: report.accuracy.D,
      reach_verdict: report.reach.verdict,
      reach_output: report.reach.output,
      llm_redesign_trigger: report.reach.llm_redesign_trigger,
      fallback_rate: report.fallback_rate,
    },
    null,
    2,
  ),
);
}

main();
