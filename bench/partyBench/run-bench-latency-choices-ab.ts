/**
 * Bench-Latency, choices A/B —
 *   `npx tsx bench/partyBench/run-bench-latency-choices-ab.ts`
 *
 * optimize-beat-choices-latency. Two contracts, one fixture, one session:
 *
 *   A  STORY_CHOICES_INSTRUCTION   the fdedff1 baseline (1문장+ 묘사 + 3문장+ 대사)
 *   B  BEAT_CHOICES_INSTRUCTION    the candidate (묘사 한 조각 + 한 문장, 50자)
 *
 * Both go through `choicesPrompt`, so the wrapper, the transcript and the turn
 * fixture are identical and the difference is attributable to the contract.
 * `max_tokens` is 400 on both arms — the production cap (160) is a safety net
 * on the shipped path, not a variable in this comparison.
 *
 * The arms are INTERLEAVED, not run back to back. The sealed mix and the Pass C
 * mix were measured as two sequential runs, which is fine for a 74% effect and
 * useless for the smaller one being chased here: a model server that drifts even
 * slightly between minute 5 and minute 20 shows up entirely in the second arm.
 * Alternating A,B,A,B costs nothing and makes drift common-mode.
 *
 * Only the Pass C call is measured. delta/N/F/E are identical in both arms by
 * construction, so paying for them 100 more times would buy noise, not signal —
 * the turn totals are reported by composing the measured C against the sealed
 * mix's own measured non-C cost, and that composition is stated in the output
 * rather than hidden.
 *
 * Env: MODEL_BASE_URL, MODEL_NAME, [MODEL_API_KEY], [MODEL_TIMEOUT_MS], [AB_N].
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BEAT_CHOICES_INSTRUCTION, choicesPrompt } from '../../apps/server/src/prompt/beatChoices.ts';
import { STORY_CHOICES_INSTRUCTION } from '../../apps/server/src/prompt/templates.ts';

const QUEUE_DEPTH = 1;
const dir = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.join(dir, 'results');

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
type CallRow = {
  pass: string;
  ok: boolean;
  ms: number;
  ttft_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  finish: string | null;
  text_len: number;
  /** Kept, unlike the other runners: the A/B needs to parse and measure the draft
   *  text, and it doubles as the evidence for what the shorter contract reads like. */
  text: string;
  error: string | null;
};

function env(name: string): string { return process.env[name] ?? ''; }
function requiredEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`벤치 무효: missing ${name}`);
  return v;
}

