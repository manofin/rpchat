import type { Scene } from '../types.js';

export type ResponseLength = 'short' | 'normal' | 'long';

export function responseMaxTokens(scene: Pick<Scene, 'response_length'>, normal: number): number {
  if (scene.response_length === 'short') return Math.max(128, Math.floor(normal * 0.6));
  if (scene.response_length === 'long') return Math.max(normal, Math.min(4096, normal * 2));
  return normal;
}

export function responseLengthHint(scene: Pick<Scene, 'response_length'>): string {
  if (scene.response_length === 'short') return '\n\n응답 길이: 핵심 반응과 필요한 대사만 간결하게 쓴다. 화자·출력 형식·유저 대필 금지 규칙은 그대로 지킨다.';
  if (scene.response_length === 'long') return '\n\n응답 길이: 같은 사건을 반복하지 말고 감각·행동·대화의 여운을 충분히 전개한다. 유저의 다음 행동을 대신 정하지 않는다. 화자·출력 형식과 상태 변경 제한은 그대로 지킨다.';
  return '';
}
