/**
 * ADR-F8h Slice 3 (story-ending-eval-llm): narrative_hint LLM 보조 판정.
 *
 * - Rule을 통과한 후보 중 narrative_hint가 있는 엔딩만, 최대 N=2개.
 * - 입력은 활성 경로 최근 K=5턴. 출력 { eligible, confidence, reason,
 *   matched_condition } — confidence는 관측용, 정렬·권한에 사용 금지.
 * - 실패(타임아웃/파싱 실패/모델 에러)는 조용히 무시 + 로그 1건. 재시도 없음.
 * - 관측은 서버 로그만. generation_log/budget_json에 판정 결과를 넣지 않는다.
 * - ended_at을 쓰지 않는다 (V1/V3). 제안 영속화 없음 — 결과는 로그로만 남고,
 *   확정 계약(POST .../end)은 rule 재검증 그대로다.
 */
import type { DB } from './db/index.js';
import { one } from './db/index.js';
import { getPath } from './db/tree.js';
import type { ConversationRow, MessageRow } from './types.js';
import type { GenParams, GenResult } from './model/adapter.js';
import { EVALUATION_VERSION, suggestEndings } from './endingEval.js';
import { parseEndings } from './routes/stories.js';

/** D3 잠정값. rule 슬라이스 관측 후 확정한다. */
export const LLM_EVAL_MAX_CANDIDATES = 2;
export const LLM_EVAL_MAX_TURNS = 5;
/** 판정 호출 자체 타임아웃. 본류 생성과 무관한 별도 신호다. */
export const LLM_EVAL_TIMEOUT_MS = 20_000;
export const LLM_EVAL_MAX_TOKENS = 512;
const TURN_CHARS = 500;
const REASON_CHARS = 500;

export interface NarrativeCandidate {
  ending_id: string;
  title: string;
  narrative_hint: string;
  rule_count: number;
}

export interface JudgeVerdict {
  eligible: boolean;
  confidence: number;
  reason: string;
  matched_condition: 'narrative_hint' | null;
}

export interface JudgeLogFields {
  room_id: string;
  turn_id: string | null;
  ending_id: string;
  evaluation_version: number;
  rule_pass: true;
  eligible: boolean;
  confidence: number;
  reason_len: number;
  llm_called: number;
  latency_ms: number;
}

export interface JudgeDeps {
  complete: (p: GenParams) => Promise<GenResult>;
  model: string;
  log: (fields: JudgeLogFields) => void;
}

/**
 * Rule 통과 + hint 보유 후보를 랭크 순으로 최대 n개. hint 없는 통과자는
 * 즉시 candidate이므로(제약 3) LLM 대상에서 제외한다.
 */
export function selectNarrativeCandidates(
  ranked: Array<{ ending_id: string; rule_count: number }>,
  hintOf: (id: string) => string | undefined,
  n: number = LLM_EVAL_MAX_CANDIDATES,
): Array<{ ending_id: string; rule_count: number; narrative_hint: string }> {
  const out: Array<{ ending_id: string; rule_count: number; narrative_hint: string }> = [];
  for (const s of ranked) {
    if (out.length >= n) break;
    const hint = hintOf(s.ending_id);
    if (!hint) continue;
    out.push({ ending_id: s.ending_id, rule_count: s.rule_count, narrative_hint: hint });
  }
  return out;
}

/** 활성 경로 끝에서 K턴(user+assistant 행)을 시간순으로. 토큰 상한용 절단 포함. */
export function buildJudgeContext(path: MessageRow[], k: number = LLM_EVAL_MAX_TURNS): string[] {
  const tail = path.slice(-2 * k);
  return tail.map((m) => {
    const who = m.role === 'user' ? 'user' : 'assistant';
    const text = m.content.length > TURN_CHARS ? m.content.slice(0, TURN_CHARS) + '…' : m.content;
    return `${who}: ${text}`;
  });
}

export function buildJudgePrompt(
  candidates: Array<{ ending_id: string; title: string; narrative_hint: string }>,
  turns: string[],
): GenParams['messages'] {
  const lines = candidates.map(
    (c, i) => `${i + 1}. ending_id="${c.ending_id}" title="${c.title}" 조건: ${c.narrative_hint}`,
  );
  return [
    {
      role: 'system',
      content:
        '너는 스토리 엔딩 도달 판정 보조다. 아래 최근 대화와 각 엔딩의 서사 조건을 비교해, 조건이 이미 달성됐는지 판정하라. ' +
        '반드시 JSON 하나로만 답하라: {"evals": [{"ending_id": "...", "eligible": true/false, "confidence": 0~1 숫자, "reason": "한 문장 근거"}]}. ' +
        '확실하지 않으면 eligible=false.',
    },
    {
      role: 'user',
      content: `최근 대화:\n${turns.join('\n')}\n\n엔딩 후보:\n${lines.join('\n')}`,
    },
  ];
}

