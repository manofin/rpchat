/**
 * 규칙 기반 기억 판정 (P1-2b). 정밀도 우선 — 확신할 때만 duplicate,
 * 애매하면 'new'. 판정은 플래그일 뿐이며 상태 자동변경을 하지 않는다.
 *
 * P1-2b-fix (b): conflict 규칙의 천장 — "같은 개체 + 한쪽 부정"만으로는
 * "같은 개체·다른 사실" 오탐을 형태소/술어 분석 없이 잡을 수 없다.
 * 실측: XOR 단독 오탐 / 마커 인접어절 제외 무효 / 6행 상호 오탐 5건.
 * 개체겹침+XOR 로직은 P3 재활성·규칙vs임베딩 비교 baseline 으로 코드 유지하되,
 * conflict 도달 시 kind='new' + reason='conflict-suppressed: P3 임베딩 이월'.
 * 실효 판정은 duplicate(자카드≥CAL_CUT)만. 충돌 감지는 P3 임베딩으로 이월.
 *
 * 한계(의도된 경계): 형태소 분석 없음(조사 근사 제거), 반의어쌍(다침/나음 등)은
 * 사전 없이 미탐 → new로 흘려 사용자 승인 단계에 맡긴다.
 */
import type { MemoryRow } from '../types.js';

export type MemoryKind = 'new' | 'duplicate' | 'conflict';

export interface Verdict {
  kind: MemoryKind;
  withMemoryId: string | null;
  reason: string;
}

/** 중복 컷: P1-2b-0 캘리브레이션 — 6행 15쌍 실측 bigram 자카드 max=0.096, 3.6배 마진 */
const CAL_CUT = 0.35;
const MIN_ENTITY_OVERLAP = 2;

/** 부정 마커 사전 (명시적, 확장 가능). '죽'은 명사 '죽음' 오염으로 제외 (P1-2b-fix) */
const NEG_MARKERS = ['않', '못', '없', '아니', '잊', '상실', '실패', '끝'];
/** 마커 뒤에 와야 하는 종결/연결 어미 근사 — 부분매칭(명사 내부) 배제용 (P1-2b-fix) */
const MARKER_SUFFIXES = ['다', '었', '는', '한', '했', '지', '음', '음을', '을'];
/** 범용 부사·지시어 stopword — 개체토큰 오탐 방지 (P1-2b-fix) */
const TOKEN_STOPWORDS = new Set(['모두', '다시', '항상', '계속', '매우', '참', '이미', '아직', '함께', '곧']);

export function normalizeKo(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,!?~'"()\[\]{}·…«»""'']/g, '')
    .replace(/\s+/g, '')
    .replace(/으로|에게|에서|부터|까지|조차|마저|처럼|만큼|보다|마다|고서|라서|라는|하는|된는/g, '')
    .replace(/은|는|이|가|을|를|의|와|과|도|로|에|야|여|랑|커녕/g, '');
}

function bigrams(s: string): Set<string> {
  const n = normalizeKo(s);
  const out = new Set<string>();
  for (let i = 0; i < n.length - 1; i++) out.add(n.slice(i, i + 2));
  return out;
}

