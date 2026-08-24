/**
 * Task 3 chat loop. Same isolated-character contract as Task 2.
 * Default path is Tailscale Serve (no manual header). Optional extra headers via env.
 */
import type { ChatRow } from './types.ts';

export const CHARACTER_ID = 'a5073af0-14b3-4c3f-8750-04d76b547504';

export const LINES = [
  '문을 열고 안으로 들어선다', '주변을 천천히 둘러본다', '조용히 숨을 고른다',
  '창밖을 바라본다', '손에 든 물건을 살핀다', '발걸음을 옮긴다',
  '깊게 숨을 들이쉰다', '고개를 돌려 반응을 본다', '한 걸음 다가선다',
  '잠시 멈춰 생각한다', '주머니를 뒤진다', '의자에 앉는다',
  '벽에 기댄다', '작게 웃는다', '고개를 끄덕인다',
  '눈을 감았다 뜬다', '팔짱을 낀다', '뒤로 물러난다',
  '손을 내민다', '조용히 지켜본다',
];

export type ExtraHeaders = Record<string, string>;

/**
 * `json` defaults true (POST calls send a JSON body). DELETE has no body — sending
 * Content-Type: application/json anyway trips Fastify's default JSON parser
 * (FST_ERR_CTP_EMPTY_JSON_BODY, empty body + json content-type -> 400), so
 * deleteConv() must call this with `{ json: false }`.
 */
export function serveHeaders(extra?: ExtraHeaders, opts?: { json?: boolean }): Record<string, string> {
  const h: Record<string, string> = {};
  if (opts?.json ?? true) h['Content-Type'] = 'application/json';
  const login = process.env.TAILSCALE_USER_LOGIN;
  if (login) h['Tailscale-User-Login'] = login;
  if (extra) Object.assign(h, extra);
  return h;
}

/**
 * conv id gets shelled out to hermes via SSH in run-concurrent.ts's queryLog();
 * refuse anything that isn't a UUID so a compromised/buggy server response can
 * never reach a remote shell command string.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createIsolatedConv(serveBase: string, title: string, headers?: ExtraHeaders): Promise<string> {
  const res = await fetch(`${serveBase.replace(/\/$/, '')}/api/conversations`, {
    method: 'POST',
    headers: serveHeaders(headers),
    body: JSON.stringify({ characterId: CHARACTER_ID, mode: 'chat', title }),
    signal: AbortSignal.timeout(15000),
  });
  const body = (await res.json()) as { id?: string; error?: string };
  if (!res.ok || !body.id) {
    throw new Error(`create conversation failed: http ${res.status} ${JSON.stringify(body)}`);
  }
  if (!UUID_RE.test(body.id)) {
    throw new Error(`conversation id failed UUID validation, refusing to interpolate into remote shell command: ${JSON.stringify(body.id)}`);
  }
  return body.id;
}

export async function deleteConv(serveBase: string, convId: string, headers?: ExtraHeaders): Promise<void> {
  const res = await fetch(`${serveBase.replace(/\/$/, '')}/api/conversations/${convId}`, {
    method: 'DELETE',
    headers: serveHeaders(headers, { json: false }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`delete conversation failed: http ${res.status}`);
  }
}

export async function sendChatTurn(
  serveBase: string,
  convId: string,
  content: string,
  headers?: ExtraHeaders,
): Promise<{ t_sent: number; t_done: number; http_status: number }> {
  const t_sent = Date.now();
  const res = await fetch(`${serveBase.replace(/\/$/, '')}/api/conversations/${convId}/messages`, {
    method: 'POST',
    headers: serveHeaders(headers),
    body: JSON.stringify({ content }),
  });
  const reader = res.body?.getReader();
  if (reader) {
    while (!(await reader.read()).done) {
      /* drain SSE; TTFT comes from generation_log */
    }
  }
  return { t_sent, t_done: Date.now(), http_status: res.status };
}

export async function runChatLoop(opts: {
  serveBase: string;
  convId: string;
  n: number;
  headers?: ExtraHeaders;
  onTurn?: (i: number, t_sent: number, t_done: number, http_status: number) => void;
}): Promise<Array<Pick<ChatRow, 'i' | 't_sent' | 't_done' | 'status'>>> {
  const rows: Array<Pick<ChatRow, 'i' | 't_sent' | 't_done' | 'status'>> = [];
  for (let i = 0; i < opts.n; i++) {
    const r = await sendChatTurn(opts.serveBase, opts.convId, LINES[i % LINES.length], opts.headers);
    const status = r.http_status >= 200 && r.http_status < 300 ? 'http_ok' : `http_${r.http_status}`;
    rows.push({ i, t_sent: r.t_sent, t_done: r.t_done, status });
    opts.onTurn?.(i, r.t_sent, r.t_done, r.http_status);
  }
  return rows;
}
