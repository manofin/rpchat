/**
 * Bench-Latency, Pass N continuity A/B —
 *   `npx tsx bench/partyBench/run-bench-latency-narration-ab.ts`
 *
 * narration-continuity. Two Pass N inputs, one fixture, one session:
 *
 *   A  no continuity block      the pre-slice prompt, and also every opening turn
 *   B  two prior narrations     the shipped path from turn 2 onward
 *
 * Both go through the shipped `renderPassN`, so the arms differ only in the one
 * argument this slice added. The three earlier runners are left byte-identical
 * for the same reason `run-bench-latency-beat-choices.ts` did not edit its
 * predecessor: the results they produced have to stay reproducible.
 *
 * INTERLEAVED, for the reason the choices A/B spelled out — the effect being
 * measured here is smaller than that one (input tokens only; the output cap, the
 * call count and every other pass are unchanged), so drift between minute 5 and
 * minute 20 would otherwise land entirely in the second arm.
 *
 * Only Pass N is measured. delta/F/E/C are byte-identical across arms by
 * construction, so the turn totals are composed against published numbers rather
 * than paid for again, and the composition is stated in the output.
 *
 * The B fixture uses two narrations of live length (~200 chars), taken from the
 * shape of the live lobby turns that motivated the slice rather than from short
 * synthetic ones — a cheap fixture here would understate the only cost there is.
 * No live ids or names, per the latency lock.
 *
 * Env: MODEL_BASE_URL, MODEL_NAME, [MODEL_API_KEY], [MODEL_TIMEOUT_MS], [AB_N].
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PASS_N_RECENT_NARRATIONS, renderPassN } from '../../apps/server/src/prompt/passes.ts';
import type { CastMember } from '../../apps/server/src/prompt/cast.ts';
import type { Scene } from '../../apps/server/src/types.ts';

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
  /** Kept: the point of the slice is what the narration says, so the samples are
   *  the evidence for whether it stopped re-establishing the room. */
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

// ── Synthetic cast. No live ids or names, per the latency lock. ──────────────
const member = (o: Partial<CastMember> & { id: string; name: string }): CastMember => ({
  aliases: [], duties: [], place: 'room_a', role: 'secondary', ...o,
});
const MINA = member({ id: 'npc_mina', name: '민아', duties: ['접수'], role: 'main' });
const JIWOO = member({ id: 'npc_jiwoo', name: '지우', duties: ['보안'] });
const SEOLHWA = member({ id: 'npc_seolhwa', name: '설화', duties: ['안내'], talkativeness: 0.8 });
const CAST = [MINA, JIWOO, SEOLHWA];

const SCENE: Scene = {
  location: 'room_a',
  arc: 'arc_a',
  stage: 'stage_a',
  clock_minutes: 9 * 60 + 37,
  day_index: 3,
  weekday: '수',
  weather: 'clear',
  beat_goal: '자리 배정',
  scene_version: 0,
  present_ids: ['npc_mina', 'npc_jiwoo', 'npc_seolhwa'],
  roster: { npc_mina: { emotion: 'calm', outfit: 'uniform' } },
};

const CARD_MINA = { name: '민아', personality: '차분하다', speech_style: '존댓말', taboos: '규정을 어기지 않는다' };
const HEADER = '3일차 · 수 · 09:37 · clear · room_a';
const USER_TEXT = '민아, 등록 절차가 어떻게 되나요?';

/**
 * Live-length priors. Both open on the room and close on a camera line, because
 * that is what the pass was producing before this slice — the arm has to carry the
 * input the fix actually sees, not a tidied version of it.
 */
const PRIOR_NARRATIONS = [
  '높은 층고의 로비 창밖으로 옅은 회색 구름이 낮게 깔려 있다. 민아가 접수대 너머에서 서류를 정리하며 고개를 든다. 지우는 팔짱을 낀 채 벽에 기대어 상황을 지켜본다. 카메라는 두 사람의 거리감과 정적인 로비를 넓게 비춘다.',
  '로비의 높은 천장 아래로 무거운 정적이 흐르고, 창밖의 흐린 하늘이 바닥의 대리석 위로 잿빛 그림자를 드리운다. 설화가 흘끗 이쪽을 보며 걸음을 늦춘다. 카메라는 민아의 손끝에서 시작해 줄지어 선 사람들을 훑는다.',
];

