export type GenerationPhase = 'queued' | 'writing' | 'validating';
export interface ActiveGeneration {
  id: string;
  kind?: 'chat' | 'ending-judge' | 'side-mode';
  conversationId: string;
  messageId: string;
  startedAt: string;
  controller: AbortController;
  phase?: GenerationPhase;
  /** Optional turn-total deadline (beat/dialog). */
  turnDeadline?: import('./turnDeadline.js').TurnDeadline;
}

/**
 * 로컬 단일 모델 보호용 큐. 동시 생성 수는 기본 1, 대기 중 취소 가능.
 * 활성 생성 레지스트리도 함께 들고 있어 /generations/active 와 abort 엔드포인트가 참조한다.
 */
export class GenerationQueue {
  private running = 0;
  private waiting: Array<() => void> = [];
  private active = new Map<string, ActiveGeneration>();
  /** Early slot release hooks for in-flight run() calls (force-release ≤5s). */
  private slotReleasers = new Map<string, () => void>();

  private listeners = new Map<string, (generation: ActiveGeneration) => void>();

  constructor(private readonly concurrency = 1) {}

  get queued(): number {
    return this.waiting.length;
  }
  get activeList(): ActiveGeneration[] {
    return [...this.active.values()];
  }
  register(g: ActiveGeneration): void {
    this.active.set(g.id, { ...g, phase: g.phase ?? 'queued' });
  }
  setMessageId(id: string, messageId: string): void {
    const generation = this.active.get(id);
    if (!generation) throw new Error(`generation not active: ${id}`);
    generation.messageId = messageId;
  }
  setTurnDeadline(id: string, turnDeadline: NonNullable<ActiveGeneration['turnDeadline']>): void {
    const generation = this.active.get(id);
    if (!generation) return;
    generation.turnDeadline = turnDeadline;
  }
  watchProgress(id: string, listener: (generation: ActiveGeneration) => void): void {
    this.listeners.set(id, listener);
    const generation = this.active.get(id);
    if (generation) listener(generation);
  }
  setPhase(id: string, phase: GenerationPhase): void {
    const generation = this.active.get(id);
    if (!generation) return;
    generation.phase = phase;
    this.listeners.get(id)?.(generation);
  }
  async runGeneration<T>(id: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.setPhase(id, 'queued');
    return this.run(() => { this.setPhase(id, 'writing'); return fn(); }, signal, id);
  }
  unregister(id: string): void {
    const g = this.active.get(id);
    g?.turnDeadline?.markQueueReleased();
    this.listeners.delete(id);
    this.active.delete(id);
    // If still holding the run slot (hang after abort), free it.
    this.releaseSlot(id);
  }
  /**
   * Force-remove from the active registry and free the concurrency slot even if
   * the cancelled model call has not returned yet. Used after the 5s grace.
   */
  forceRelease(id: string): boolean {
    const had = this.active.has(id) || this.slotReleasers.has(id);
    this.unregister(id);
    return had;
  }
  abort(id: string): boolean {
    const g = this.active.get(id);
    if (!g) return false;
    g.turnDeadline?.noteUserCancel();
    g.controller.abort();
    return true;
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal, slotId?: string): Promise<T> {
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
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (slotId) this.slotReleasers.delete(slotId);
      this.running--;
      const next = this.waiting.shift();
      next?.();
    };
    if (slotId) this.slotReleasers.set(slotId, release);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private releaseSlot(id: string): void {
    const release = this.slotReleasers.get(id);
    if (release) release();
  }
}
