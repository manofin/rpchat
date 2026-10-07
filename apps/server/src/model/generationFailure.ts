export type GenerationFailureCode = 'connection' | 'timeout' | 'validation' | 'generation';

export class PrivateValidationError extends Error {
  constructor() { super('비공개 내용 확인에 실패했습니다. 다시 시도해 주세요.'); this.name = 'PrivateValidationError'; }
}

export function generationFailure(error: unknown): { code: GenerationFailureCode; message: string } {
  const e = error as { name?: string; cause?: { code?: string; name?: string } } | null;
  if (error instanceof PrivateValidationError) return { code: 'validation', message: error.message };
  if (e?.name === 'TimeoutError' || e?.cause?.name === 'TimeoutError') return { code: 'timeout', message: '모델 응답 시간이 초과됐습니다. 다시 시도해 주세요.' };
  if (/^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(e?.cause?.code ?? '')) {
    return { code: 'connection', message: '모델 서버에 연결하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.' };
  }
  return { code: 'generation', message: '이야기를 생성하지 못했습니다. 다시 시도해 주세요.' };
}
