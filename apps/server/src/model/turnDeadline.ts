/**
 * LOCK-TurnTotalDeadline: monotonic whole-turn deadline for beat + dialog.
 * 1:1 keeps model timeout only (out of scope).
 */

export const TURN_DEADLINE_FORCE_RELEASE_MS = 5_000;

export type TurnTerminationReason =
  | 'user_cancelled'
  | 'model_timeout'
  | 'turn_deadline_exceeded'
  | 'internal_error'
  | 'completed';

export type TurnDeadlineTelemetry = {
  accepted_at: string;
  deadline_ms: number;
  total_ms: number;
  termination: TurnTerminationReason | null;
  cancel_requested_at: string | null;
  queue_released_at: string | null;
  force_released_at: string | null;
  stage_ms?: Record<string, number>;
};

/** Distinct abort reason when the whole-turn deadline fires (or remaining-total cuts a call). */
export class TurnDeadlineError extends Error {
  readonly code = 'turn_deadline_exceeded' as const;
  constructor(message = '대기를 포함한 전체 처리 시간이 초과됐습니다.') {
    super(message);
    this.name = 'TurnDeadlineError';
  }
}

export class ModelTimeoutError extends Error {
  readonly code = 'model_timeout' as const;
  constructor(message = '모델 응답 시간이 초과됐습니다.') {
    super(message);
    this.name = 'ModelTimeoutError';
  }
}

export function isTurnDeadlineError(err: unknown): boolean {
  if (err instanceof TurnDeadlineError) return true;
  const e = err as { name?: string; code?: string } | null;
  return e?.name === 'TurnDeadlineError' || e?.code === 'turn_deadline_exceeded';
}

export function isModelTimeoutError(err: unknown): boolean {
  if (err instanceof ModelTimeoutError) return true;
  const e = err as { name?: string; code?: string; cause?: { name?: string } } | null;
  if (e?.name === 'ModelTimeoutError' || e?.code === 'model_timeout') return true;
  if (e?.name === 'TimeoutError' || e?.cause?.name === 'TimeoutError') return true;
  return /pass timeout/i.test(String((err as Error)?.message ?? ''));
}

export type TurnDeadlineOpts = {
  deadlineMs: number;
  controller: AbortController;
  /** Elapsed clock in ms. Defaults to Date.now() (mockable via mock.timers Date). */
  now?: () => number;
  /** Wall clock ISO for telemetry only. */
  wallIso?: () => string;
  onForceRelease?: () => void;
  forceReleaseMs?: number;
  log?: { warn: (obj: object, msg?: string) => void };
};

/**
 * Per-call timeout = min(configured, remaining total).
 * When remaining is the binding limit, the abort reason is TurnDeadlineError
 * (whole turn). When configured model/pass timeout is binding, ModelTimeoutError
 * (E/N/C may still skip locally when parent is not aborted).
 */
export function callDeadlineMs(configuredMs: number, remainingMs: number): {
  ms: number;
  kind: 'model' | 'turn';
} {
  const configured = Math.max(0, configuredMs);
  const remaining = Math.max(0, remainingMs);
  if (remaining <= configured) return { ms: remaining, kind: 'turn' };
  return { ms: configured, kind: 'model' };
}

export class TurnDeadline {
  readonly acceptedAtMono: number;
  readonly acceptedAtIso: string;
  readonly deadlineMs: number;
  private readonly now: () => number;
  private readonly wallIso: () => string;
  readonly controller: AbortController;
  private readonly onForceRelease?: () => void;
  private readonly forceReleaseMs: number;
  private readonly log?: TurnDeadlineOpts['log'];

  private terminal: TurnTerminationReason | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private forceTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  cancelRequestedAt: string | null = null;
  queueReleasedAt: string | null = null;
  forceReleasedAt: string | null = null;
  commitEnteredAt: string | null = null;

  constructor(opts: TurnDeadlineOpts) {
    this.deadlineMs = Math.max(0, opts.deadlineMs);
    this.controller = opts.controller;
    this.now = opts.now ?? (() => Date.now());
    this.wallIso = opts.wallIso ?? (() => new Date().toISOString());
    this.onForceRelease = opts.onForceRelease;
    this.forceReleaseMs = opts.forceReleaseMs ?? TURN_DEADLINE_FORCE_RELEASE_MS;
    this.log = opts.log;
    this.acceptedAtMono = this.now();
    this.acceptedAtIso = this.wallIso();
  }

  /** Arm the absolute deadline timer from accept/register. */
  start(): void {
    if (this.disposed || this.deadlineMs <= 0) {
      if (this.deadlineMs <= 0) this.tripDeadline();
      return;
    }
    this.timer = setTimeout(() => this.tripDeadline(), this.deadlineMs);
  }

