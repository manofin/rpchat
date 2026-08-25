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

// --- 회귀 테스트 (2026-08-24 정정): 라이브 builder.ts L201–209 시맨틱 ---
t('REGRESSION: episode in recentGuard does NOT block scenes; per-scene covers_until decides', () => {
  const recent = Array.from({ length: 24 }, (_, i) => `m${i}`);
  const a = allocateSummaryBudget({
    sumBudget: 1000,
    stateEst: 40,
    episodeContentTokens: 60,
    episodeCoversUntil: 'm23', // recentGuard에 걸림 → episode만 생략
    wholeContentTokens: 100,
    recentGuardIds: recent,
    scenes: [
      { id: 'old1', tokens: 30, coversUntil: 'ancient1', rolledUpInto: null },
      { id: 'recent1', tokens: 30, coversUntil: 'm22', rolledUpInto: null },
      { id: 'old2', tokens: 20, coversUntil: 'ancient2', rolledUpInto: null },
    ],
  });
  assert.equal(a.episodeUsed, false);
  // 라이브: sceneBudget>0이면 장면 수집 진행. old1/old2만 주입(recent1은 개별 guard로 skip)
  assert.deepEqual(a.scenesUsed.map((s) => s.id), ['old1', 'old2']);
});

t('REGRESSION: off-path scenes are skipped by pathIds like live builder', () => {
  const a = allocateSummaryBudget({
    sumBudget: 1000,
    stateEst: 40,
    episodeContentTokens: 0,
    wholeContentTokens: 0,
    pathIds: ['p1'],
    scenes: [
      { id: 'onpath', tokens: 30, coversUntil: 'p1', rolledUpInto: null },
      { id: 'offpath', tokens: 30, coversUntil: 'other-branch', rolledUpInto: null },
    ],
  });
  assert.deepEqual(a.scenesUsed.map((s) => s.id), ['onpath']);
});
