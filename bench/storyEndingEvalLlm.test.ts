/** npx tsx bench/storyEndingEvalLlm.test.ts
 * ADR-F8h Slice 3 (story-ending-eval-llm): narrative_hint LLM 보조.
 * N=2 상한, K=5 컨텍스트, V2 비동기 격리(void fire-and-forget),
 * 실패 무시 + 로그 1건, budget_json/generation_log 미오염, 재시도 없음.
 * Isolated: temp DB + injected fake model. No systemd, no live DB,
 * no real model call. No migration.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openDb } from '../apps/server/src/db/index.ts';
import { setHead, insertMessage } from '../apps/server/src/db/tree.ts';
import { GenerationQueue } from '../apps/server/src/model/queue.ts';
import { characterRoutes } from '../apps/server/src/routes/characters.ts';
import { conversationRoutes } from '../apps/server/src/routes/conversations.ts';
import { storyRoutes } from '../apps/server/src/routes/stories.ts';
import {
  LLM_EVAL_MAX_CANDIDATES,
  LLM_EVAL_MAX_TURNS,
  LLM_EVAL_TIMEOUT_MS,
  LLM_EVAL_MAX_TOKENS,
  buildJudgeContext,
  buildJudgePrompt,
  judgeNarratives,
  parseJudgeOutput,
  runEndingEvalJob,
  selectNarrativeCandidates,
  type JudgeLogFields,
} from '../apps/server/src/endingJudge.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';
import type { GenParams, GenResult } from '../apps/server/src/model/adapter.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const okResult = (text: string): GenResult => ({ text, finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 5 });

async function main() {
  const judgeSrc = fs.readFileSync('apps/server/src/endingJudge.ts', 'utf8');
  const chatSrc = fs.readFileSync('apps/server/src/routes/chat.ts', 'utf8');

  await t('D3 constants: N=2, K=5, timeout + token caps present', () => {
    assert.equal(LLM_EVAL_MAX_CANDIDATES, 2);
    assert.equal(LLM_EVAL_MAX_TURNS, 5);
    assert.ok(LLM_EVAL_TIMEOUT_MS > 0 && LLM_EVAL_TIMEOUT_MS <= 60_000);
    assert.ok(LLM_EVAL_MAX_TOKENS > 0 && LLM_EVAL_MAX_TOKENS <= 1024);
  });

  await t('judge never touches generation_log/budget_json, queue registry, or ended_at writes', () => {
    // Fences bind on code, not prose: the header comment names the forbidden stores.
    const code = judgeSrc
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    for (const banned of ['generation_log', 'budget_json', 'queue.register', 'activeList']) {
      assert.equal(code.includes(banned), false, banned);
    }
    // ended_at READ is the ended-room skip (제약 1). What is banned is WRITING it.
    assert.equal(/ended_at\s*=/.test(code), false, 'no ended_at write');
    assert.equal(code.includes('reached_ending_id'), false, 'no reached_ending_id write');
  });

  await t('no retry/backoff/queue mechanics in the judge (non-goals)', () => {
    assert.equal(/retry|backoff|queue\.run/i.test(judgeSrc), false);
  });

  await t('selectNarrativeCandidates: hint-only, rank order, N cap', () => {
    const ranked = [
      { ending_id: 'a', rule_count: 3 },
      { ending_id: 'b', rule_count: 2 },
      { ending_id: 'c', rule_count: 1 },
      { ending_id: 'd', rule_count: 1 },
    ];
    const hintOf = (id: string) => (id === 'b' ? undefined : `hint-${id}`);
    const picked = selectNarrativeCandidates(ranked, hintOf);
    assert.deepEqual(picked.map((p) => p.ending_id), ['a', 'c']);
    assert.equal(picked.length, 2);
  });

  await t('buildJudgeContext: last K turns, chronological, per-row truncation', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: i === 11 ? `m${i}-` + 'x'.repeat(2000) : `m${i}`,
    })) as Parameters<typeof buildJudgeContext>[0];
    const ctx5 = buildJudgeContext(rows);
    assert.equal(ctx5.length, 10);
    assert.ok(ctx5[0].startsWith('user: m2'));
    assert.ok(ctx5[9].length <= 'assistant: '.length + 501 + 1);
    assert.deepEqual(buildJudgeContext(rows.slice(0, 2)), ['user: m0', 'assistant: m1']);
  });

  await t('parseJudgeOutput: strict shape, clamps confidence, null on garbage', () => {
    const good = parseJudgeOutput('xx {"evals": [{"ending_id": "e", "eligible": true, "confidence": 1.7, "reason": "r"}]} yy');
    assert.equal(good?.e.confidence, 1);
    assert.equal(good?.e.matched_condition, 'narrative_hint');
    const neg = parseJudgeOutput('{"evals": [{"ending_id": "e", "eligible": false, "confidence": 0.2, "reason": "r"}]}');
    assert.equal(neg?.e.matched_condition, null);
    assert.equal(parseJudgeOutput('not json'), null);
    assert.equal(parseJudgeOutput('{"evals": "nope"}'), null);
    assert.deepEqual(parseJudgeOutput('{"evals": [{"ending_id": 1}]}'), {}, 'valid doc, no usable entries → empty, still graceful');
  });

  await t('judgeNarratives: 0 candidates → 0 calls, no model touch', async () => {
    let calls = 0;
    const r = await judgeNarratives(
      { complete: async () => { calls++; return okResult('{}'); }, model: 'm' },
      [],
      ['user: hi'],
    );
    assert.deepEqual(r.verdicts, {});
    assert.equal(r.llmCalled, 0);
    assert.equal(calls, 0);
  });

  await t('judgeNarratives: timeout → resolves empty, never throws', async () => {
    const r = await judgeNarratives(
      { complete: async () => { throw new Error('TimeoutError'); }, model: 'm' },
      [{ ending_id: 'e', title: 'T', narrative_hint: 'h', rule_count: 1 }],
      ['user: hi'],
    );
    assert.deepEqual(r.verdicts, {});
    assert.equal(r.llmCalled, 0);
  });

  await t('judgeNarratives: garbage output → empty verdicts, llmCalled 1', async () => {
    const seen: GenParams[] = [];
    const r = await judgeNarratives(
      {
        complete: async (p) => { seen.push(p); return okResult('생각 중...'); },
        model: 'test-model',
      },
      [{ ending_id: 'e', title: 'T', narrative_hint: 'h', rule_count: 1 }],
      ['user: hi'],
    );
    assert.deepEqual(r.verdicts, {});
    assert.equal(r.llmCalled, 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].model, 'test-model');
    assert.equal(seen[0].temperature, 0);
    assert.ok((seen[0].max_tokens ?? 0) <= 1024);
    assert.ok(seen[0].signal instanceof AbortSignal);
    assert.equal(seen[0].generationId, undefined, 'no dump generationId on judge calls');
  });

  await t('judge prompt carries hints + recent turns, asks JSON only', () => {
    const msgs = buildJudgePrompt(
      [{ ending_id: 'e1', title: '재회', narrative_hint: '이름을 불렀다' }],
      ['user: 안녕', 'assistant: 어서 와'],
    );
    const all = msgs.map((m) => m.content).join('\n');
    assert.ok(all.includes('이름을 불렀다'));
    assert.ok(all.includes('user: 안녕'));
    assert.ok(all.includes('evals'));
  });

  // ---- live job paths with fake model ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-ending-eval-llm-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));
  const ctx = {
    db,
    model: {} as unknown as Ctx['model'],
    queue: new GenerationQueue(1),
    log: { error() {}, info() {}, warn() {}, debug() {} } as unknown as Ctx['log'],
    resolvedModel: () => 'test-model',
    setResolvedModel: () => {},
    health: async () => ({ ok: true, checkedAt: 't', latencyMs: 0, models: ['test-model'] }),
  } as Ctx;
  const app = Fastify({ logger: false });
  await app.register(characterRoutes(ctx));
  await app.register(storyRoutes(ctx));
  await app.register(conversationRoutes(ctx));
  await app.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${(app.addresses()[0] as { port: number }).port}`;
  async function api(method: string, url: string, body?: unknown) {
    const res = await fetch(`${origin}${url}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = text;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, json, text };
  }

  const ch = (await api('POST', '/api/characters', { name: '하연', personality: '반장', first_message: '인사' })).json as { id: string };
  const st = await api('POST', '/api/stories', { name: '교실', setting: '학교' });
  const story = st.json as { id: string };
  const put = await api('PUT', `/api/stories/${story.id}`, {
    name: '교실', tagline: '', setting: '학교', minor_cast: [],
    endings: [
      { id: 'h1', title: '재회', conditions: { min_turns: 1, narrative_hint: '이름을 다시 불렀다' } },
      { id: 'h2', title: '이별', conditions: { min_turns: 1, narrative_hint: '등을 돌렸다' } },
      { id: 'h3', title: '유보', conditions: { min_turns: 1, narrative_hint: '침묵했다' } },
      { id: 'plain', title: '열린 결말', conditions: { min_turns: 1 } },
    ],
  });
  assert.equal(put.status, 200, put.text);
  const room = await api('POST', '/api/conversations', { characterId: ch.id, storyId: story.id, mode: 'story' });
  const roomId = (room.json as { id: string }).id;
  const g = db.prepare('SELECT head_message_id AS h FROM conversations WHERE id = ?').get(roomId) as { h: string };
  const u = insertMessage(db, roomId, g.h, 'user', '첫 대사', 'complete', {});
  const a = insertMessage(db, roomId, u.id, 'assistant', '응답', 'complete', {});
  setHead(db, roomId, a.id);

  const runJob = (complete: (p: GenParams) => Promise<GenResult>, logs: JudgeLogFields[]) =>
    runEndingEvalJob({ db, modelName: 'test-model', complete, log: (f) => { logs.push(f); } }, roomId);

  await t('N cap: 3 hinted passers → 1 model call judging 2, plain skipped, 2 logs', async () => {
    let calls = 0;
    let judgedIds: string[] = [];
    const logs: JudgeLogFields[] = [];
    await runJob(async (p) => {
      calls++;
      const userMsg = p.messages.find((m) => m.role === 'user')?.content ?? '';
      judgedIds = [...userMsg.matchAll(/ending_id="([^"]+)"/g)].map((m) => m[1]);
      return okResult('{"evals": [{"ending_id": "h1", "eligible": true, "confidence": 0.9, "reason": "이름을 불렀다"}]}');
    }, logs);
    assert.equal(calls, 1);
    assert.deepEqual(judgedIds, ['h1', 'h2']);
    assert.equal(logs.length, 2);
    const h1 = logs.find((l) => l.ending_id === 'h1')!;
    assert.equal(h1.eligible, true);
    assert.equal(h1.confidence, 0.9);
    assert.equal(h1.reason_len, '이름을 불렀다'.length);
    assert.equal(h1.rule_pass, true);
    assert.equal(h1.evaluation_version, 1);
    assert.equal(h1.llm_called, 1);
    assert.ok(h1.latency_ms >= 0);
    const h2 = logs.find((l) => l.ending_id === 'h2')!;
    assert.equal(h2.eligible, false);
    assert.equal(h2.confidence, 0);
  });

  await t('model throw → job resolves, room untouched, llm_called:0 logs (관측 1건/엔딩)', async () => {
    const logs: JudgeLogFields[] = [];
    await runJob(async () => { throw new Error('boom'); }, logs);
    assert.equal(logs.length, 2);
    for (const l of logs) {
      assert.equal(l.llm_called, 0);
      assert.equal(l.eligible, false);
      assert.equal(l.rule_pass, true);
    }
    const row = db.prepare('SELECT ended_at FROM conversations WHERE id = ?').get(roomId) as { ended_at: null };
    assert.equal(row.ended_at, null);
  });

  await t('no rule passers → 0 calls, 0 logs (fresh room snapshots the hard endings)', async () => {
    const lonely = await api('PUT', `/api/stories/${story.id}`, {
      name: '교실', tagline: '', setting: '학교', minor_cast: [],
      endings: [{ id: 'hard', title: '어려움', conditions: { min_turns: 99, narrative_hint: '언젠가' } }],
    });
    assert.equal(lonely.status, 200, lonely.text);
    // E4a: the PUT cannot touch roomId's frozen snapshot — a new room is needed.
    const fresh = await api('POST', '/api/conversations', { characterId: ch.id, storyId: story.id, mode: 'story' });
    const freshId = (fresh.json as { id: string }).id;
    let calls = 0;
    const logs: JudgeLogFields[] = [];
    await runEndingEvalJob({ db, modelName: 'test-model', complete: async () => { calls++; return okResult('{}'); }, log: (f) => { logs.push(f); } }, freshId);
    assert.equal(calls, 0);
    assert.deepEqual(logs, []);
  });

  await t('ended room → job no-ops without model touch', async () => {
    db.prepare("UPDATE conversations SET ended_at = 't' WHERE id = ?").run(roomId);
    let calls = 0;
    const logs: JudgeLogFields[] = [];
    await runJob(async () => { calls++; return okResult('{}'); }, logs);
    assert.equal(calls, 0);
    assert.deepEqual(logs, []);
    db.prepare('UPDATE conversations SET ended_at = NULL WHERE id = ?').run(roomId);
  });

  await t('V2 wiring: 4 completion sites fire void (non-blocking), OOC excluded on main path', () => {
    const hits = [...chatSrc.matchAll(/void fireEndingEvalJob\(ctx, conv\.id\);/g)].length;
    assert.equal(hits, 4, '1:1 + beat + dialog + hunter');
    assert.ok(/if \(!built\.isOoc\) void fireEndingEvalJob/.test(chatSrc), 'main path skips OOC');
    assert.equal(/await fireEndingEvalJob/.test(chatSrc), false, 'never awaited — streaming latency untouched');
    assert.equal(chatSrc.includes('queue.register') && /ending/i.test(chatSrc.split('queue.register')[0].slice(-200)), false);
  });

  await t('judge bypasses the generation queue and active registry (no 409 self-block)', () => {
    assert.equal(/queue\.run/.test(judgeSrc), false);
    assert.equal(judgeSrc.includes('register('), false);
  });

  await app.close();
  console.log(`PASS=${passed}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