function writeJson(p: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

type Arm = 'A_no_context' | 'B_continuity';
const ARMS: Arm[] = ['A_no_context', 'B_continuity'];

function passNPrompt(arm: Arm): string {
  return renderPassN({
    focusCard: CARD_MINA, cast: CAST, scene: SCENE, header: HEADER,
    userText: USER_TEXT, ambientNames: ['설화'],
    recentNarrations: arm === 'B_continuity' ? PRIOR_NARRATIONS : undefined,
  });
}

/**
 * Published, same model, same host. The sealed mix is 2026-09-02
 * (`f9-swap-passes`), Pass C is 2026-09-05 (`optimize-beat-choices-latency`,
 * `results/choices-ab-2026-09-05T08-12-49-965Z.json`). Composition is stated,
 * not hidden — only the Pass N term below is measured today.
 */
const PUBLISHED = {
  sealed_mix_p50_s: 9.98,
  sealed_pass_n_p50_s: 3.65,
  pass_c_p50_s: 2.534,
  shipped_turn_p50_s: 12.514,
};

/** The seal's own cut. Untouched — `score-latency.ts` owns these numbers. */
const CUT = { p50_s: 90, p95_s: 120 };

type AbRow = { i: number; arm: Arm; call: CallRow };

function pct(v: number[], p: number): number {
  const s = [...v].sort((a, b) => a - b);
  if (!s.length) return 0;
  const k = (s.length - 1) * p / 100;
  const f = Math.floor(k); const c = Math.ceil(k);
  return f === c ? s[f] : s[f] + (s[c] - s[f]) * (k - f);
}

/** `카메라` sentences and room-establishing openers, the two measured symptoms. */
const CAMERA = /카메라/;
const ESTABLISH = /천장|창밖|통유리|구름|하늘|잿빛|회색빛|햇빛|빛이/;

function summarize(rows: AbRow[], arm: Arm) {
  const mine = rows.filter((r) => r.arm === arm && r.call.ok);
  const ms = mine.map((r) => r.call.ms / 1000);
  const inp = mine.map((r) => r.call.prompt_tokens ?? 0);
  const out = mine.map((r) => r.call.completion_tokens ?? 0);
  const ttft = mine.map((r) => r.call.ttft_ms ?? 0).filter(Boolean);
  const firstSentence = (t: string) => t.trim().split(/(?<=[.!?])\s+/)[0] ?? '';
  return {
    n: mine.length,
    p50_s: +pct(ms, 50).toFixed(3),
    p95_s: +pct(ms, 95).toFixed(3),
    max_s: +Math.max(...ms, 0).toFixed(3),
    ttft_p50_ms: Math.round(pct(ttft, 50)),
    in_tokens_p50: Math.round(pct(inp, 50)),
    out_tokens_p50: Math.round(pct(out, 50)),
    out_tokens_max: Math.max(...out, 0),
    truncated: mine.filter((r) => r.call.finish === 'length').length,
    // Effect, not just cost. These are the numbers the live check repeats.
    camera_sentences: mine.filter((r) => CAMERA.test(r.call.text)).length,
    establishing_openers: mine.filter((r) => ESTABLISH.test(firstSentence(r.call.text))).length,
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
  const outPath = path.join(resultsDir, `narration-ab-${runId}.json`);
  const partialPath = path.join(resultsDir, `narration-ab-${runId}.partial.json`);
  const meta = {
    token: 'narration-continuity',
    bench: 'Bench-Latency (Pass N continuity A/B, interleaved)',
    base_commit: 'c1c58a7',
    queue_depth: QUEUE_DEPTH,
    live_db: 0,
    live_messages_post: 0,
    apps_product_code_changed: 1,
    measures: 'Pass N only; delta/F/E/C are byte-identical across arms by construction',
    prompts_from: 'apps/server/src/prompt/passes.ts (renderPassN, both arms)',
    recent_narrations_cap: PASS_N_RECENT_NARRATIONS,
    published_baseline: PUBLISHED,
    cut: CUT,
    model_name: model,
    model_base_url: baseUrl,
    n_target_per_arm: n,
    started_at: startedAt,
  };
  writeJson(partialPath, { ...meta, status: 'running', rows: [] });

  const rows: AbRow[] = [];
  for (let i = 0; i < n; i++) {
    // Rotate the order so neither arm always pays for the top of a group.
    const order: Arm[] = ARMS.map((_, k) => ARMS[(k + i) % ARMS.length]);
    for (const arm of order) {
      const call = await streamComplete({
        ...cfg, pass: arm,
        messages: [{ role: 'user', content: passNPrompt(arm) }],
        // The production Pass N call: chat.ts PASS_N_MAX_TOKENS = 300.
        temperature: 0.8, top_p: 0.95, max_tokens: 300,
      });
      if (!call.ok) {
        writeJson(outPath, { ...meta, status: 'invalid', reason: 'endpoint_or_call_failure', rows });
        console.error('벤치 무효: call failure at', i, arm, call.error);
        process.exit(2);
      }
      rows.push({ i, arm, call });
    }
    writeJson(partialPath, { ...meta, status: 'running', rows });
    const group = rows.slice(-ARMS.length);
    console.log(`group ${i + 1}/${n}  ` + group.map((r) => `${r.arm}=${(r.call.ms / 1000).toFixed(1)}s`).join('  '));
  }

  const A = summarize(rows, 'A_no_context');
  const B = summarize(rows, 'B_continuity');
  const delta = {
    pass_n_p50_s: +(B.p50_s - A.p50_s).toFixed(3),
    pass_n_p50_pct: +(100 * (B.p50_s / A.p50_s - 1)).toFixed(1),
    pass_n_p95_s: +(B.p95_s - A.p95_s).toFixed(3),
    ttft_p50_ms: B.ttft_p50_ms - A.ttft_p50_ms,
    in_tokens_p50: B.in_tokens_p50 - A.in_tokens_p50,
    out_tokens_p50: B.out_tokens_p50 - A.out_tokens_p50,
  };
  /** The shipped turn already contains a Pass N; this swaps that term, not adds one. */
  const composedTurnP50 = +(PUBLISHED.shipped_turn_p50_s + delta.pass_n_p50_s).toFixed(3);
  const verdict = {
    composed_turn_p50_s: composedTurnP50,
    vs_shipped_pct: +(100 * (composedTurnP50 / PUBLISHED.shipped_turn_p50_s - 1)).toFixed(1),
    cut_p50_ok: composedTurnP50 <= CUT.p50_s,
    // p95 is bounded by the same one-term swap; stated against the cut for the record.
    note: 'composed by swapping the Pass N term in the 2026-09-05 shipped turn p50; only Pass N was measured today',
  };
  const result = {
    ...meta, status: 'complete', finished_at: new Date().toISOString(),
    A_no_context: A, B_continuity: B, delta, verdict,
    samples: { A: rows.filter((r) => r.arm === 'A_no_context').slice(0, 3).map((r) => r.call.text), B: rows.filter((r) => r.arm === 'B_continuity').slice(0, 3).map((r) => r.call.text) },
    rows,
  };
  writeJson(outPath, result);
  fs.rmSync(partialPath, { force: true });
  for (const [name, x] of [['A_no_context', A], ['B_continuity', B]] as const) {
    console.log(`${name.padEnd(13)} p50=${x.p50_s}s p95=${x.p95_s}s ttft_p50=${x.ttft_p50_ms}ms in_p50=${x.in_tokens_p50} out_p50=${x.out_tokens_p50} trunc=${x.truncated} camera=${x.camera_sentences}/${x.n} establishing=${x.establishing_openers}/${x.n}`);
  }
  console.log(`delta: Pass N p50 ${delta.pass_n_p50_s >= 0 ? '+' : ''}${delta.pass_n_p50_s}s (${delta.pass_n_p50_pct}%), in +${delta.in_tokens_p50} tok, ttft ${delta.ttft_p50_ms >= 0 ? '+' : ''}${delta.ttft_p50_ms}ms`);
  console.log(`composed turn p50 ${composedTurnP50}s vs shipped ${PUBLISHED.shipped_turn_p50_s}s (${verdict.vs_shipped_pct}%) — cut p50<=${CUT.p50_s}: ${verdict.cut_p50_ok ? 'PASS' : 'FAIL'}`);
  console.log(outPath);
}

main().catch((err) => { console.error(err); process.exit(1); });