  elapsedMs(): number {
    return Math.max(0, this.now() - this.acceptedAtMono);
  }

  remainingMs(): number {
    return Math.max(0, this.deadlineMs - this.elapsedMs());
  }

  get termination(): TurnTerminationReason | null {
    return this.terminal;
  }

  /** First terminal reason wins; later calls are ignored for the result. */
  recordTerminal(reason: TurnTerminationReason): boolean {
    if (this.terminal) return false;
    this.terminal = reason;
    return true;
  }

  noteUserCancel(): void {
    if (!this.cancelRequestedAt) this.cancelRequestedAt = this.wallIso();
    this.recordTerminal('user_cancelled');
    this.armForceRelease();
  }

  tripDeadline(): void {
    if (this.disposed) return;
    // Commit already accepted → ignore late deadline.
    if (this.terminal === 'completed') return;
    this.recordTerminal('turn_deadline_exceeded');
    if (!this.controller.signal.aborted) {
      this.controller.abort(new TurnDeadlineError());
    }
    this.armForceRelease();
  }

  /**
   * Sync commit gate: not turn-deadline-cancelled + scene version unchanged.
   * Head moves during our own multi-block turn, so stale detection uses scene
   * version (scene_json is only written on successful commit).
   * User cancel during Pass C may still commit (caller policy); deadline may not.
   * On pass, records `completed` so a later deadline is ignored.
   */
  tryEnterCommit(gate: {
    sceneVersionAtStart: number;
    currentSceneVersion: number;
  }): boolean {
    if (this.terminal === 'completed') return true;
    if (this.terminal === 'turn_deadline_exceeded') return false;
    if (isTurnDeadlineError(this.controller.signal.reason)) return false;
    if (gate.currentSceneVersion !== gate.sceneVersionAtStart) return false;
    this.recordTerminal('completed');
    this.commitEnteredAt = this.wallIso();
    this.clearDeadlineTimer();
    return true;
  }

  markQueueReleased(): void {
    if (!this.queueReleasedAt) this.queueReleasedAt = this.wallIso();
    this.clearForceTimer();
  }

  telemetry(stageMs?: Record<string, number>): TurnDeadlineTelemetry {
    return {
      accepted_at: this.acceptedAtIso,
      deadline_ms: this.deadlineMs,
      total_ms: Math.round(this.elapsedMs()),
      termination: this.terminal,
      cancel_requested_at: this.cancelRequestedAt,
      queue_released_at: this.queueReleasedAt,
      force_released_at: this.forceReleasedAt,
      ...(stageMs ? { stage_ms: stageMs } : {}),
    };
  }

  dispose(): void {
    this.disposed = true;
    this.clearDeadlineTimer();
    this.clearForceTimer();
  }

  private armForceRelease(): void {
    if (this.forceTimer || this.queueReleasedAt || this.disposed) return;
    this.forceTimer = setTimeout(() => {
      this.forceTimer = null;
      if (this.queueReleasedAt || this.disposed) return;
      this.forceReleasedAt = this.wallIso();
      this.log?.warn(
        {
          generation_force_queue_release: true,
          force_release_ms: this.forceReleaseMs,
          termination: this.terminal,
          accepted_at: this.acceptedAtIso,
        },
        'turn deadline: force-released queue slot after cancel grace',
      );
      try {
        this.onForceRelease?.();
      } catch (err) {
        this.log?.warn({ err }, 'turn deadline: onForceRelease failed');
      }
      if (!this.queueReleasedAt) this.queueReleasedAt = this.forceReleasedAt;
    }, this.forceReleaseMs);
  }

  private clearDeadlineTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private clearForceTimer(): void {
    if (this.forceTimer) {
      clearTimeout(this.forceTimer);
      this.forceTimer = null;
    }
  }
}

/**
 * Child deadline that follows parent abort and fires with model vs turn reason.
 */
export function withCallDeadline(
  configuredMs: number,
  remainingMs: number,
  parent: AbortSignal,
): { signal: AbortSignal; done: () => void; kind: 'model' | 'turn'; ms: number } {
  const { ms, kind } = callDeadlineMs(configuredMs, remainingMs);
  const ctrl = new AbortController();
  const reason = kind === 'turn' ? new TurnDeadlineError() : new ModelTimeoutError();
  const timer = setTimeout(() => ctrl.abort(reason), ms);
  const onAbort = () => ctrl.abort(parent.reason ?? parent);
  if (parent.aborted) ctrl.abort(parent.reason ?? parent);
  else parent.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctrl.signal,
    kind,
    ms,
    done: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', onAbort);
    },
  };
}
