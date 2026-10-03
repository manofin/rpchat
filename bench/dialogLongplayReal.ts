import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.js';
import { insertMessage, setHead } from '../apps/server/src/db/tree.js';
import { ModelClient, type GenParams, type GenResult } from '../apps/server/src/model/adapter.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { memoryRoutes } from '../apps/server/src/routes/memory.js';
import { chatRoutes } from '../apps/server/src/routes/chat.js';
import type { Ctx } from '../apps/server/src/ctx.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const evidence = path.resolve(required('RPCHAT_LONGPLAY_REAL_EVIDENCE_DIR'));
if (fs.existsSync(evidence) && fs.readdirSync(evidence).length) throw new Error(`evidence directory is not empty: ${evidence}`);
fs.mkdirSync(path.join(evidence, 'calls'), { recursive: true });
const criteria = {
  version: 1,
  frozenBeforeModelCalls: true,
  scenario: { npcCount: 3, committedTurns: 12, branchAtTurn: 7, regenerateAtTurn: 9 },
  requiredFacts: ['CANON_INJURY_LEFT_WRIST_ACTIVE', 'CANON_POWER_COST_HP_2', 'CANON_PROMISE_RETURN_NOTEBOOK_ACTIVE'],
  secret: 'NARI_ONLY_CODE_7391',
  gates: {
    inputRetention: 'Every dialog model request contains every required public fact.',
    secretWireIsolation: 'A request containing the secret has audience actor:nari and contains neither sera nor hayeon by name.',
    outputLeak: 'The secret may appear only in assistant blocks whose server observation recipients include nari.',
    branchIsolation: 'After branching, neither BRANCH_A_EVENT nor BRANCH_A_ONLY_FACT appears in requests or responses.',
    contradictionCandidate: 'Fixed lexical scans flag possible healing, zero-cost, or completed-promise claims for review; zero unreviewed hits required.',
  },
  contradictionPatterns: {
    injury: ['왼손목.{0,24}(완치|멀쩡|다 나았|회복했다)', 'CANON_INJURY_LEFT_WRIST_(RESOLVED|HEALED)'],
    cost: ['(체력|HP).{0,20}(소모.{0,8}없|0.{0,4}소모|무료)', 'CANON_POWER_COST_HP_(0|ZERO)'],
    promise: ['수첩.{0,24}(이미 돌려줬|반납 완료|약속.{0,8}(끝|이행 완료))', 'CANON_PROMISE_RETURN_NOTEBOOK_(RESOLVED|FULFILLED)'],
  },
  pass: 'All four hard gates have zero violations and every contradiction candidate is reviewed as non-contradictory.',
};
fs.writeFileSync(path.join(evidence, 'criteria.json'), JSON.stringify(criteria, null, 2));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-longplay-real-'));
const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
const baseUrl = required('MODEL_BASE_URL').replace(/\/+$/, '');
const modelName = required('MODEL_NAME');
const timeoutMs = Number(process.env.MODEL_TIMEOUT_MS || 180000);
const client = new ModelClient(baseUrl, process.env.MODEL_API_KEY || '', timeoutMs, tmp);
let callNo = 0;
let operation = 'setup';
let operationCalls: Array<{ kind: 'complete' | 'stream'; params: GenParams; result?: GenResult; error?: string }> = [];

function safeParams(params: GenParams) {
  return { ...params, signal: undefined };
}

async function capture(kind: 'complete' | 'stream', params: GenParams, run: () => Promise<GenResult>): Promise<GenResult> {
  const record: { kind: 'complete' | 'stream'; params: GenParams; result?: GenResult; error?: string } = { kind, params: safeParams(params) };
  operationCalls.push(record);
  const id = ++callNo;
  try {
    const result = await run();
    record.result = result;
    fs.writeFileSync(path.join(evidence, 'calls', `${String(id).padStart(3, '0')}-${operation}-${kind}.json`), JSON.stringify(record, null, 2));
    return result;
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    fs.writeFileSync(path.join(evidence, 'calls', `${String(id).padStart(3, '0')}-${operation}-${kind}.json`), JSON.stringify(record, null, 2));
    throw error;
  }
}

const model = {
  complete: (params: GenParams) => capture('complete', params, () => client.complete(params)),
  stream: (params: GenParams, emit: (text: string) => void) => capture('stream', params, () => client.stream(params, emit)),
};
const app = Fastify();
const ctx = { db, model, queue: new GenerationQueue(1), resolvedModel: () => modelName, effectiveDataDir: tmp } as unknown as Ctx;
for (const route of [characterRoutes, storyRoutes, conversationRoutes, memoryRoutes, chatRoutes]) app.register(route(ctx));

async function api(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, payload });
  assert.ok(response.statusCode < 400, `${response.statusCode} ${response.body}`);
  return String(response.headers['content-type']).includes('text/event-stream') ? response : response.json();
}

