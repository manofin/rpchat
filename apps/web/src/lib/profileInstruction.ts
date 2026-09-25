import type { ModelProfile } from '../types';

/**
 * profile-instruction (0023) — 화면 표시용 판정·추정. 서버 promptPolicy.ts /
 * prompt/tokens.ts 와 같은 규칙을 쓴다(주입 여부의 정본은 서버).
 */
export const PROFILE_NAME_RE = /^[a-z0-9-]{2,40}$/;
export const PROFILE_INSTRUCTION_MAX = 20000;

export function hasInstruction(p: Pick<ModelProfile, 'instruction_enabled' | 'instruction_text'>): boolean {
  return p.instruction_enabled === 1 && !!p.instruction_text?.trim();
}

/** 선택 목록 라벨 끝에 붙는 표시. 지침이 없으면 빈 문자열 → 기존 라벨 그대로. */
export function instructionBadge(p: Pick<ModelProfile, 'instruction_enabled' | 'instruction_text'>): string {
  return hasInstruction(p) ? ' · 지침' : '';
}

/** 서버 estimateTokensRaw × calibration 과 같은 식. */
export function estimateInstructionTokens(text: string, calibration = 1): number {
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
  return Math.ceil(Math.ceil(hangul * 0.7 + cjk * 1.0 + other / 3.6) * calibration);
}
