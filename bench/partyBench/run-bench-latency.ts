/**
 * Bench-Latency runner. Isolated. Live DB 0. apps/** 0. pickSpeaker product path 0.
 * Direct model endpoint. Queue depth 1. Serial call #1 then call #2.
 * Usage: npx tsx bench/partyBench/run-bench-latency.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPromptA, buildPromptB, type ChatMessage } from './prompts.ts';
import {
  LATENCY_CUT,
  latencyVerdict,
  overflowCount,
  percentile,
  redesignTrigger,
  turnMs,
} from './score-latency.ts';

const QUEUE_DEPTH = 1;
const token = 'f9-bench-latency';
const dir = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.join(dir, 'results');

type CallRow = {
  ok: boolean;
  ms: number;
  ttft_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  finish: string | null;
  text_len: number;
  error: string | null;
};

type TurnRow = {
  i: number;
  kind: 'A' | 'B';
  call1: CallRow;
  call2: CallRow;
  turn_ms: number;
  overflow: boolean;
};

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

function requiredEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`벤치 무효: missing ${name}`);
  return v;
}

async function streamComplete(args: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature: number;
  top_p: number;
  max_tokens: number;
  timeoutMs: number;
}): Promise<CallRow> {
  const started = Date.now();
  const url = `${args.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
  };
  if (args.apiKey) headers.authorization = `Bearer ${args.apiKey}`;
  const body = {
    model: args.model,
    messages: args.messages,
    temperature: args.temperature,
    top_p: args.top_p,
    max_tokens: args.max_tokens,
    stream: true,
    stream_options: { include_usage: true },
    chat_template_kwargs: { enable_thinking: false },
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), args.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      return {
        ok: false,
        ms: Date.now() - started,
        ttft_ms: null,
        prompt_tokens: null,
        completion_tokens: null,
        finish: null,
        text_len: 0,
        error: `HTTP ${res.status} ${detail.slice(0, 200)}`,
      };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let text = '';
    let finish: string | null = null;
    let prompt_tokens: number | null = null;
    let completion_tokens: number | null = null;
    let ttft: number | null = null;
    const handleLine = (line: string) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let j: { usage?: { prompt_tokens?: number; completion_tokens?: number }; choices?: Array<{ delta?: { content?: string }; finish_reason?: string; text?: string }> };
      try {
        j = JSON.parse(data);
      } catch {
        return;
      }
      if (j.usage && typeof j.usage === 'object') {
        if (typeof j.usage.prompt_tokens === 'number') prompt_tokens = j.usage.prompt_tokens;
        if (typeof j.usage.completion_tokens === 'number') completion_tokens = j.usage.completion_tokens;
      }
      const ch = j.choices?.[0];
      if (!ch) return;
      const delta = ch.delta?.content ?? ch.text ?? '';
      if (delta) {
        if (ttft === null) ttft = Date.now() - started;
        text += delta;
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    };
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
    return {
      ok: true,
      ms: Date.now() - started,
      ttft_ms: ttft,
      prompt_tokens,
      completion_tokens,
      finish,
      text_len: text.length,
      error: null,
    };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - started,
      ttft_ms: null,
      prompt_tokens: null,
      completion_tokens: null,
      finish: null,
      text_len: 0,
      error: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function oneTurn(kind: 'A' | 'B', i: number, cfg: {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}): Promise<TurnRow> {
  const built = kind === 'A' ? buildPromptA() : buildPromptB();
  const call1 = await streamComplete({
    ...cfg,
    messages: built.call1,
    temperature: 0.3,
    top_p: 0.95,
    max_tokens: 400,
  });
  const call2 = await streamComplete({
    ...cfg,
    messages: built.call2,
    temperature: 0.8,
    top_p: 0.95,
    max_tokens: 400,
  });
  const tokens = [call1.prompt_tokens, call2.prompt_tokens].filter((n): n is number => typeof n === 'number');
  return {
    i,
    kind,
    call1,
    call2,
    turn_ms: turnMs({ call1_ms: call1.ms, call2_ms: call2.ms }),
    overflow: overflowCount(tokens) > 0,
  };
}

function writeJson(p: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

async function main() {
  if (QUEUE_DEPTH !== 1) throw new Error('queue_depth must be 1');
  const baseUrl = requiredEnv('MODEL_BASE_URL');
  const model = requiredEnv('MODEL_NAME');
  const apiKey = env('MODEL_API_KEY');
  const timeoutMs = Number(env('MODEL_TIMEOUT_MS') || '180000');
  const cfg = { baseUrl, apiKey, model, timeoutMs };
  const startedAt = new Date().toISOString();
  const runId = startedAt.replace(/[:.]/g, '-');
  const outPath = path.join(resultsDir, `${runId}.json`);
  const partialPath = path.join(resultsDir, `${runId}.partial.json`);
  const promptA = buildPromptA();
  const promptB = buildPromptB();
  const turns: TurnRow[] = [];
  const meta = {
    token: 'f9-bench-latency',
    bench: 'Bench-Latency',
    queue_depth: QUEUE_DEPTH,
    live_db: 0,
    apps_product_code: 0,
    pickSpeaker_product_path: 0,
    model_name: model,
    model_base_url: baseUrl,
    context_tokens: LATENCY_CUT.context_tokens,
    n_target: LATENCY_CUT.n,
    prompt_a_est_tokens: promptA.est_tokens,
    prompt_b_est_tokens: promptB.est_tokens,
    started_at: startedAt,
  };
  writeJson(partialPath, { ...meta, status: 'running', turns });

  for (let i = 0; i < LATENCY_CUT.n; i++) {
    const row = await oneTurn('A', i, cfg);
    turns.push(row);
    writeJson(partialPath, { ...meta, status: 'running', turns });
    if (!row.call1.ok || !row.call2.ok) {
      writeJson(outPath, {
        ...meta,
        status: 'invalid',
        reason: 'endpoint_or_call_failure',
        finished_at: new Date().toISOString(),
        turns,
      });
      console.error('벤치 무효: call failure at turn', i);
      process.exit(2);
    }
  }

  const probe = await oneTurn('B', LATENCY_CUT.n, cfg);
  if (!probe.call1.ok || !probe.call2.ok) {
    writeJson(outPath, {
      ...meta,
      status: 'invalid',
      reason: 'overflow_probe_failure',
      finished_at: new Date().toISOString(),
      turns,
      overflow_probe: probe,
    });
    console.error('벤치 무효: Prompt-B probe failure');
    process.exit(2);
  }

  const sample = turns.map((t) => t.turn_ms / 1000);
  const p50 = percentile(sample, 50);
  const p95 = percentile(sample, 95);
  if (p50 == null || p95 == null) {
    writeJson(outPath, { ...meta, status: 'invalid', reason: 'empty_sample', turns, overflow_probe: probe });
    console.error('벤치 무효: empty sample');
    process.exit(2);
  }
  const allTokens: number[] = [];
  for (const t of [...turns, probe]) {
    if (typeof t.call1.prompt_tokens === 'number') allTokens.push(t.call1.prompt_tokens);
    if (typeof t.call2.prompt_tokens === 'number') allTokens.push(t.call2.prompt_tokens);
  }
  const overflow = overflowCount(allTokens);
  const verdict = latencyVerdict({ p50_s: p50, p95_s: p95, overflow, n: turns.length });
  const report = {
    ...meta,
    status: 'complete',
    finished_at: new Date().toISOString(),
    n: turns.length,
    p50_s: p50,
    p95_s: p95,
    overflow,
    verdict,
    f9_adoption: verdict ? 'PASS' : 'FAIL',
    redesign_trigger: redesignTrigger(p50),
    cuts: LATENCY_CUT,
    overflow_probe: probe,
    turns,
    note: 'Percentiles are Prompt-A N=50 turn_ms. Prompt-B is overflow probe only. Helper/bench PASS is not a product code PASS. Fallback 1-call 2-channel is a new lock, not this run.',
  };
  writeJson(outPath, report);
  try {
    fs.unlinkSync(partialPath);
  } catch {
    /* keep partial if unlink fails */
  }
  console.log(JSON.stringify({ outPath, n: report.n, p50_s: p50, p95_s: p95, overflow, verdict, redesign_trigger: report.redesign_trigger }, null, 2));
}

main().catch((e) => {
  console.error('벤치 무효:', e instanceof Error ? e.message : e);
  process.exit(2);
});