export function jaccard(a: string, b: string): number {
  const A = bigrams(a), B = bigrams(b);
  if (A.size + B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** 개체토큰 근사: 정규화 문장에서 공통 부분문자열 토큰(≥2자) 겹침 수 */
function entityOverlap(a: string, b: string): { count: number; tokens: string[] } {
  // 단순 근사: 양쪽 정규화 문장에 모두 등장하는 2자 이상 연속 조각 중
  // 후보 문장의 명사구 추정 토큰(원문 공백/조사 경로) 기준.
  const na = normalizeKo(a), nb = normalizeKo(b);
  const toks = extractEntityTokens(a).filter((t) => {
    const nt = normalizeKo(t);
    // 길이 검사는 원문 토큰 기준(정규화로 조사가 벗겨져 1자가 될 수 있어 정규형 길이로 검사하면
    // '과거를'→'거'처럼 유효한 개체가 탈락함 — P1-2b-fix 회귀 원인)
    return t.length >= 2 && na.includes(nt) && nb.includes(nt);
  });
  return { count: new Set(toks.map((t) => normalizeKo(t))).size, tokens: toks };
}

/** 원문에서 개체 추정 토큰: 조사 앞까지의 명사구(공백 분할 후 조사 접미 근사 제거). stopword 제외 (P1-2b-fix) */
function extractEntityTokens(s: string): string[] {
  return s
    .split(/[\s,.'"/]+/)
    .map((w) => w.replace(/^(그리고|하지만|그러나)/, ''))
    .filter((w) => w.length >= 2 && !TOKEN_STOPWORDS.has(w));
}

/** 부정 극성 인정: 마커가 어미 경계(종결/연결)와 함께 술어 위치에 있을 때만 (P1-2b-fix).
 *  예: '잊어버린'→'잊'+'어'… 어미근사 미적중 시 보수적으로 부정 아님 처리 대신,
 *  마커+임의어미 패턴을 원문과 정규문 양쪽에서 검사한다. */
function negMarkers(s: string): string[] {
  const out: string[] = [];
  for (const m of NEG_MARKERS) {
    let idx = s.indexOf(m);
    let hit = false;
    while (idx >= 0 && !hit) {
      const after = s.slice(idx + m.length, idx + m.length + 2);
      if (MARKER_SUFFIXES.some((suf) => after.startsWith(suf))) hit = true;
      idx = s.indexOf(m, idx + 1);
    }
    if (hit) out.push(m);
  }
  return out;
}

export function classify(cand: Pick<MemoryRow, 'id' | 'content'>, existing: Array<Pick<MemoryRow, 'id' | 'content'>>): Verdict {
  let nearMiss = '';
  for (const ex of existing) {
    if (ex.id === cand.id) continue;
    // 1) 중복: 자카드 ≥ CAL_CUT
    const j = jaccard(cand.content, ex.content);
    if (j >= CAL_CUT) {
      return { kind: 'duplicate', withMemoryId: ex.id, reason: `bigram 자카드 ${j.toFixed(2)} ≥ ${CAL_CUT} (중복 컷)` };
    }
    // 2) 충돌: 개체겹침 ≥2 AND 부정마커 XOR AND 마커 인접어절 제외 후에도 개체 유지 (P1-2b-fix)
    let ov = entityOverlap(cand.content, ex.content);
    if (ov.count >= MIN_ENTITY_OVERLAP) {
      const nc = negMarkers(cand.content);
      const ne = negMarkers(ex.content);
      if (nc.length > 0 !== ne.length > 0) {
        // 극성 대립 후보 → 부정 쪽 마커 어절과 인접(±1)한 어절은 술어구로 보아 개체에서 제외
        const negSide = nc.length ? cand.content : ex.content;
        const excl = markerAdjacentNorms(negSide);
        const keptTokens = ov.tokens.filter((t) => !excl.has(normalizeKo(t)));
        ov = { count: new Set(keptTokens.map((t) => normalizeKo(t))).size, tokens: keptTokens };
        if (ov.count >= MIN_ENTITY_OVERLAP) {
          const side = nc.length ? nc : ne;
          // 로직은 유지(감지됨)하되 플래그는 보류 — 규칙 정밀도 천장, P3 임베딩 이월
          return {
            kind: 'new',
            withMemoryId: ex.id,
            reason: `conflict-suppressed: P3 임베딩 이월 — conflict였을 것(개체 [${ov.tokens.map((t) => t.slice(0, 8)).join(', ')}], XOR ${side.join(',')})이나 규칙 정밀도 한계로 보류`,
          };
        }
        nearMiss = `극성 대립 후보였으나 개체가 부정술어구에만 존재(잔존 겹침 ${ov.count})`;
      } else {
        nearMiss = `개체 [${ov.tokens.map((t) => t.slice(0, 8)).join(', ')}] 겹침, 양쪽 ${nc.length && ne.length ? '부정' : '긍정'} → XOR 거짓`;
      }
    }
  }
  return { kind: 'new', withMemoryId: null, reason: nearMiss ? `${nearMiss} → new` : '규칙 적중 없음 → new' };
}

/** 부정 마커 어절 + 앞뒤 인접 어절의 정규형 집합 — 술어구 보호용 (P1-2b-fix) */
function markerAdjacentNorms(side: string): Set<string> {
  const words = side.split(/[\s,.'"/]+/).filter(Boolean);
  const out = new Set<string>();
  words.forEach((w, i) => {
    if (NEG_MARKERS.some((m) => w.includes(m))) {
      out.add(normalizeKo(w));
      if (i > 0) out.add(normalizeKo(words[i - 1]));
      if (i < words.length - 1) out.add(normalizeKo(words[i + 1]));
    }
  });
  return out;
}
