/**
 * Bench-Latency, beat + choices mix —
 *   `npx tsx bench/partyBench/run-bench-latency-beat-choices.ts`
 *
 * beat-post-extras-choices adds one call to the beat: Pass C, after Pass E. This
 * is what that call costs.
 *
 * `run-bench-latency-beat.ts` is left byte-identical, exactly as it left
 * `run-bench-latency.ts` alone before it — the 2026-09-02 result it produced has
 * to stay reproducible, so this is a third runner rather than an edit of the
 * second. The fixture below is duplicated from it on purpose and for that reason.
 *
 * The cut numbers in `score-latency.ts` are the sealed ones and are NOT touched.
 * Run the sealed runner in the same session to get a same-machine baseline: the
 * 9.66s / 13.58s on record was measured on 2026-09-02, and an increment computed
 * against a number from another day measures the day as much as the change.
 *
 * Env: MODEL_BASE_URL, MODEL_NAME, [MODEL_API_KEY], [MODEL_TIMEOUT_MS], [BEAT_N].
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LATENCY_CUT, latencyVerdict, overflowCount, percentile, redesignTrigger } from './score-latency.ts';
import { renderPassE, renderPassF, renderPassN } from '../../apps/server/src/prompt/passes.ts';
import { renderPassC } from '../../apps/server/src/prompt/beatChoices.ts';
import { renderSceneDeltaPrompt } from '../../apps/server/src/prompt/sceneDeltaPrompt.ts';
import { catalogFromStory } from '../../apps/server/src/prompt/sceneCatalog.ts';
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
      finish, text_len: text.length, error: null,
    };
  } catch (e) {
    return {
      pass: args.pass, ok: false, ms: Date.now() - started, ttft_ms: ttft,
      prompt_tokens: null, completion_tokens: null, finish: null, text_len: 0,
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

const CATALOG = catalogFromStory(JSON.stringify({
  places: [{ id: 'room_a', default_focus: 'npc_mina' }, { id: 'room_b' }],
  arcs: ['arc_a'],
  stagesByArc: { arc_a: ['stage_a', 'stage_b'] },
  weathers: ['clear', 'cloudy'],
  flags: { flag_a: { owner_duty: '보안' } },
  stages: { stage_b: { closer_duty: '안내' } },
  outfits: ['uniform'],
  emotions: { calm: 0 },
}));

const CARD_MINA = { name: '민아', personality: '차분하다', speech_style: '존댓말', taboos: '규정을 어기지 않는다' };
const CARD_JIWOO = { name: '지우', personality: '무뚝뚝하다', speech_style: '짧게 말한다' };
const CARD_SEOLHWA = { name: '설화', personality: '수다스럽다' };

const HEADER = '3일차 · 수 · 09:37 · clear · room_a';
const USER_TEXT = '민아, 등록 절차가 어떻게 되나요?';
const NARRATION = '접수대 앞에서 사람들이 줄지어 서 있다. 설화가 흘끗 이쪽을 본다.';
const FOCUS_TEXT = '"신분증부터 보여주시겠어요?" 민아가 서류를 정리하며 고개를 들었다.';

/** Pad Pass F's history to approximate a real 12-turn window (§7 budget). */
function historyPad(turns: number): string {
  const rows: string[] = [];
  for (let i = 0; i < turns; i++) {
    rows.push(`사용자: 이전 턴 ${i}의 사용자 발화입니다. 장면을 조금 더 밀어붙이는 문장을 포함합니다.`);
    rows.push(`민아: 이전 턴 ${i}의 응답입니다. 상황을 설명하고 다음 행동을 제안하는 두세 문장으로 구성됩니다.`);
  }
  return rows.join('\n');
}

function beatPrompts(extras: number): { pass: string; messages: ChatMessage[]; temperature: number; max_tokens: number }[] {
  const history = historyPad(12);
  const out = [
    {
      pass: 'delta',
      messages: [{ role: 'user' as const, content: renderSceneDeltaPrompt({ scene: SCENE, catalog: { ...CATALOG, cast: CAST }, userText: USER_TEXT }) }],
      temperature: 0.2, max_tokens: 200,
    },
    {
      pass: 'N',
      messages: [{ role: 'user' as const, content: renderPassN({
        focusCard: CARD_MINA, cast: CAST, scene: SCENE, header: HEADER,
        userText: USER_TEXT, ambientNames: ['설화'],
      }) }],
      temperature: 0.8, max_tokens: 300,
    },
    {
      pass: 'F',
      messages: [{ role: 'user' as const, content:
        `${renderPassF({
          focusCard: CARD_MINA, userName: '사용자', userText: USER_TEXT,
          scene: SCENE, header: HEADER, narration: NARRATION,
        })}\n\n## 최근 대화\n${history}` }],
      temperature: 0.9, max_tokens: 500,
    },
  ];
  const cards = [CARD_JIWOO, CARD_SEOLHWA];
  const duties = ['보안', '안내'];
  for (let i = 0; i < extras; i++) {
    out.push({
      pass: `E${i + 1}`,
      messages: [{ role: 'user' as const, content: renderPassE({
        card: cards[i], duty: duties[i], focusName: '민아', focusText: FOCUS_TEXT,
        narration: NARRATION, userName: '사용자', userText: USER_TEXT,
        facts: ['빈자리는 창가 두 번째'],
      }) }],
      temperature: 0.85, max_tokens: 220,
    });
  }
  // Pass C sees the turn as serialized: narration, the focus line, the thought,
  // and one line per extra that actually spoke. Shipped params: 0.9 / 400.
  const blocks = [
    { kind: 'narration', text: NARRATION },
    { kind: 'line', speaker_name: '민아', text: FOCUS_TEXT },
    { kind: 'thought', speaker_name: '민아', text: '오늘은 줄이 길겠네.' },
    ...cards.slice(0, extras).map((c, i) => ({
      kind: 'line', speaker_name: c.name,
      text: `"${duties[i]} 쪽은 제가 봅니다." ${c.name}이 한 걸음 다가섰다.`,
    })),
  ];
  out.push({
    pass: 'C',
    messages: [{ role: 'user' as const, content: renderPassC({
      userName: '사용자', userText: USER_TEXT, blocks,
    }) }],
    temperature: 0.9, max_tokens: 400,
  });
  return out;
}

