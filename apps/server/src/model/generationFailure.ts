import { isModelTimeoutError, isTurnDeadlineError } from './turnDeadline.js';

export type GenerationFailureCode =
  | 'connection'
  | 'timeout'
  | 'model_timeout'
  | 'turn_deadline_exceeded'
  | 'user_cancelled'
  | 'internal_error'
  | 'validation'
  | 'generation';

export class PrivateValidationError extends Error {
  constructor() { super('비공개 내용 확인에 실패했습니다. 다시 시도해 주세요.'); this.name = 'PrivateValidationError'; }
}

const COPY = {
  user_cancelled: '생성을 취소했습니다.',
  model_timeout: '모델 응답 시간이 초과됐습니다.',
  turn_deadline_exceeded: '대기를 포함한 전체 처리 시간이 초과됐습니다.',
  internal_error: '처리 중 오류가 발생했습니다.',
} as const;

export function generationFailure(error: unknown): { code: GenerationFailureCode; message: string } {
  const e = error as { name?: string; cause?: { code?: string; name?: string }; message?: string } | null;
  if (error instanceof PrivateValidationError) return { code: 'validation', message: error.message };
  if (isTurnDeadlineError(error) || isTurnDeadlineError(e && 'reason' in (error as object) ? (error as { reason?: unknown }).reason : null)) {
    return { code: 'turn_deadline_exceeded', message: COPY.turn_deadline_exceeded };
  }
  // AbortSignal reason may be the TurnDeadlineError while the thrown err is AbortError.
  const reason = (error as { cause?: unknown } | null)?.cause
    ?? (typeof DOMException !== 'undefined' && error instanceof DOMException ? undefined : undefined);
  void reason;
  if (e?.name === 'AbortError') {
    // Prefer signal reason when callers pass it via err.cause or we detect message.
    if (/전체 처리 시간/i.test(e.message ?? '')) {
      return { code: 'turn_deadline_exceeded', message: COPY.turn_deadline_exceeded };
    }
  }
  if (isModelTimeoutError(error) || e?.name === 'TimeoutError' || e?.cause?.name === 'TimeoutError') {
    return { code: 'model_timeout', message: COPY.model_timeout };
  }
  if (/^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(e?.cause?.code ?? '')) {
    return { code: 'connection', message: '모델 서버에 연결하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.' };
  }
  if (e?.name === 'AbortError') {
    return { code: 'user_cancelled', message: COPY.user_cancelled };
  }
  return { code: 'generation', message: '이야기를 생성하지 못했습니다. 다시 시도해 주세요.' };
}

/** Classify a beat/dialog terminal from controller + thrown error + optional recorded reason. */
export function classifyTurnTermination(
  controller: AbortController,
  err: unknown,
  recorded: import('./turnDeadline.js').TurnTerminationReason | null | undefined,
): import('./turnDeadline.js').TurnTerminationReason {
  if (recorded && recorded !== 'completed') return recorded;
  const signalReason = controller.signal.reason;
  if (isTurnDeadlineError(err) || isTurnDeadlineError(signalReason)) return 'turn_deadline_exceeded';
  if (isModelTimeoutError(err) || isModelTimeoutError(signalReason)) return 'model_timeout';
  if (controller.signal.aborted) {
    // User abort leaves undefined/AbortError reason; deadline sets TurnDeadlineError.
    if (isTurnDeadlineError(signalReason)) return 'turn_deadline_exceeded';
    return 'user_cancelled';
  }
  const e = err as { name?: string } | undefined;
  if (e?.name === 'TimeoutError') return 'model_timeout';
  if (e?.name === 'AbortError') return 'user_cancelled';
  return 'internal_error';
}

export function turnTerminationMessage(
  reason: import('./turnDeadline.js').TurnTerminationReason,
): string {
  if (reason === 'user_cancelled') return COPY.user_cancelled;
  if (reason === 'model_timeout') return COPY.model_timeout;
  if (reason === 'turn_deadline_exceeded') return COPY.turn_deadline_exceeded;
  if (reason === 'internal_error') return COPY.internal_error;
  return COPY.internal_error;
}
