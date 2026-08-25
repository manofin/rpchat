/**
 * 4계층 요약 예산 배분 순수 헬퍼.
 * builder.ts buildPrompt()의 요약 예산 블록(171~223행)에서 로직을 그대로 추출한 것.
 * 계약(REVIEW-P1-3c 잠금, 재개 금지):
 *   sumBudget = memory − memEst
 *   stateCap  = min(200, sumBudget)
 *   episode   = afterState의 35%, MIN_EPISODE_TOKENS(30) 미만이면 생략,
 *               covers_until이 최근 SCENE_RECENT_GUARD(24) 안이면 생략
 *   whole     = 상태+episode 예약 후 잔여
 *   scene     = 잔여, 최대 2개, rolled_up_into가 승인 에피소드면 제외,
 *               covers_until이 recentGuard 안이면 skip
 *   순서: state → whole → episode → scene → lore. scene 폴백 없음.
 * live 주입 순서·SQL은 변경하지 않는다. builder.ts는 이 헬퍼를 아직 import하지 않는다(후속 와이어링은 별도 슬라이스).
 */

export const MIN_EPISODE_TOKENS = 30;
export const SCENE_RECENT_GUARD = 24;
const EPISODE_SHARE = 0.35;
const STATE_CAP = 200;
const MAX_SCENES = 2;

export interface SceneCandidate {
  id: string;
  tokens: number;
  coversUntil?: string | null;
  rolledUpInto?: string | null;
}

export interface SummaryBudgetInput {
  sumBudget: number;
  stateEst: number;
  /** 렌더 후 잘리기 전 episode 본문 토큰(잠재치) */
  episodeContentTokens: number;
  wholeContentTokens: number;
  /** episode 후보의 covers_until 메시지 id (없으면 가드 대상 아님) */
  episodeCoversUntil?: string | null;
  /** 최근 SCENE_RECENT_GUARD 메시지 id 목록 */
  recentGuardIds?: string[];
  /** 현재 활성 경로의 메시지 id — 오프경로 장면 제외 판정용(라이브 pathIds) */
  pathIds?: string[];
  /** 승인된 에피소드 id 집합 — rollup 제외 판정용 */
  approvedEpisodeIds?: string[];
  scenes?: SceneCandidate[];
}

export interface SummaryBudgetResult {
  stateCap: number;
  afterState: number;
  episodeCap: number;
  episodeUsed: boolean;
  episodeEst: number;
  wholeCap: number;
  sceneFallback: boolean;
  scenesUsed: SceneCandidate[];
  sceneBudget: number;
}

export function allocateSummaryBudget(input: SummaryBudgetInput): SummaryBudgetResult {
  const { sumBudget, stateEst, episodeContentTokens, wholeContentTokens } = input;
  const stateCap = Math.min(STATE_CAP, Math.max(0, sumBudget));
  const afterState = Math.max(0, sumBudget - stateEst);

  // episode: 최신 1건, 예약 35% + MIN_EPISODE_TOKENS + recentGuard
  const guard = new Set(input.recentGuardIds ?? []);
  let episodeUsed = false;
  let episodeEst = 0;
  const episodeCap = Math.floor(afterState * EPISODE_SHARE);
  const guardedByRecent =
    input.episodeCoversUntil != null && guard.has(input.episodeCoversUntil);
  if (
    !guardedByRecent &&
    episodeContentTokens > 0 &&
    episodeCap > 0 &&
    Math.min(episodeContentTokens, episodeCap) >= MIN_EPISODE_TOKENS
  ) {
    episodeEst = Math.min(episodeContentTokens, episodeCap);
    episodeUsed = true;
  }

  // whole: 상태·episode 예약 후 잔여
  const wholeCap = Math.max(0, afterState - episodeEst);
  void wholeContentTokens; // 실측은 min(wholeContentTokens, wholeCap); 계약 검증은 cap 기준

  // scene: episode와 독립. sceneBudget > 0 이면 수집 진행(라이브 builder L201–209 시맨틱):
  // 최대 2, rollup 제외, recentGuard/오프경로는 개별 covers_until 기준 continue.
  const approvedEpisodes = new Set(input.approvedEpisodeIds ?? []);
  const pathIds = new Set(input.pathIds ?? []);
  const sceneBudget = Math.max(0, wholeCap - Math.min(wholeContentTokens, wholeCap));
  const scenesUsed: SceneCandidate[] = [];
  if (sceneBudget > 0) {
    for (const sc of input.scenes ?? []) {
      if (scenesUsed.length >= MAX_SCENES) break;
      if (sc.rolledUpInto && approvedEpisodes.has(sc.rolledUpInto)) continue;
      if (sc.coversUntil && guard.has(sc.coversUntil)) continue; // 아직 recent에 있음 → 중복
      if (sc.coversUntil && pathIds.size > 0 && !pathIds.has(sc.coversUntil)) continue; // 다른 가지의 장면
      if (scenesUsed.reduce((s, x) => s + x.tokens, 0) + sc.tokens > sceneBudget) break;
      scenesUsed.push(sc);
    }
  }

  return {
    stateCap,
    afterState,
    episodeCap,
    episodeUsed,
    episodeEst,
    wholeCap,
    sceneFallback: false,
    scenesUsed,
    sceneBudget,
  };
}