async function streamComplete(args: {
  pass: string;
  baseUrl: string; apiKey: string; model: string;
  messages: ChatMessage[];
  temperature: number; top_p: number; max_tokens: number; timeoutMs: number;
}): Promise<CallRow> {
  const started = Date.now();
  let ttft: number | null = null;
  const url = `${args.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream' };
  if (args.apiKey) headers.authorization = `Bearer ${args.apiKey}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), args.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      signal: ctrl.signal,
      body: JSON.stringify({
        model: args.model,
        messages: args.messages,
        temperature: args.temperature,
        top_p: args.top_p,
        max_tokens: args.max_tokens,
        stream: true,
        stream_options: { include_usage: true },
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    if (!res.ok || !res.body) throw new Error(`http ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let text = '';
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;
    let finish: string | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const delta = j.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) {
            if (ttft === null) ttft = Date.now() - started;
            text += delta;
          }
          if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
          if (j.usage) {
            promptTokens = j.usage.prompt_tokens ?? promptTokens;
            completionTokens = j.usage.completion_tokens ?? completionTokens;
          }
        } catch { /* keep reading */ }
      }
    }
    return {
      pass: args.pass, ok: true, ms: Date.now() - started, ttft_ms: ttft,
      prompt_tokens: promptTokens, completion_tokens: completionTokens,
      finish, text_len: text.length, text, error: null,
    };
  } catch (e) {
    return {
      pass: args.pass, ok: false, ms: Date.now() - started, ttft_ms: ttft,
      prompt_tokens: null, completion_tokens: null, finish: null, text_len: 0, text: '',
      error: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300),
    };
  } finally {
    clearTimeout(timer);
  }
}


const CARD_JIWOO = { name: '지우', personality: '무뚝뚝하다', speech_style: '짧게 말한다' };
const CARD_SEOLHWA = { name: '설화', personality: '수다스럽다' };

const USER_TEXT = '민아, 등록 절차가 어떻게 되나요?';
const NARRATION = '접수대 앞에서 사람들이 줄지어 서 있다. 설화가 흘끗 이쪽을 본다.';
const FOCUS_TEXT = '"신분증부터 보여주시겠어요?" 민아가 서류를 정리하며 고개를 들었다.';

function writeJson(p: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

const BLOCKS = (extras: number) => [
  { kind: 'narration', text: NARRATION },
  { kind: 'line', speaker_name: '민아', text: FOCUS_TEXT },
  { kind: 'thought', speaker_name: '민아', text: '오늘은 줄이 길겠네.' },
  ...[CARD_JIWOO, CARD_SEOLHWA].slice(0, extras).map((c, i) => ({
    kind: 'line', speaker_name: c.name,
    text: `"${['보안', '안내'][i]} 쪽은 제가 봅니다." ${c.name}이 한 걸음 다가섰다.`,
  })),
];

type Arm = 'A_long' | 'B_short';
const INSTRUCTION: Record<Arm, string> = {
  A_long: STORY_CHOICES_INSTRUCTION,
  B_short: BEAT_CHOICES_INSTRUCTION,
};
const ARMS: Arm[] = ['A_long', 'B_short'];

/** Published n=50 of the long-form mix, same model, same host.
 *  `bench/partyBench/results/beat-choices-2026-09-05T07-32-23-602Z.json`
 *  and the sealed no-C mix cited in fdedff1. Composition is stated, not hidden. */
const PUBLISHED = {
  sealed_no_c_p50_s: 9.98,
  with_c_p50_s: 17.32,
  with_c_p95_s: 25.327,
  pass_c_p50_s: 8.156,
};

/** Same shape `parseChoicesPass` enforces in production, inlined so the bench
 *  measures parse success without importing the route. */
function parses(text: string): string[] | null {
  const m = text.trim().match(/<choices>\s*(\[[\s\S]*?\])\s*<\/choices>\s*$/i);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[1]);
    if (!Array.isArray(arr)) return null;
    const out = arr.map((x) => String(x).trim()).filter(Boolean).slice(0, 3);
    return out.length ? out : null;
  } catch { return null; }
}

type AbRow = {
  i: number; arm: Arm; extras: number; call: CallRow;
  parsed: number | null; draft_chars: number[] | null;
};

function pct(v: number[], p: number): number {
  const s = [...v].sort((a, b) => a - b);
  if (!s.length) return 0;
  const k = (s.length - 1) * p / 100;
  const f = Math.floor(k); const c = Math.ceil(k);
  return f === c ? s[f] : s[f] + (s[c] - s[f]) * (k - f);
}

function summarize(rows: AbRow[], arm: Arm) {
  const mine = rows.filter((r) => r.arm === arm && r.call.ok);
  const ms = mine.map((r) => r.call.ms / 1000);
  const out = mine.map((r) => r.call.completion_tokens ?? 0);
  const inp = mine.map((r) => r.call.prompt_tokens ?? 0);
  const chars = mine.flatMap((r) => r.draft_chars ?? []);
  return {
    n: mine.length,
    p50_s: +pct(ms, 50).toFixed(3),
    p95_s: +pct(ms, 95).toFixed(3),
    max_s: +Math.max(...ms, 0).toFixed(3),
    in_tokens_p50: Math.round(pct(inp, 50)),
    out_tokens_p50: Math.round(pct(out, 50)),
    out_tokens_p95: Math.round(pct(out, 95)),
    out_tokens_max: Math.max(...out, 0),
    parse_ok: mine.filter((r) => r.parsed !== null).length,
    parse_fail: mine.filter((r) => r.parsed === null).length,
    truncated: mine.filter((r) => r.call.finish === 'length').length,
    draft_chars_p50: Math.round(pct(chars, 50)),
    draft_chars_p95: Math.round(pct(chars, 95)),
  };
}

async function main() {
  const baseUrl = requiredEnv('MODEL_BASE_URL');
  const model = requiredEnv('MODEL_NAME');
  const apiKey = env('MODEL_API_KEY');
  const timeoutMs = Number(env('MODEL_TIMEOUT_MS') || '180000');
  const n = Number(env('AB_N') || '50');
  const cfg = { baseUrl, apiKey, model, timeoutMs };

  const startedAt = new Date().toISOString();
  const runId = startedAt.replace(/[:.]/g, '-');
  const outPath = path.join(resultsDir, `choices-ab-${runId}.json`);
  const partialPath = path.join(resultsDir, `choices-ab-${runId}.partial.json`);
  const meta = {
    token: 'optimize-beat-choices-latency',
    bench: 'Bench-Latency (Pass C contract A/B, interleaved)',
    base_commit: 'fdedff1',
    queue_depth: QUEUE_DEPTH,
    live_db: 0,
    live_messages_post: 0,
    apps_product_code_changed: 1,
    measures: 'Pass C only; delta/N/F/E are identical across arms by construction',
    prompts_from: 'apps/server/src/prompt/beatChoices.ts (choicesPrompt, both arms)',
    published_baseline: PUBLISHED,
    model_name: model,
    model_base_url: baseUrl,
    n_target_per_arm: n,
    started_at: startedAt,
  };
  writeJson(partialPath, { ...meta, status: 'running', rows: [] });

  const rows: AbRow[] = [];
  for (let i = 0; i < n; i++) {
    const extras = i % 5 === 4 ? 2 : 0;
    // Alternate which arm goes first as well, so neither one always pays for a
    // cold cache at the top of a pair.
    // Rotate the order so no arm always pays for the top of a group.
    const order: Arm[] = ARMS.map((_, k) => ARMS[(k + i) % ARMS.length]);
    for (const arm of order) {
      const call = await streamComplete({
        ...cfg, pass: arm,
        messages: [{ role: 'user', content: choicesPrompt(
          { userName: '사용자', userText: USER_TEXT, blocks: BLOCKS(extras) },
          INSTRUCTION[arm],
        ) }],
        temperature: 0.9, top_p: 0.95, max_tokens: 400,
      });
      if (!call.ok) {
        writeJson(outPath, { ...meta, status: 'invalid', reason: 'endpoint_or_call_failure', rows });
        console.error('벤치 무효: call failure at', i, arm, call.error);
        process.exit(2);
      }
      const parsed = parses(call.text);
      rows.push({
        i, arm, extras, call,
        parsed: parsed ? parsed.length : null,
        draft_chars: parsed ? parsed.map((d) => d.length) : null,
      });
    }
    writeJson(partialPath, { ...meta, status: 'running', rows });
    const group = rows.slice(-ARMS.length);
    console.log(`group ${i + 1}/${n} extras=${extras}  ` + group.map((r) => `${r.arm}=${(r.call.ms / 1000).toFixed(1)}s`).join('  '));
  }

  const A = summarize(rows, 'A_long');
  const B = summarize(rows, 'B_short');
  const vsA = (x: ReturnType<typeof summarize>) => ({
    pass_c_p50_s: +(x.p50_s - A.p50_s).toFixed(3),
    pass_c_p50_pct: +(100 * (x.p50_s / A.p50_s - 1)).toFixed(1),
    pass_c_p95_s: +(x.p95_s - A.p95_s).toFixed(3),
    out_tokens_p50: x.out_tokens_p50 - A.out_tokens_p50,
  });
  const compose = (c: ReturnType<typeof summarize>) => ({
    from_sealed_no_c_p50_s: +(PUBLISHED.sealed_no_c_p50_s + c.p50_s).toFixed(3),
    from_with_c_p50_s: +(PUBLISHED.with_c_p50_s - PUBLISHED.pass_c_p50_s + c.p50_s).toFixed(3),
    vs_sealed_pct: +(100 * ((PUBLISHED.sealed_no_c_p50_s + c.p50_s) / PUBLISHED.sealed_no_c_p50_s - 1)).toFixed(1),
  });
  const result = {
    ...meta, status: 'complete', finished_at: new Date().toISOString(),
    A_long: A, B_short: B,
    delta_vs_A: { B_short: vsA(B) },
    composed_turn: { A_long: compose(A), B_short: compose(B) },
    rows,
  };
  writeJson(outPath, result);
  fs.rmSync(partialPath, { force: true });
  for (const [name, x] of [['A_long', A], ['B_short', B]] as const) {
    console.log(`${name.padEnd(8)} p50=${x.p50_s}s p95=${x.p95_s}s out_p50=${x.out_tokens_p50} out_p95=${x.out_tokens_p95} parse_ok=${x.parse_ok}/${x.n} trunc=${x.truncated} chars_p50=${x.draft_chars_p50} chars_p95=${x.draft_chars_p95}`);
  }
  console.log(`delta vs A_long: B_short ${result.delta_vs_A.B_short.pass_c_p50_s}s (${result.delta_vs_A.B_short.pass_c_p50_pct}%)`);
  console.log(`composed turn p50 from sealed 9.98: A=${result.composed_turn.A_long.from_sealed_no_c_p50_s}s B=${result.composed_turn.B_short.from_sealed_no_c_p50_s}s (B vs sealed ${result.composed_turn.B_short.vs_sealed_pct}%)`);
  console.log(outPath);
}

main().catch((err) => { console.error(err); process.exit(1); });