type TurnRow = { i: number; extras: number; calls: CallRow[]; turn_ms: number; overflow: boolean };

async function oneTurn(i: number, extras: number, cfg: { baseUrl: string; apiKey: string; model: string; timeoutMs: number }): Promise<TurnRow> {
  const calls: CallRow[] = [];
  for (const p of beatPrompts(extras)) {
    calls.push(await streamComplete({ ...cfg, pass: p.pass, messages: p.messages, temperature: p.temperature, top_p: 0.95, max_tokens: p.max_tokens }));
  }
  const tokens = calls.map((c) => c.prompt_tokens).filter((n): n is number => typeof n === 'number');
  return {
    i, extras, calls,
    turn_ms: calls.reduce((n, c) => n + c.ms, 0),
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
  const n = Number(env('BEAT_N') || LATENCY_CUT.n);
  const cfg = { baseUrl, apiKey, model, timeoutMs };

  const startedAt = new Date().toISOString();
  const runId = startedAt.replace(/[:.]/g, '-');
  const outPath = path.join(resultsDir, `beat-choices-${runId}.json`);
  const partialPath = path.join(resultsDir, `beat-choices-${runId}.partial.json`);

  const meta = {
    token: 'beat-post-extras-choices',
    bench: 'Bench-Latency (beat + Pass C mix)',
    supersedes_mix_of: 'nothing — the f9 beat mix result stays valid for its own mix',
    queue_depth: QUEUE_DEPTH,
    live_db: 0,
    live_messages_post: 0,
    apps_product_code_changed: 0,
    prompts_from: 'apps/server/src/prompt/passes.ts + beatChoices.ts (the shipped renderers)',
    model_name: model,
    model_base_url: baseUrl,
    context_tokens: LATENCY_CUT.context_tokens,
    n_target: n,
    cuts: LATENCY_CUT,
    started_at: startedAt,
  };
  writeJson(partialPath, { ...meta, status: 'running', turns: [] });

  const turns: TurnRow[] = [];
  for (let i = 0; i < n; i++) {
    // The shipped default opens zero extras, so the measured mix is mostly 3 calls.
    // Every 5th turn exercises the worst realistic case (2 extras = 5 calls) so the
    // p95 reflects a beat that actually opened slots rather than only quiet turns.
    const extras = i % 5 === 4 ? 2 : 0;
    const row = await oneTurn(i, extras, cfg);
    turns.push(row);
    writeJson(partialPath, { ...meta, status: 'running', turns });
    if (row.calls.some((c) => !c.ok)) {
      writeJson(outPath, { ...meta, status: 'invalid', reason: 'endpoint_or_call_failure', finished_at: new Date().toISOString(), turns });
      console.error('벤치 무효: call failure at turn', i);
      process.exit(2);
    }
    const s = (row.turn_ms / 1000).toFixed(1);
    console.log(`turn ${i + 1}/${n} extras=${row.extras} calls=${row.calls.length} ${s}s`);
  }

  const secs = turns.map((t) => t.turn_ms / 1000);
  const p50 = percentile(secs, 50) ?? 0;
  const p95 = percentile(secs, 95) ?? 0;
  const overflow = turns.filter((t) => t.overflow).length;
  const verdict = latencyVerdict({ p50_s: p50, p95_s: p95, overflow, n: turns.length });

  const byPass: Record<string, { n: number; p50_s: number; max_prompt_tokens: number }> = {};
  for (const t of turns) {
    for (const c of t.calls) {
      const b = (byPass[c.pass] ??= { n: 0, p50_s: 0, max_prompt_tokens: 0 });
      b.n++;
      b.max_prompt_tokens = Math.max(b.max_prompt_tokens, c.prompt_tokens ?? 0);
    }
  }
  for (const pass of Object.keys(byPass)) {
    const ms = turns.flatMap((t) => t.calls.filter((c) => c.pass === pass).map((c) => c.ms / 1000));
    byPass[pass].p50_s = Number((percentile(ms, 50) ?? 0).toFixed(3));
  }

  writeJson(outPath, {
    ...meta,
    status: 'complete',
    finished_at: new Date().toISOString(),
    n: turns.length,
    p50_s: Number(p50.toFixed(3)),
    p95_s: Number(p95.toFixed(3)),
    overflow,
    verdict,
    f9_adoption: verdict ? 'PASS' : 'FAIL',
    redesign_trigger: redesignTrigger(p50),
    per_pass: byPass,
    turns,
    note: 'Cuts are the sealed f9-bench-latency numbers, unchanged. Only the call mix differs.',
  });

  console.log(`\nn=${turns.length} p50=${p50.toFixed(2)}s p95=${p95.toFixed(2)}s overflow=${overflow} verdict=${verdict ? 'PASS' : 'FAIL'}`);
  console.log(JSON.stringify(byPass, null, 2));
  console.log(outPath);
  if (!verdict) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
