/**
 * PromptPolicy — 모델 프로필의 서술 지침(instruction_text)이 켜졌을 때 1:1 고정 규칙 중
 * 무엇을 끄는지 한 곳에서 정한다. 규칙과 지침을 같이 넣고 모델이 고르게 하지 않는다.
 *
 * - 1:1 (`buildPrompt`): 세 플래그를 모두 쓴다. 지침이 켜지면 HARD_RULES 4번의 산문 순서
 *   강제와 LENGTH_HINT 를 뺀다(`renderRules` policy 인자).
 * - 파티 (N/F/E/S): `includeEngineInstruction` 만 쓴다. 파티 호출의 문장 수·대사 줄 수 제한은
 *   호출별 출력 계약이라 끄지 않는다(`attachInjectToIcPass` 의 `profileInstruction`).
 * - OOC 턴은 호출 측이 DEFAULT_PROMPT_POLICY 를 쓴다.
 *
 * 지침이 없으면(비활성·공백) DEFAULT 와 같아 프롬프트가 0023 이전과 바이트 동일하다.
 */
import type { InstructionOverflow, ModelProfile } from '../types.js';

export type PromptPolicy = {
  enforceProseOrder: boolean;
  includeLengthHint: boolean;
  includeEngineInstruction: boolean;
};

export const DEFAULT_PROMPT_POLICY: Readonly<PromptPolicy> = Object.freeze({
  enforceProseOrder: true,
  includeLengthHint: true,
  includeEngineInstruction: false,
});

type InstructionFields = Partial<Pick<ModelProfile, 'instruction_enabled' | 'instruction_text'>>;

export function resolvePromptPolicy(profile: InstructionFields): PromptPolicy {
  const hasExternalStyleEngine =
    profile.instruction_enabled === 1 &&
    Boolean(profile.instruction_text?.trim());

  return {
    enforceProseOrder: !hasExternalStyleEngine,
    includeLengthHint: !hasExternalStyleEngine,
    includeEngineInstruction: hasExternalStyleEngine,
  };
}

/** 422 본문. 1:1·파티 거부가 같은 문구를 쓴다. */
export function formatInstructionOverflow(o: InstructionOverflow): string {
  return `서술 지침이 컨텍스트 예산을 넘어 생성하지 않음: 프로필 ${o.profile}, 지침 추정 ${o.instruction_tokens}토큰, 필요 ${o.required} > 가용 ${o.available}. 더 짧은 지침(LITE)을 쓰거나 이 방의 프로필을 바꾸세요.`;
}

/** 주입할 지침 원문(저장된 그대로), 없으면 null. 1:1·파티가 같은 판정을 쓴다. */
export function profileInstructionText(profile: InstructionFields): string | null {
  return resolvePromptPolicy(profile).includeEngineInstruction ? (profile.instruction_text as string) : null;
}
