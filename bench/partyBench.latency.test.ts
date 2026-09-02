/**
 * npx tsx bench/partyBench.latency.test.ts
 * f9-bench-latency — helper only. No live model, no live DB, no apps/** write.
 * Helper/bench PASS is not a product PASS (helper-vs-live-contract).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORBIDDEN_SUBSTRINGS } from './partyBench/cast.ts';
import { buildPromptA, buildPromptB, countParticipants, countRecent } from './partyBench/prompts.ts';
import {
  LATENCY_CUT,
  latencyVerdict,
  overflowCount,
  percentile,
  turnMs,
} from './partyBench/score-latency.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const root = path.dirname(fileURLToPath(import.meta.url));
const partyDir = path.join(root, 'partyBench');
const appRoot = path.join(root, '..');

function blobOf(...rels: string[]): string {
  return rels.map((r) => fs.readFileSync(path.join(partyDir, r), 'utf8')).join('\n');
}

async function main() {
  await t('sealed latency cuts match §0-3', () => {
    assert.equal(LATENCY_CUT.n, 50);
    assert.equal(LATENCY_CUT.p50_s, 90);
    assert.equal(LATENCY_CUT.p95_s, 120);
    assert.equal(LATENCY_CUT.overflow, 0);
    assert.equal(LATENCY_CUT.queue_depth, 1);
    assert.equal(LATENCY_CUT.context_tokens, 16384);
    assert.equal(LATENCY_CUT.p50_redesign_s, 150);
  });

  await t('Prompt-A structure: scene + 3 participants + 10 recent + 1 main + 1 secondary', () => {
    const p = buildPromptA();
    assert.equal(p.kind, 'A');
    assert.equal(p.scene.place, '로비');
    assert.equal(countParticipants(p), 3);
    assert.equal(countRecent(p), 10);
    assert.equal(p.main_speaker_id, 'npc_mina');
    assert.equal(p.secondary_speaker_id, 'npc_jiu');
    assert.ok(p.call1.length >= 2);
    assert.ok(p.call2.length >= 2);
    assert.equal(p.call1[0].role, 'system');
    assert.equal(p.call2[0].role, 'system');
    const sys1 = p.call1[0].content;
    assert.equal(sys1.includes('proposed_state_patch'), true);
    assert.equal(sys1.includes('코드펜스'), true);
    const sys2 = p.call2[0].content;
    assert.equal(sys2.includes('민아'), true);
    assert.equal(sys2.includes('지우'), true);
  });

  await t('Prompt-B structure: scene + 5 participants + compressed cast + 20 recent', () => {
    const p = buildPromptB();
    assert.equal(p.kind, 'B');
    assert.equal(countParticipants(p), 5);
    assert.equal(countRecent(p), 20);
    assert.equal(p.compressed_cast, true);
    assert.ok(p.est_tokens >= 8000, `Prompt-B est_tokens ${p.est_tokens} not 16K-adjacent`);
    assert.ok(p.est_tokens <= LATENCY_CUT.context_tokens, `Prompt-B est overflow by construction ${p.est_tokens}`);
  });

  await t('no live character ids or forbidden names in latency prompts', () => {
    const a = JSON.stringify(buildPromptA());
    const b = JSON.stringify(buildPromptB());
    const src = blobOf('prompts.ts', 'score-latency.ts', 'run-bench-latency.ts', 'latency-lock.md');
    for (const s of FORBIDDEN_SUBSTRINGS) {
      assert.equal(a.includes(s), false, `A forbidden ${s}`);
      assert.equal(b.includes(s), false, `B forbidden ${s}`);
      assert.equal(src.includes(s), false, `src forbidden ${s}`);
    }
  });

  await t('percentile estimator is sketchBench floor(p/100*n)', () => {
    const xs = [10, 20, 30, 40, 50];
    assert.equal(percentile(xs, 50), 30);
    assert.equal(percentile(xs, 95), 50);
    assert.equal(percentile([], 50), null);
  });

  await t('turn_ms is call1 + call2 serial sum', () => {
    assert.equal(turnMs({ call1_ms: 38080, call2_ms: 38080 }), 76160);
  });

  await t('verdict does not soften cuts', () => {
    const ok = latencyVerdict({ p50_s: 90, p95_s: 120, overflow: 0, n: 50 });
    const failP50 = latencyVerdict({ p50_s: 90.01, p95_s: 120, overflow: 0, n: 50 });
    const failP95 = latencyVerdict({ p50_s: 90, p95_s: 120.01, overflow: 0, n: 50 });
    const failOv = latencyVerdict({ p50_s: 10, p95_s: 10, overflow: 1, n: 50 });
    const failN = latencyVerdict({ p50_s: 10, p95_s: 10, overflow: 0, n: 49 });
    assert.equal(ok, true);
    assert.equal(failP50, false);
    assert.equal(failP95, false);
    assert.equal(failOv, false);
    assert.equal(failN, false);
  });

  await t('overflow counts prompt_tokens above 16384 only', () => {
    assert.equal(overflowCount([16384, 1, 0]), 0);
    assert.equal(overflowCount([16385]), 1);
  });

  await t('runner source is serial queue-depth-1, no conversation INSERT, no apps pickSpeaker', () => {
    const src = fs.readFileSync(path.join(partyDir, 'run-bench-latency.ts'), 'utf8');
    assert.equal(src.includes('Promise.all'), false);
    assert.equal(/\/api\/conversations/.test(src), false);
    assert.equal(/INSERT\s+INTO/i.test(src), false);
    assert.equal(src.includes('apps/server/src/prompt/pickSpeaker'), false);
    assert.equal(src.includes('queue_depth: 1') || src.includes('QUEUE_DEPTH = 1'), true);
    assert.equal(src.includes('token: \'f9-bench-latency\'') || src.includes('token: "f9-bench-latency"'), true);
  });

  await t('this bench stays isolated from product code, whatever ships', () => {
    // Written 2026-09-01, when this asserted that product pickSpeaker.ts and 0010
    // did not exist yet. Both shipped later that day, so the absence claim was a
    // lock-state snapshot that went stale on its own — not a cut. What the cut
    // actually needs is that the runner measures prompts, never product modules.
    const src = fs.readFileSync(path.join(partyDir, 'run-bench-latency.ts'), 'utf8');
    for (const mod of ['apps/server/src/prompt/', 'apps/server/src/routes/', 'apps/server/src/db/']) {
      assert.equal(src.includes(mod), false, `latency runner must not import ${mod}`);
    }
    assert.equal(/better-sqlite3|rpchat\.db/.test(src), false, 'latency runner touches no DB');
  });

  console.log(`passed ${passed}`);
}

main();