/** 모델 출력에서 evals 배열을 꺼낸다. 실패하면 null — 호출자는 무시한다. */
export function parseJudgeOutput(text: string): Record<string, JudgeVerdict> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof doc !== 'object' || doc === null || !Array.isArray((doc as { evals?: unknown }).evals)) return null;
  const out: Record<string, JudgeVerdict> = {};
  for (const e of (doc as { evals: unknown[] }).evals) {
    if (typeof e !== 'object' || e === null) continue;
    const r = e as Record<string, unknown>;
    if (typeof r.ending_id !== 'string' || typeof r.eligible !== 'boolean') continue;
    const confidence = typeof r.confidence === 'number' && Number.isFinite(r.confidence)
      ? Math.min(1, Math.max(0, r.confidence))
      : 0;
    const reason = typeof r.reason === 'string' ? r.reason.slice(0, REASON_CHARS) : '';
    out[r.ending_id] = {
      eligible: r.eligible,
      confidence,
      reason,
      matched_condition: r.eligible ? 'narrative_hint' : null,
    };
  }
  return out;
}

/**
 * 후보들에 대해 LLM 판정 1회. 절대 throw하지 않는다 — 타임아웃·모델 에러·
 * 파싱 실패는 빈 결과 + 로그 없음(호출자가 llm_called:0으로 기록)으로 귀결.
 */
export async function judgeNarratives(
  deps: Pick<JudgeDeps, 'complete' | 'model'>,
  candidates: NarrativeCandidate[],
  turns: string[],
): Promise<{ verdicts: Record<string, JudgeVerdict>; llmCalled: 0 | 1; latencyMs: number }> {
  const t0 = Date.now();
  if (!candidates.length) return { verdicts: {}, llmCalled: 0, latencyMs: 0 };
  try {
    const res = await deps.complete({
      model: deps.model,
      messages: buildJudgePrompt(candidates, turns),
      temperature: 0,
      max_tokens: LLM_EVAL_MAX_TOKENS,
      stop: [],
      signal: AbortSignal.timeout(LLM_EVAL_TIMEOUT_MS),
    });
    const verdicts = parseJudgeOutput(res.text);
    return { verdicts: verdicts ?? {}, llmCalled: 1, latencyMs: Date.now() - t0 };
  } catch {
    return { verdicts: {}, llmCalled: 0, latencyMs: Date.now() - t0 };
  }
}

export interface EvalJobCtx {
  db: DB;
  modelName: string;
  complete: (p: GenParams) => Promise<GenResult>;
  log: (fields: JudgeLogFields) => void;
}

/**
 * 백그라운드 Job 본체. resolve하면 끝 — throw 없음. 호출자는 `void`로
 * fire-and-forget한다 (V2: 본류 스트리밍과 격리, non-blocking).
 */
export async function runEndingEvalJob(exec: EvalJobCtx, conversationId: string): Promise<void> {
  try {
    await runEndingEvalInner(exec, conversationId);
  } catch {
    // graceful fallback: 본체에 영향 없음.
  }
}

async function runEndingEvalInner(exec: EvalJobCtx, conversationId: string): Promise<void> {
  const { db } = exec;
  const conv = loadConversationShim(db, conversationId);
  if (!conv || conv.ended_at || !conv.story_id) return;
  const endings = parseEndings(conv.story_endings_snapshot);
  if (!endings.some((e) => e.conditions)) return;
  const ranked = suggestEndings(db, conv, endings);
  const hintOf = (id: string) => endings.find((e) => e.id === id)?.conditions?.narrative_hint;
  const targets = selectNarrativeCandidates(ranked.suggestions, hintOf);
  if (!targets.length) return; // rule 통과 0 또는 hint 0 → LLM 호출 0 보장.
  const path = getPath(db, conv);
  const turns = buildJudgeContext(path);
  const { verdicts, llmCalled, latencyMs } = await judgeNarratives(
    { complete: exec.complete, model: exec.modelName },
    targets.map((c) => ({ ending_id: c.ending_id, title: endings.find((e) => e.id === c.ending_id)?.title ?? '', narrative_hint: c.narrative_hint, rule_count: c.rule_count })),
    turns,
  );
  for (const c of targets) {
    const v = verdicts[c.ending_id];
    exec.log({
      room_id: conv.id,
      turn_id: ranked.turn_id,
      ending_id: c.ending_id,
      evaluation_version: EVALUATION_VERSION,
      rule_pass: true,
      eligible: v?.eligible ?? false,
      confidence: v?.confidence ?? 0,
      reason_len: v?.reason.length ?? 0,
      llm_called: llmCalled,
      latency_ms: latencyMs,
    });
  }
}

// loadConversation(ctx, …)은 Ctx 전체를 요구하므로, Job은 conversations 1행
// 직접 조회 shim을 쓴다 (판정 입력 읽기 — E4a의 스냅샷 동결과 무관하다).
function loadConversationShim(db: DB, id: string): ConversationRow | undefined {
  return one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id = ?', id);
}

export interface CtxLike {
  db: DB;
  model: { complete: (p: GenParams) => Promise<GenResult> };
  resolvedModel: () => string;
  log: { info: (obj: object, msg: string) => void };
}

/** chat.ts 훅용 어댑터. ctx.log.info 1건 = 관측 1건. */
export function fireEndingEvalJob(ctx: CtxLike, conversationId: string): void {
  void runEndingEvalJob(
    {
      db: ctx.db,
      modelName: ctx.resolvedModel(),
      complete: (p) => ctx.model.complete(p),
      log: (fields) => ctx.log.info(fields, 'ending-llm-eval'),
    },
    conversationId,
  );
}
