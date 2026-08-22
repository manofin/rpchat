import type { SseEvent } from '../types';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
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
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          onEvent(JSON.parse(line.slice(5).trim()) as SseEvent);
        } catch {
          /* 잘못된 이벤트 무시 */
        }
      }
    }
  }
}

export const abortGeneration = (generationId: string) => post<{ ok: boolean }>(`/api/generations/${generationId}/abort`);
