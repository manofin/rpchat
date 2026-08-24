/** npx tsx bench/builderBudget.test.ts — 4계층 요약 예산 배분 순수 헬퍼 계약 (REVIEW 잠금 재개 금지, 현행 builder 로직의 추출만) */
import assert from 'node:assert/strict';
import { allocateSummaryBudget } from '../apps/server/src/prompt/summaryBudget.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

t('episode reserved before whole; long whole cannot starve episode', () => {
  const a = allocateSummaryBudget({ sumBudget: 400, stateEst: 80, episodeContentTokens: 50, wholeContentTokens: 5000 });
  assert.ok(a.episodeCap >= 30);
  assert.ok(a.episodeCap <= a.afterState);
  assert.ok(a.wholeCap <= a.afterState - a.episodeEst);
});

t('episode omitted when below MIN_EPISODE_TOKENS; no scene fallback flag', () => {
  const a = allocateSummaryBudget({ sumBudget: 80, stateEst: 70, episodeContentTokens: 40, wholeContentTokens: 10 });
  assert.equal(a.episodeUsed, false);
  assert.equal(a.sceneFallback, false);
});

t('recentGuard skips episode and scene when covers_until in last 24 ids', () => {
  const recent = Array.from({ length: 24 }, (_, i) => `m${i}`);
  const a = allocateSummaryBudget({
    sumBudget: 400,
    stateEst: 40,
    episodeContentTokens: 40,
    episodeCoversUntil: 'm23',
    recentGuardIds: recent,
    scenes: [{ id: 's1', tokens: 20, coversUntil: 'm22', rolledUpInto: null }],
  });
  assert.equal(a.episodeUsed, false);
  assert.equal(a.scenesUsed.length, 0);
});

t('scene cap 2 and rolled-up scenes excluded; order state→whole→episode→scene', () => {
  const a = allocateSummaryBudget({
    sumBudget: 1000,
    stateEst: 50,
    episodeContentTokens: 60,
    wholeContentTokens: 100,
    scenes: [
      { id: 's1', tokens: 20, coversUntil: 'old1', rolledUpInto: 'ep1' },
      { id: 's2', tokens: 30, coversUntil: 'old2', rolledUpInto: null },
      { id: 's3', tokens: 25, coversUntil: 'old3', rolledUpInto: null },
      { id: 's4', tokens: 10, coversUntil: 'old4', rolledUpInto: null },
    ],
    approvedEpisodeIds: ['ep1'],
  });
  // s1은 rollup됨 → 제외. s2,s3만 주입(최대 2), s4는 컷.
  assert.deepEqual(a.scenesUsed.map((s) => s.id), ['s2', 's3']);
});

console.log(`passed ${passed}`);
