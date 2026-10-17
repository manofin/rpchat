/**
 * node --import tsx bench/helpers/partyU1Probe.ts --dry --conditions bench/fixtures/party-u1/conditions.json --out <new.json>
 * --model <baseUrl> requires --model-name. No .env or model environment defaults.
 * This probe assembles synthetic public requests; it is not connected to chat.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { buildPartyContext, renderPartyContextSections, PartyContextOverflowError, type PartyCard } from '../../apps/server/src/prompt/partyContext.ts';
import { estimateTokens, estimateMessageTokens } from '../../apps/server/src/prompt/tokens.ts';
import { renderPassS } from '../../apps/server/src/prompt/dialogScript.ts';

export type ProbeConfig = {
  contextTokens: number;
  outputReserveTokens: number;
  calibration: number;
  storySettingFile: string;
  minorCastFile: string;
  sceneState: string;
  userName: string;
  conditions: Array<{ id: string; participantCount: number; castFile: string; allowedSpeakerIds: string[]; userText: string }>;
};
export type ProbeMessage = { role: 'system' | 'user'; content: string };

export function assemblySha256(messages: ProbeMessage[]): string {
  return createHash('sha256').update(JSON.stringify(messages.map(({ role, content }) => ({ role, content }))), 'utf8').digest('hex');
}

export function assembleProbe(conditionsPath: string, maxTokens?: number) {
  const cfg = JSON.parse(fs.readFileSync(conditionsPath, 'utf8')) as ProbeConfig;
  const dir = path.dirname(conditionsPath);
  const reserve = maxTokens ?? cfg.outputReserveTokens;
  if (!Number.isSafeInteger(reserve) || reserve < 1 || !Number.isSafeInteger(cfg.contextTokens) || cfg.contextTokens <= reserve) {
    throw new RangeError('Invalid request context/output budget');
  }
  if (!Array.isArray(cfg.conditions) || !cfg.conditions.length) throw new TypeError('No probe conditions');
  if (new Set(cfg.conditions.map((c) => c.id)).size !== cfg.conditions.length) throw new TypeError('Duplicate condition IDs');
  const storySnapshot = {
    setting: fs.readFileSync(path.resolve(dir, cfg.storySettingFile), 'utf8'),
    minorCast: JSON.parse(fs.readFileSync(path.resolve(dir, cfg.minorCastFile), 'utf8')) as unknown[],
  };
  return cfg.conditions.map((condition) => {
    const cards = JSON.parse(fs.readFileSync(path.resolve(dir, condition.castFile), 'utf8')) as Record<string, PartyCard>;
    const presentIds = Object.keys(cards);
    if (![17, 25].includes(condition.participantCount) || presentIds.length !== condition.participantCount
      || ![1, 3].includes(condition.allowedSpeakerIds.length)
      || new Set(condition.allowedSpeakerIds).size !== condition.allowedSpeakerIds.length
      || condition.allowedSpeakerIds.some((id) => !Object.hasOwn(cards, id))) throw new TypeError('Invalid public probe cast');
    const cast = presentIds.map((id) => ({ id, name: cards[id].name, aliases: [], duties: [], place: '합성 정원', role: 'main' as const }));
    // 상세 카드는 공통 구성기에서 한 번만 넣는다. 기존 렌더러에는 화자 슬롯만 준다.
    const format = renderPassS({
      speakers: condition.allowedSpeakerIds.map((id) => ({ id, name: cards[id].name })),
      cast, scene: {}, header: null, info: null, userName: cfg.userName,
      userText: condition.userText, includeUserInput: false,
    });
    const prefix = format + '\n\n';
    const fixedTokens = estimateMessageTokens(prefix, cfg.calibration) + estimateMessageTokens(condition.userText, cfg.calibration);
    const inputLimit = cfg.contextTokens - reserve;
    if (fixedTokens > inputLimit) throw new PartyContextOverflowError(fixedTokens, inputLimit);
    const context = buildPartyContext({
      storySnapshot, cards, presentIds, allowedSpeakerIds: condition.allowedSpeakerIds,
      sceneState: cfg.sceneState, items: [], requestRecipients: ['user', ...presentIds],
      budget: { inputLimitTokens: inputLimit - fixedTokens, outputReserveTokens: reserve, calibration: cfg.calibration },
      estimate: estimateTokens,
    });
    const messages: ProbeMessage[] = [
      { role: 'system', content: prefix + renderPartyContextSections(context.sections) },
      { role: 'user', content: condition.userText },
    ];
    const total = messages.reduce((n, m) => n + estimateMessageTokens(m.content, cfg.calibration), 0);
    if (total > inputLimit) throw new PartyContextOverflowError(total, inputLimit);
    return {
      conditionId: condition.id, participantCount: condition.participantCount,
      allowedSpeakerIds: [...condition.allowedSpeakerIds], messages, assemblySha256: assemblySha256(messages),
      sections: context.sections, diagnostics: context.diagnostics,
      requestBudget: { contextTokens: cfg.contextTokens, inputLimitTokens: inputLimit, outputReserveTokens: reserve, fixedEstimatedTokens: fixedTokens, totalEstimatedTokens: total },
    };
  });
}

export async function measureRequest(baseUrl: string, model: string, messages: ProbeMessage[], maxTokens: number, timeoutMs: number) {
  const endpoint = new URL(baseUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new TypeError('Expected an explicit HTTP(S) model base URL without credentials, query or fragment');
  }
  endpoint.pathname = endpoint.pathname.replace(/\/$/, '') + (endpoint.pathname.replace(/\/$/, '').endsWith('/v1') ? '/chat/completions' : '/v1/chat/completions');
  const requestAt = new Date().toISOString();
  const started = performance.now();
  let firstTokenAt: string | null = null;
  let firstCompleteLineAt: string | null = null;
  let firstTokenMs: number | null = null;
  let firstCompleteLineMs: number | null = null;
  let text = '';
  let usage: unknown = null;
  let finishReason: string | null = null;
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true } }),
  });
  if (!response.ok || !response.body) throw new Error(`Model HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let wire = '';
  let done = false;
  try {
    while (!done) {
      const part = await reader.read();
      wire += part.done ? decoder.decode() : decoder.decode(part.value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(wire))) {
        const frame = wire.slice(0, boundary.index);
        wire = wire.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        if (data === '[DONE]') { done = true; break; }
        const event = JSON.parse(data);
        if (event.error) throw new Error('Model SSE error');
        if (event.usage != null) usage = event.usage;
        const choice = event.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta?.content;
        if (delta != null && typeof delta !== 'string') throw new TypeError('Non-text SSE content');
        if (delta) {
          if (firstTokenAt === null) { firstTokenAt = new Date().toISOString(); firstTokenMs = performance.now() - started; }
          text += delta;
          if (firstCompleteLineAt === null && text.includes('\n')) {
            firstCompleteLineAt = new Date().toISOString(); firstCompleteLineMs = performance.now() - started;
          }
        }
      }
      if (part.done && !done) throw new Error('incomplete_sse: stream ended without [DONE]');
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return {
    requestAt, firstTokenAt, firstCompleteLineAt, completedAt: new Date().toISOString(),
    firstTokenMs, firstCompleteLineMs, completionMs: performance.now() - started,
    firstCompleteLineMeaning: '검증 전 첫 줄 (줄바꿈 완료, 화자 검증 없음)',
    usage, finishReason, outputSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
  };
}

export async function main(args: string[]) {
  let dry = false;
  const values = new Map<string, string>();
  const valid = new Set(['--conditions', '--out', '--model', '--model-name', '--max-tokens', '--repeat', '--timeout-ms']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry') { if (dry) throw new Error('Duplicate --dry'); dry = true; continue; }
    if (!valid.has(arg) || values.has(arg)) throw new Error(`Unknown/duplicate argument: ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    values.set(arg, value);
  }
  if (dry === values.has('--model')) throw new Error('Choose exactly one of --dry or --model <baseUrl>');
  const conditions = values.get('--conditions');
  const out = values.get('--out');
  if (!conditions || !out) throw new Error('--conditions and --out are required');
  if (fs.existsSync(out)) throw new Error('Output already exists');
  const model = values.get('--model-name');
  if (!dry && !model) throw new Error('--model-name is required for --model');
  const positive = (key: string, fallback?: number) => {
    const raw = values.get(key);
    const n = raw === undefined ? fallback : Number(raw);
    if (n !== undefined && (!Number.isSafeInteger(n) || n < 1)) throw new Error(`${key} must be a positive integer`);
    return n;
  };
  const repeat = positive('--repeat', 1)!;
  const timeoutMs = positive('--timeout-ms', 120_000)!;
  const assembled = assembleProbe(path.resolve(conditions), positive('--max-tokens'));
  const results: Array<Record<string, unknown>> = [];
  for (const item of assembled) {
    for (let repetition = 1; repetition <= repeat; repetition++) {
      const result: Record<string, unknown> = { ...item, repetition };
      if (!dry) result.measurement = await measureRequest(values.get('--model')!, model!, item.messages, item.requestBudget.outputReserveTokens, timeoutMs);
      results.push(result);
    }
  }
  fs.writeFileSync(out, JSON.stringify({ schemaVersion: 1, mode: dry ? 'dry' : 'model', model: model ?? null, results }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ mode: dry ? 'dry' : 'model', results: results.length, out: path.resolve(out) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error); process.exitCode = 1; });
}
