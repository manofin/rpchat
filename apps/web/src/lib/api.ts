import type { SseEvent } from '../types';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

export class StreamInterruptedError extends Error {
  constructor() {
    super('응답 연결이 끊겨 저장된 대화를 다시 확인합니다.');
    this.name = 'StreamInterruptedError';
  }
}

/** true → keep composer empty (success, user abort, network drop). false → restore (HTTP fail after retract). */
export function sendOkForComposer(e: unknown, aborted: boolean): boolean {
  if (aborted) return true;
  if (e instanceof ApiError && e.status === 499) return true;
  return e instanceof ApiError ? false : true;
}

export const UNAUTHORIZED_EVENT = 'rpchat:unauthorized';

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
  });
  if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* 텍스트 그대로 */
  }
  if (!res.ok) {
    const msg = typeof body === 'object' && body && 'error' in body ? formatError((body as { error: unknown }).error) : `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, msg, body);
  }
  return body as T;
}

function formatError(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const fe = (e as { fieldErrors?: Record<string, string[]>; formErrors?: string[] });
    if (fe.fieldErrors) return Object.entries(fe.fieldErrors).map(([k, v]) => `${k}: ${v.join(', ')}`).join(' / ');
  }
  return JSON.stringify(e);
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
export const postBinary = <T>(path: string, body: Blob, contentType: string) =>
  api<T>(path, { method: 'POST', body, headers: { 'content-type': contentType } });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body: JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

/**
 * POST + SSE 스트림. EventSource 는 POST 를 못 쓰므로 fetch ReadableStream 으로 직접 파싱한다.
 * signal 로 fetch 를 끊어도 서버 생성은 계속되므로(백그라운드 대응), 사용자 '중단'은 abortGeneration() 을 먼저 호출한다.
 */
export async function streamPost(path: string, body: unknown, onEvent: (e: SseEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  if (!res.ok) {
    const text = await res.text();
    let msg = `${res.status}`;
    try {
      msg = formatError(JSON.parse(text).error);
    } catch {
      if (text) msg = text;
    }
    throw new ApiError(res.status, msg);
  }
  if (!res.body) throw new ApiError(500, '스트림 본문 없음');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let terminal = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buf))) {
        const chunk = buf.slice(0, boundary.index);
        buf = buf.slice(boundary.index + boundary[0].length);
        const data = chunk.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
        if (!data) continue;
        let event: SseEvent;
        try {
          event = JSON.parse(data) as SseEvent;
        } catch {
          continue;
        }
        if (event.type === 'start') terminal = false;
        if (event.type === 'done' || event.type === 'error') terminal = true;
        onEvent(event);
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!terminal) throw new StreamInterruptedError();
}

export const abortGeneration = (generationId: string) => post<{ ok: boolean }>(`/api/generations/${generationId}/abort`);
