import type { GenResult } from './adapter.js';

export type CallStatus = 'ok' | 'error' | 'aborted' | 'deadline' | 'skipped';
export type CallMetric = {
  call_id: string; started_at_ms: number; ended_at_ms: number | null;
  queue_wait_ms: null; ttft_ms: number | null;
  usage_prompt_tokens: number | null; usage_completion_tokens: number | null;
  est_prompt_tokens: number | null; max_tokens: number;
  status: CallStatus; finish_reason: string | null;
};
let creations = 0;
export function partyMetricsCreationCount(): number { return creations; }

export class PartyMetrics {
  private readonly calls: CallMetric[] = [];
  private firstOutput: number | null = null;
  constructor(private readonly acceptedAt: string, private readonly elapsed: () => number) { creations++; }

  start(id: string, estimate: number, maxTokens: number): CallMetric {
    const count = this.calls.filter(c => c.call_id === id || c.call_id.startsWith(id + ':')).length;
    const call: CallMetric = {
      call_id: count ? `${id}:${count + 1}` : id, started_at_ms: this.elapsed(), ended_at_ms: null,
      queue_wait_ms: null, ttft_ms: null, usage_prompt_tokens: null, usage_completion_tokens: null,
      est_prompt_tokens: estimate, max_tokens: maxTokens, status: 'error', finish_reason: null,
    };
    this.calls.push(call);
    return call;
  }

  end(call: CallMetric, result: GenResult): void {
    // A late result must not rewrite an already sealed cancellation record.
    if (call.ended_at_ms !== null) return;
    call.ended_at_ms = this.elapsed();
    call.ttft_ms = result.ttftMs;
    call.usage_prompt_tokens = result.usage?.prompt_tokens ?? null;
    call.usage_completion_tokens = result.usage?.completion_tokens ?? null;
    call.status = 'ok';
    call.finish_reason = result.finishReason;
  }

  fail(call: CallMetric, status: CallStatus): void {
    if (call.ended_at_ms !== null) return;
    call.ended_at_ms = this.elapsed();
    call.status = status;
  }

  output(): void { if (this.firstOutput === null) this.firstOutput = this.elapsed(); }

  finish(termination: string) {
    const complete = this.elapsed();
    const status: CallStatus = termination === 'turn_deadline_exceeded' ? 'deadline'
      : termination === 'user_cancelled' ? 'aborted' : 'error';
    for (const call of this.calls) {
      if (call.ended_at_ms === null) { call.ended_at_ms = complete; call.status = status; }
    }
    const tokens = this.calls.filter(c => c.ttft_ms !== null).map(c => c.started_at_ms + c.ttft_ms!);
    const sum = (key: 'usage_prompt_tokens' | 'usage_completion_tokens' | 'est_prompt_tokens') => ({
      partial_sum: this.calls.reduce((n, c) => n + (c[key] ?? 0), 0),
      missing_count: this.calls.filter(c => c[key] === null).length,
    });
    return {
      version: 1, accepted_at: this.acceptedAt,
      first_model_token_ms: tokens.length ? Math.min(...tokens) : null,
      first_output_ms: this.firstOutput, turn_complete_ms: complete, termination,
      calls: this.calls.map(c => ({ ...c })),
      totals: { usage_prompt_tokens: sum('usage_prompt_tokens'), usage_completion_tokens: sum('usage_completion_tokens'), est_prompt_tokens: sum('est_prompt_tokens') },
    };
  }
}