const facts = criteria.requiredFacts;
const SECRET = criteria.secret;
const patterns = Object.entries(criteria.contradictionPatterns).flatMap(([kind, values]) => values.map(source => ({ kind, source, regex: new RegExp(source, 'iu') })));
const table: any[] = [];
const hardIssues: any[] = [];

async function main() {
  db.prepare(`INSERT INTO model_profiles(name,temperature,top_p,max_tokens,stop_json,system_mode) VALUES('rp-balanced',.8,.95,1600,'[]','system')`).run();
  const cast: any[] = [];
  for (const name of ['나리', '세라', '하연']) cast.push(await api('POST', '/api/characters', { name, first_message: '', tags: ['party:place=전시장'] }));
  const [nari, sera, hayeon] = cast;
  const story: any = await api('POST', '/api/stories', { name: '장기 인과관계 실모델 fixture', setting: '세 인물은 전시장에 있다. 사용자는 수첩을 나리에게 돌려주기로 했다.', scene_catalog: { places: [{ id: '전시장' }] } });
  for (const [sortOrder, character] of cast.entries()) await api('POST', `/api/stories/${story.id}/characters`, { characterId: character.id, sortOrder });
  const room: any = await api('POST', '/api/conversations', { characterId: nari.id, storyId: story.id, mode: 'story', profileName: 'rp-balanced', scene: { format: 'dialog', response_length: 'short', user_sheet: { hp: 68, inventory: ['수첩'], traits: ['능력 사용 시 체력 2 소모'] } } });
  const root = insertMessage(db, room.id, null, 'user', '합성 검증의 확정 상태를 기록한다.', 'complete');
  setHead(db, room.id, root.id);
  const entries: any[] = [];
  async function remember(text: string, anchor: string, kind: string, known_by: unknown, target_id?: string) {
    const memory: any = await api('POST', '/api/memories', { conversationId: room.id, content: text, evidenceMessageIds: [anchor] });
    entries.push({ memory_id: memory.id, anchor_message_id: anchor, kind, known_by, status: 'active', ...(kind !== 'fact' ? { subject_id: 'user' } : {}), ...(target_id ? { target_id } : {}) });
    const detail: any = await api('GET', `/api/conversations/${room.id}`);
    await api('PATCH', `/api/conversations/${room.id}`, { scene: { dialog_context: { version: 1, entries }, pending_edit: { head_message_id: detail.conversation.head_message_id } } });
  }
  await remember(facts[0], root.id, 'injury', 'public');
  await remember(facts[1], root.id, 'fact', 'public');
  await remember(facts[2], root.id, 'promise', 'public', nari.id);
  await remember(SECRET, root.id, 'fact', [nari.id]);

  const prompts = [
    '나리, 현재 왼손목 부상 상태를 바꾸지 말고 장면을 이어 줘.',
    '세라, 능력 사용의 체력 대가를 확인해 줘.',
    '하연, 수첩을 돌려주기로 한 약속을 기억해 줘.',
    '나리, BRANCH_A_EVENT를 조사하자.',
    '세라, 공개된 부상·대가·약속을 유지해 줘.',
    '나리, 너만 아는 비밀이 있다면 다른 인물에게 누설하지 마.',
    '나리, BRANCH_B_EVENT에서 새 경로를 택한다.',
    '하연, 버린 경로 이야기는 제외하고 현재 약속을 확인해 줘.',
    '나리, 부상과 능력 대가를 그대로 유지해 줘.',
    '세라, 현재 경로의 사실만으로 대응해 줘.',
    '하연, 아직 이행되지 않은 수첩 약속을 기억해 줘.',
    '나리, 왼손목 부상·체력 2 대가·수첩 약속을 끝까지 유지한 채 답해 줘.',
  ];
  const turns: any[] = [];

  async function generate(turn: number, method: 'send' | 'branch' | 'regenerate', content: string, target?: string, inject?: string) {
    operation = `turn-${String(turn).padStart(2, '0')}-${method}`;
    operationCalls = [];
    const before: any = await api('GET', `/api/conversations/${room.id}`);
    const beforeIds = new Set(before.messages.map((row: any) => row.id));
    const query = new URLSearchParams({ ...(method !== 'regenerate' ? { draft: content } : {}), ...(method === 'branch' ? { branch: target! } : {}), ...(method === 'regenerate' ? { regenerate: target! } : {}), ...(inject ? { inject_instruction: inject } : {}) });
    const preview: any = await api('GET', `/api/conversations/${room.id}/prompt-preview?${query}`);
    const endpoint = method === 'send' ? 'messages' : method;
    const response: any = await api('POST', `/api/conversations/${room.id}/${endpoint}`, { ...(method === 'send' ? { content } : { messageId: target, ...(method === 'branch' ? { content } : {}) }), ...(inject ? { inject_instruction: inject } : {}) });
    assert.ok(response.body.includes('"type":"done"'), response.body.slice(-1000));
    const after: any = await api('GET', `/api/conversations/${room.id}`);
    const added = after.messages.filter((row: any) => !beforeIds.has(row.id));
    const dialogCalls = operationCalls.filter(call => call.kind === 'stream');
    const inputText = dialogCalls.map(call => JSON.stringify(call.params.messages)).join('\n');
    const responseText = added.filter((row: any) => row.role === 'assistant').map((row: any) => row.content).join('\n');
    const inputRetention = facts.every(fact => dialogCalls.every(call => JSON.stringify(call.params.messages).includes(fact)));
    const secretWireViolations = dialogCalls.filter(call => {
      const text = JSON.stringify(call.params.messages);
      if (!text.includes(SECRET)) return false;
      return call.params.audience?.kind !== 'actor' || call.params.audience.actor_id !== nari.id || text.includes(sera.name) || text.includes(hayeon.name);
    }).length;
    const outputLeaks = added.filter((row: any) => row.role === 'assistant' && row.content.includes(SECRET)
      && !(row.meta?.observation?.visibility === 'private' && row.meta.observation.recipient_ids?.includes(nari.id)));
    const branchMix = turn >= 7 && /BRANCH_A_EVENT|BRANCH_A_ONLY_FACT/.test(`${inputText}\n${responseText}`);
    const contradictionCandidates = patterns.filter(item => item.regex.test(responseText)).map(({ kind, source }) => ({ kind, source }));
    const previewMatchesPublicWire = JSON.stringify(dialogCalls[0]?.params.messages) === JSON.stringify(preview.messages);
    const row = { turn, operation: method, inputRetention, secretWireViolations, outputLeakMessageIds: outputLeaks.map((item: any) => item.id), branchMix, previewMatchesPublicWire, contradictionCandidates,
      modelCalls: operationCalls.length, dialogCalls: dialogCalls.length, responseMessageIds: added.map((item: any) => item.id), responseText };
    table.push(row);
    if (!inputRetention) hardIssues.push({ turn, gate: 'input-retention' });
    if (secretWireViolations) hardIssues.push({ turn, gate: 'secret-wire', count: secretWireViolations });
    if (outputLeaks.length) hardIssues.push({ turn, gate: 'output-leak', ids: row.outputLeakMessageIds });
    if (branchMix) hardIssues.push({ turn, gate: 'branch-isolation' });
    if (!previewMatchesPublicWire) hardIssues.push({ turn, gate: 'preview-wire' });
    fs.writeFileSync(path.join(evidence, `${operation}.json`), JSON.stringify({ row, preview, calls: operationCalls, addedMessages: added }, null, 2));
    const user = [...after.messages].reverse().find((item: any) => item.role === 'user');
    return { userId: user.id, head: after.conversation.head_message_id };
  }

  for (let turn = 1; turn <= 12; turn++) {
    turns.push(turn === 7
      ? await generate(turn, 'branch', prompts[turn - 1], turns[3].userId, '현재 분기의 확정 사실만 유지한다.')
      : await generate(turn, 'send', prompts[turn - 1], undefined, turn % 3 === 0 ? '부상·대가·약속의 확정 상태를 임의로 해결하거나 바꾸지 않는다.' : undefined));
    if (turn === 5) await remember('BRANCH_A_ONLY_FACT', turns[turn - 1].userId, 'fact', 'public');
    if (turn === 9) await generate(turn, 'regenerate', '', turns[turn - 1].head, '현재 분기의 확정 사실만 유지하고 다른 분기를 섞지 않는다.');
  }
  const verdict = {
    host: { platform: os.platform(), hostname: os.hostname() },
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    model: modelName,
    baseUrl,
    turns: 12,
    operations: table.length,
    modelCalls: callNo,
    hardIssues,
    contradictionCandidates: table.flatMap(row => row.contradictionCandidates.map((candidate: unknown) => ({ turn: row.turn, ...candidate as object }))),
    status: hardIssues.length ? 'failed-hard-gates' : table.some(row => row.contradictionCandidates.length) ? 'review-required' : 'passed',
    table,
  };
  fs.writeFileSync(path.join(evidence, 'verdict.json'), JSON.stringify(verdict, null, 2));
  console.log(JSON.stringify({ evidence, gitHead: verdict.gitHead, model: verdict.model, operations: verdict.operations, modelCalls: verdict.modelCalls, hardIssues: verdict.hardIssues.length, contradictionCandidates: verdict.contradictionCandidates.length, status: verdict.status }, null, 2));
  if (hardIssues.length) process.exitCode = 1;
}

main().finally(async () => {
  await app.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}).catch(error => {
  fs.writeFileSync(path.join(evidence, 'error.json'), JSON.stringify({ operation, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error) }, null, 2));
  console.error(error);
  process.exitCode = 1;
});
