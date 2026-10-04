import type { ChatMessage } from '../types.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { dumpRequestBody } from './requestDump.js';

const CONNECTION_ERROR_CODES = new Set(['UND_ERR_SOCKET', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET', 'ETIMEDOUT']);

export interface GenParams {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  signal?: AbortSignal;
  generationId?: string;
  audience?:
    | { kind: 'public' }
    | { kind: 'actor'; actor_id: string; actor_name: string }
    | { kind: 'narrator' };
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

export interface GenResult {
  text: string;
  finishReason: string | null;
  usage: Usage | null;
  ttftMs: number | null;
  totalMs: number;
}

export class ModelError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = 'ModelError';
  }
}

/**
 * 앱이 보는 유일한 모델 인터페이스. OpenAI 호환 /v1/chat/completions 스트리밍만 사용한다.
 * 런타임(mlx-openai-server, vllm, Ollama, llama.cpp server 등)을 바꿔도 이 파일만 조정하면 된다.
 */
export class ModelClient {
  private previousCallFinishedAt: number | null = null;
  private readonly callKind = new AsyncLocalStorage<'complete'>();
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
    private readonly dataDir: string,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream' };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async listModels(timeoutMs = 3000): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/models`, { headers: this.headers(), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new ModelError(`GET /models → ${res.status}`, res.status);
    const j = (await res.json()) as { data?: Array<{ id: string }> };
    return (j.data ?? []).map((m) => m.id);
  }

  async stream(p: GenParams, onToken: (delta: string) => void): Promise<GenResult> {
    return this.generate(p, onToken, this.callKind.getStore() ?? 'stream');
  }

  private transportCode(error: unknown): string {
    const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
    return typeof cause === 'string' && /^[A-Z0-9_]{1,64}$/.test(cause) ? cause : 'UNKNOWN';
  }

  private async generate(p: GenParams, onToken: (delta: string) => void, kind: 'stream' | 'complete'): Promise<GenResult> {
    const signals: AbortSignal[] = [AbortSignal.timeout(this.timeoutMs)];
    if (p.signal) signals.push(p.signal);
    const state = {
      signal: AbortSignal.any(signals),
      retries: 0,
      retryCode: '',
      sincePreviousCallMs: this.previousCallFinishedAt === null ? null : Math.max(0, Date.now() - this.previousCallFinishedAt),
    };
    try {
      const result = await this.streamRequest(p, onToken, state);
      if (state.retries) {
        console.warn('model-transport', { outcome: 'recovered', kind, code: state.retryCode, retries: state.retries, sincePreviousCallMs: state.sincePreviousCallMs });
      }
      return result;
    } catch (error) {
      const code = this.transportCode(error);
      const outcome = state.signal.aborted ? 'aborted' : error instanceof ModelError ? 'http-error'
        : CONNECTION_ERROR_CODES.has(code) ? 'final-failure' : 'other-error';
      const reasonName = state.signal.reason?.name;
      console.warn('model-transport', {
        outcome, kind, code, retries: state.retries, sincePreviousCallMs: state.sincePreviousCallMs,
        ...(outcome === 'aborted' ? { reasonName: reasonName === 'AbortError' || reasonName === 'TimeoutError' ? reasonName : 'UNKNOWN' } : {}),
        ...(outcome === 'http-error' ? { status: (error as ModelError).status } : {}),
      });
      throw error;
    } finally {
      this.previousCallFinishedAt = Date.now();
    }
  }

  private async streamRequest(p: GenParams, onToken: (delta: string) => void, state: { signal: AbortSignal; retries: number; retryCode: string }): Promise<GenResult> {
    const started = Date.now();
    const signal = state.signal;
    signal.throwIfAborted();

    const body: Record<string, unknown> = {
      model: p.model,
      messages: p.messages,
      temperature: p.temperature,
      top_p: p.top_p,
      max_tokens: p.max_tokens,
      stream: true,
      stream_options: { include_usage: true },
      // Gemma/llama.cpp: reasoning 토큰이 delta.reasoning_content 로만 흐르고
      // max_tokens 를 채워 content 가 빈 채로 length 마감되는 것을 막는다.
      chat_template_kwargs: { enable_thinking: false },
    };
    if (p.stop && p.stop.length > 0) body.stop = p.stop;

    if (p.generationId) {
      dumpRequestBody({
        dataDir: this.dataDir,
        generationId: p.generationId,
        createdAt: new Date().toISOString(),
        url: `${this.baseUrl}/chat/completions`,
        body,
      });
    }

    const request: RequestInit = {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    };
    let res: Response;
    for (;;) {
      signal.throwIfAborted();
      try {
        res = await fetch(`${this.baseUrl}/chat/completions`, request);
        break;
      } catch (error) {
        const code = this.transportCode(error);
        // No Response is a practical boundary, not proof the server did no inference.
        if (state.retries || signal.aborted || !(error instanceof TypeError) || error.message !== 'fetch failed'
          || !CONNECTION_ERROR_CODES.has(code)) throw error;
        state.retries = 1;
        state.retryCode = code;
      }
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new ModelError(`모델 서버 응답 ${res.status}: ${detail.slice(0, 500)}`, res.status);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let text = '';
    let finish: string | null = null;
    let usage: Usage | null = null;
    let ttft: number | null = null;

    const handleLine = (line: string) => {
      if (!line.startsWith('data:')) return; // 주석(: ping) 등 무시
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let j: any;
      try {
        j = JSON.parse(data);
      } catch {
        return;
      }
      if (j.usage && typeof j.usage === 'object') usage = j.usage as Usage;
      const ch = j.choices?.[0];
      if (!ch) return;
      const delta: string = ch.delta?.content ?? ch.text ?? '';
      if (delta) {
        if (ttft === null) ttft = Date.now() - started;
        text += delta;
        onToken(delta);
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          handleLine(line);
        }
      }
      if (buf.trim()) handleLine(buf.trim());
    } finally {
      reader.releaseLock();
    }
    return { text, finishReason: finish, usage, ttftMs: ttft, totalMs: Date.now() - started };
  }

  /** 비스트리밍 편의 함수 (요약·기억 추출용) */
  async complete(p: GenParams): Promise<GenResult> {
    return this.callKind.run('complete', () => {
      return this.stream(p, () => {});
    });
  }
}
