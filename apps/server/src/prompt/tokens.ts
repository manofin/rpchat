import { type DB, getSetting, setSetting } from '../db/index.js';

/**
 * 토크나이저 없이 쓰는 보수적 추정치. 한글 음절은 최신 토크나이저에서 대개 1~2자/토큰,
 * 영문·기호는 ~3.5~4자/토큰. 실제 usage.prompt_tokens 로 보정 계수를 학습한다(EMA).
 */
export function estimateTokensRaw(text: string): number {
  if (!text) return 0;
  let hangul = 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f)) hangul++;
    else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff)) cjk++;
    else other++;
  }
  return Math.ceil(hangul * 0.7 + cjk * 1.0 + other / 3.6);
}

export function estimateTokens(text: string, calibration = 1): number {
  return Math.ceil(estimateTokensRaw(text) * calibration);
}

/** 채팅 메시지 1건: 본문 + 역할/구분 토큰 여유 */
export function estimateMessageTokens(content: string, calibration = 1): number {
  return estimateTokens(content, calibration) + 5;
}

export function getCalibration(db: DB): number {
  const v = Number(getSetting(db, 'token_calibration', '1.0'));
  return Number.isFinite(v) && v > 0 ? v : 1.0;
}

/** 실제 prompt_tokens 가 보고되면 보정 계수를 갱신 (0.5~3.0 클램프, EMA 0.2) */
export function updateCalibration(db: DB, estimated: number, actual: number): number {
  if (!estimated || !actual || estimated < 50) return getCalibration(db);
  const ratio = actual / estimated;
  const prev = getCalibration(db);
  const next = Math.min(3, Math.max(0.5, prev * 0.8 + ratio * 0.2));
  setSetting(db, 'token_calibration', next.toFixed(3));
  return next;
}

/** 대략적인 토큰 상한으로 텍스트 자르기 (끝을 자름, 문장 경계 우선) */
export function truncateToTokens(text: string, maxTokens: number, calibration = 1): string {
  if (estimateTokens(text, calibration) <= maxTokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (estimateTokens(text.slice(0, mid), calibration) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  const cut = text.slice(0, lo);
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '), cut.lastIndexOf('다.'));
  return (lastBreak > lo * 0.6 ? cut.slice(0, lastBreak + 1) : cut).trimEnd() + ' …';
}
