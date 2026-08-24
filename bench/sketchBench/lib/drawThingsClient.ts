/**
 * Draw Things client — PLACEHOLDER until Task 1 locks the real port/body.
 * Compatible with a stub A1111-shaped POST /sdapi/v1/txt2img (used for pre-Task1 smoke).
 * Real endpoint/body must be replaced after Draw Things API contract is observed.
 *
 * Unset DRAW_THINGS_BASE_URL → fail loudly. Do not invent a port.
 */
export type DrawThingsResult = {
  t_start: number;
  t_end: number;
  ok: boolean;
  http_status: number | null;
  error: string | null;
  latency_ms: number;
};

export function requireDrawThingsBase(): string {
  const raw = process.env.DRAW_THINGS_BASE_URL;
  if (!raw || !raw.trim()) {
    throw new Error('DRAW_THINGS_BASE_URL unset — Task 1 must set the real base, or point at a stub (e.g. http://127.0.0.1:9999)');
  }
  return raw.replace(/\/$/, '');
}

/** A1111-shaped body. Task 1 may replace this entirely. */
export function placeholderTxt2ImgBody(prompt: string): Record<string, unknown> {
  return {
    prompt,
    negative_prompt: '',
    steps: 4,
    width: 512,
    height: 512,
    cfg_scale: 1,
    sampler_name: 'Euler a',
  };
}

export async function generateImage(opts: {
  baseUrl?: string;
  prompt: string;
  timeoutMs?: number;
}): Promise<DrawThingsResult> {
  const base = opts.baseUrl ?? requireDrawThingsBase();
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const t_start = Date.now();
  try {
    const res = await fetch(`${base}/sdapi/v1/txt2img`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(placeholderTxt2ImgBody(opts.prompt)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const t_end = Date.now();
    let ok = res.ok;
    let error: string | null = res.ok ? null : `http ${res.status}`;
    if (res.ok) {
      try {
        const body = (await res.json()) as { images?: unknown; error?: unknown };
        if (body && typeof body === 'object' && body.error) {
          ok = false;
          error = String(body.error);
        } else if (body && 'images' in body && !Array.isArray(body.images)) {
          ok = false;
          error = 'response missing images[]';
        }
      } catch (e) {
        ok = false;
        error = e instanceof Error ? e.message : String(e);
      }
    } else {
      await res.text().catch(() => '');
    }
    return { t_start, t_end, ok, http_status: res.status, error, latency_ms: t_end - t_start };
  } catch (e) {
    const t_end = Date.now();
    return {
      t_start,
      t_end,
      ok: false,
      http_status: null,
      error: e instanceof Error ? e.message : String(e),
      latency_ms: t_end - t_start,
    };
  }
}

export async function smokeOnce(baseUrl?: string): Promise<DrawThingsResult> {
  return generateImage({ baseUrl, prompt: 'sketchBench smoke placeholder', timeoutMs: 15_000 });
}
