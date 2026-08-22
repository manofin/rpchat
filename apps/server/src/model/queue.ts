export interface ActiveGeneration {
  id: string;
  conversationId: string;
  messageId: string;
  startedAt: string;
  controller: AbortController;
}

/**
 * 로컬 단일 모델 보호용 큐. 동시 생성 수는 기본 1, 대기 중 취소 가능.
 * 활성 생성 레지스트리도 함께 들고 있어 /generations/active 와 abort 엔드포인트가 참조한다.
 */
export class GenerationQueue {
  private running = 0;
  private waiting: Array<() => void> = [];
  private active = new Map<string, ActiveGeneration>();

  constructor(private readonly concurrency = 1) {}

  get queued(): number {
    return this.waiting.length;
  }
  get activeList(): ActiveGeneration[] {
    return [...this.active.values()];
  }
  register(g: ActiveGeneration): void {
    this.active.set(g.id, g);
  }
  unregister(id: string): void {
    this.active.delete(id);
  }
  abort(id: string): boolean {
    const g = this.active.get(id);
    if (!g) return false;
    g.controller.abort();
    return true;
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new Error('aborted before start');
    if (this.running >= this.concurrency) {
      await new Promise<void>((resolve, reject) => {
        const entry = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          this.waiting = this.waiting.filter((w) => w !== entry);
          reject(new Error('aborted while queued'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        this.waiting.push(entry);
      });
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      const next = this.waiting.shift();
      next?.();
    }
  }
}
