/**
 * Poll GET {serve}/api/generations/active.
 * Tag every sample with the local clock (t_poll). Do not use server startedAt for overlap.
 */
import type { ActiveSample } from './types.ts';

export type ActivePollerOpts = {
  serveBase: string;
  conversationId: string;
  intervalMs: number;
  headers?: Record<string, string>;
};

export function startActivePoller(opts: ActivePollerOpts): {
  samples: ActiveSample[];
  stop: () => ActiveSample[];
} {
  const samples: ActiveSample[] = [];
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    const t_poll = Date.now();
    try {
      const res = await fetch(`${opts.serveBase.replace(/\/$/, '')}/api/generations/active`, {
        headers: opts.headers,
        signal: AbortSignal.timeout(5000),
      });
      const body = (await res.json()) as {
        active?: Array<{ id?: string; conversationId?: string }>;
        queued?: number;
      };
      const active = Array.isArray(body.active) ? body.active : [];
      const ours = active.filter((a) => a.conversationId === opts.conversationId);
      samples.push({
        t_poll,
        our_active: ours.length > 0,
        active_ids: ours.map((a) => String(a.id ?? '')).filter(Boolean),
        queued: typeof body.queued === 'number' ? body.queued : 0,
        http_status: res.status,
        error: res.ok ? null : `http ${res.status}`,
      });
    } catch (e) {
      samples.push({
        t_poll,
        our_active: false,
        active_ids: [],
        queued: 0,
        http_status: null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, opts.intervalMs);
  void tick();

  return {
    samples,
    stop: () => {
      stopped = true;
      clearInterval(handle);
      return samples;
    },
  };
}

export async function readActiveOnce(serveBase: string, headers?: Record<string, string>): Promise<{
  active: Array<{ id: string; conversationId: string; messageId?: string; startedAt?: number }>;
  queued: number;
  http_status: number;
}> {
  const res = await fetch(`${serveBase.replace(/\/$/, '')}/api/generations/active`, {
    headers,
    signal: AbortSignal.timeout(5000),
  });
  const body = (await res.json()) as { active?: unknown; queued?: unknown };
  const active = Array.isArray(body.active) ? body.active : [];
  return {
    http_status: res.status,
    queued: typeof body.queued === 'number' ? body.queued : 0,
    active: active as Array<{ id: string; conversationId: string; messageId?: string; startedAt?: number }>,
  };
}
