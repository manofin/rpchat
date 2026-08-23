/**
 * 규칙 기반 기억 판정 (P1-2b). 정밀도 우선 — 확신할 때만 duplicate/conflict,
 * 애매하면 'new'. 판정은 플래그일 뿐이며 상태 자동변경을 하지 않는다.
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

/** 부정 마커 사전 (명시적, 확장 가능) */
const NEG_MARKERS = ['않', '못', '없', '아니', '잊', '상실', '실패', '죽', '끝'];

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
    return nt.length >= 2 && na.includes(nt) && nb.includes(nt);
  });
  return { count: new Set(toks.map((t) => normalizeKo(t))).size, tokens: toks };
}

/** 원문에서 개체 추정 토큰: 조사 앞까지의 명사구(공백 분할 후 조사 접미 근사 제거) */
function extractEntityTokens(s: string): string[] {
  return s
    .split(/[\s,.'"/]+/)
    .map((w) => w.replace(/^(그리고|하지만|그러나)/, ''))
    .filter((w) => w.length >= 2);
}

function negMarkers(s: string): string[] {
  return NEG_MARKERS.filter((m) => s.includes(m));
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
    // 2) 충돌: 개체겹침 ≥2 AND 부정마커 XOR
    const ov = entityOverlap(cand.content, ex.content);
    if (ov.count >= MIN_ENTITY_OVERLAP) {
      const nc = negMarkers(cand.content);
      const ne = negMarkers(ex.content);
      const xor = nc.length > 0 !== ne.length > 0;
      if (xor) {
        const side = nc.length ? nc : ne;
        return {
          kind: 'conflict',
          withMemoryId: ex.id,
          reason: `개체 [${ov.tokens.map((t) => t.slice(0, 8)).join(', ')}] ${ov.count}개 겹침 + 한쪽만 부정(${side.join(',')}) — 극성 대립`,
        };
      }
      // 개체는 겹치지만 XOR 거짓 → 근거 후보로 기록
      nearMiss = `개체 [${ov.tokens.map((t) => t.slice(0, 8)).join(', ')}] 겹침, 양쪽 ${nc.length && ne.length ? '부정' : '긍정'} → XOR 거짓`;
    }
  }
  return { kind: 'new', withMemoryId: null, reason: nearMiss ? `${nearMiss} → new` : '규칙 적중 없음 → new' };
}
