import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Fastify from 'fastify';
import { openMigratedDb, one } from '../apps/server/src/db/index.js';
import { insertMessage, setHead } from '../apps/server/src/db/tree.js';
import { ModelClient, type GenParams } from '../apps/server/src/model/adapter.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { roleFactRoutes } from '../apps/server/src/routes/roleFacts.js';
import { buildSideModePrompt, SIDE_MODE_MAX_TOKENS } from '../apps/server/src/prompt/sideModePrompt.js';
import { config } from '../apps/server/src/config.js';
import type { ConversationRow } from '../apps/server/src/types.js';
import type { Ctx } from '../apps/server/src/ctx.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const evidence = path.resolve(required('RPCHAT_SIDE_MODE_REAL_EVIDENCE_DIR'));
if (fs.existsSync(evidence) && fs.readdirSync(evidence).length) throw new Error(`evidence directory is not empty: ${evidence}`);
fs.mkdirSync(path.join(evidence, 'calls'), { recursive: true });
const criteria = {
  version: 1,
  frozenBeforeModelCalls: true,
  scenario: {
    subject: '사용자', role: '방문객 안내', proposer: 'Alpha', unsupportedClaimant: 'Beta',
    registeredStatus: 'proposed', generatedPerMode: 5,
  },
  graders: {
    alpha: 'Mode contract plus explicit proposed/unconfirmed treatment; no positive user acceptance claim.',
    beta: 'Directional attribution: user is subject, Alpha proposer, Beta unsupported claimant; no NPC becomes role subject.',
  },
  pass: 'All generations pass both preregistered deterministic graders.',
};
fs.writeFileSync(path.join(evidence, 'criteria.json'), JSON.stringify(criteria, null, 2));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-side-role-real-'));
const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
const baseUrl = required('MODEL_BASE_URL').replace(/\/+$/, '');
const modelName = required('MODEL_NAME');
const timeoutMs = Number(process.env.MODEL_TIMEOUT_MS || 180000);
const contextTokens = Number(process.env.MODEL_CONTEXT_TOKENS || 16384);
const client = new ModelClient(baseUrl, process.env.MODEL_API_KEY || '', timeoutMs, tmp);
const app = Fastify();
const ctx = { db, model: client, queue: new GenerationQueue(1), resolvedModel: () => modelName, log: app.log } as unknown as Ctx;
for (const route of [characterRoutes, storyRoutes, conversationRoutes, roleFactRoutes]) app.register(route(ctx));
const originalAuthMode = config.auth.mode;
config.auth.mode = 'none';
let callNo = 0;

async function api(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, payload });
  assert.ok(response.statusCode < 400, `${response.statusCode} ${response.body}`);
  return response.json() as any;
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?。！？]|다\.)\s+|\n+/u).map(value => value.trim()).filter(Boolean);
}

function positiveAcceptance(text: string): string[] {
  return sentences(text).filter(sentence => {
    if (!/(사용자|당신|글쓴이|플레이어).{0,35}(방문객 안내|안내 역할).{0,35}(수락했|수락됨|확정됐|맡기로 했|담당하게 됐)/iu.test(sentence)) return false;
    return !/(아니|않|없|미확정|근거 부족|사실이 아님|주장일 뿐|확인되지)/iu.test(sentence);
  });
}

function grade(mode: 'summary' | 'community', text: string) {
  const alphaReasons: string[] = [];
  if (!/(제안|proposed|미확정|수락.{0,12}(근거|기록).{0,8}(없|부족))/iu.test(text)) alphaReasons.push('proposal status is not explicit');
  if (positiveAcceptance(text).length) alphaReasons.push('user acceptance is asserted positively');
  if (mode === 'summary' && !/Beta/iu.test(text)) alphaReasons.push('unsupported claimant Beta is absent');
  if (mode === 'summary' && !/(충돌|주장|근거.{0,8}없|미확정)/iu.test(text)) alphaReasons.push('claim conflict is absent');
  if (mode === 'community' && !text.trimStart().startsWith('가상 게시판 · 본편에 반영되지 않음')) alphaReasons.push('community disclaimer is missing from first line');

  const betaReasons: string[] = [];
  if (!/(사용자|당신|글쓴이|플레이어).{0,45}(방문객 안내|안내 역할)|(방문객 안내|안내 역할).{0,45}(사용자|당신|글쓴이|플레이어)/iu.test(text)) betaReasons.push('user is not identified as role subject');
  if (!/Alpha.{0,45}제안|제안.{0,45}Alpha/iu.test(text)) betaReasons.push('Alpha is not identified as proposer');
  if (!/Beta.{0,70}(주장|충돌|미확정|근거.{0,12}(없|부족))|(주장|충돌|미확정).{0,70}Beta/iu.test(text)) betaReasons.push('Beta is not identified as unsupported claimant');
  if (/Alpha.{0,30}(방문객 안내|안내 역할).{0,20}(맡|담당)|Beta.{0,30}(방문객 안내|안내 역할).{0,20}(맡|담당)/iu.test(text)) betaReasons.push('an NPC is presented as the role subject');
  return { alpha: { pass: alphaReasons.length === 0, reasons: alphaReasons }, beta: { pass: betaReasons.length === 0, reasons: betaReasons } };
}

async function main() {
  db.prepare(`INSERT INTO model_profiles(name,temperature,top_p,max_tokens,stop_json,system_mode) VALUES('rp-balanced',.8,.95,1600,'[]','system')`).run();
  const alpha = await api('POST', '/api/characters', { name: 'Alpha', first_message: '' });
  const beta = await api('POST', '/api/characters', { name: 'Beta', first_message: '' });
  const story = await api('POST', '/api/stories', { name: '역할 판정 실모델 fixture', setting: '공개 안내 데스크.', scene_catalog: { places: [{ id: '안내 데스크' }] } });
  await api('POST', `/api/stories/${story.id}/characters`, { characterId: alpha.id, sortOrder: 0 });
  await api('POST', `/api/stories/${story.id}/characters`, { characterId: beta.id, sortOrder: 1 });
  const room = await api('POST', '/api/conversations', { characterId: alpha.id, storyId: story.id, mode: 'story', profileName: 'rp-balanced', scene: { format: 'dialog' } });
  const root = insertMessage(db, room.id, null, 'user', '도울 역할이 있다면 제안해 줘.', 'complete');
  const proposal = insertMessage(db, room.id, root.id, 'assistant', '사용자에게 방문객 안내 역할을 제안할게.', 'complete', { block_kind: 'line', speaker_character_id: alpha.id, speaker_name: 'Alpha' });
  const claim = insertMessage(db, room.id, proposal.id, 'assistant', '사용자는 방문객 안내를 맡기로 했잖아.', 'complete', { block_kind: 'line', speaker_character_id: beta.id, speaker_name: 'Beta' });
  setHead(db, room.id, claim.id);
  const registered = await api('POST', `/api/conversations/${room.id}/role-facts`, {
    anchorMessageId: root.id, kind: 'role', subjectId: 'user', description: '방문객 안내', proposedBy: alpha.id,
    sourceMessageIds: [proposal.id], audience: { visibility: 'public' },
  });
  await api('POST', `/api/conversations/${room.id}/role-facts/${registered.proposalId}/claim`, {
    anchorMessageId: root.id, speakerId: beta.id, sourceMessageId: claim.id, claimedStatus: 'accepted',
  });
  const before = db.serialize();
  const conv = one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id = ?', room.id)!;
  const rows: any[] = [];
  for (const mode of ['summary', 'community'] as const) {
    for (let sample = 1; sample <= 5; sample++) {
      const prompt = mode === 'summary'
        ? '역할 제안, 실제 수락 여부, 발화 충돌을 주체별로 분명히 정리해 줘.'
        : '역할 제안과 합의 여부를 혼동하지 않는 공개 게시판 반응을 보여 줘.';
      const built = buildSideModePrompt(db, conv, mode, prompt, contextTokens);
      assert.equal(built.overflow, false);
      const params: GenParams = { model: modelName, messages: built.messages, max_tokens: SIDE_MODE_MAX_TOKENS,
        temperature: mode === 'summary' ? .3 : .8, top_p: .95 };
      const id = ++callNo;
      let result;
      try {
        result = await client.complete(params);
        fs.writeFileSync(path.join(evidence, 'calls', `${String(id).padStart(2, '0')}-${mode}-${sample}.json`), JSON.stringify({ params, result }, null, 2));
      } catch (error) {
        fs.writeFileSync(path.join(evidence, 'calls', `${String(id).padStart(2, '0')}-${mode}-${sample}.json`), JSON.stringify({ params, error: error instanceof Error ? error.message : String(error) }, null, 2));
        throw error;
      }
      const grades = grade(mode, result.text);
      const row = { mode, sample, grades, text: result.text, usage: result.usage, finishReason: result.finishReason, ttftMs: result.ttftMs, totalMs: result.totalMs };
      rows.push(row);
      fs.writeFileSync(path.join(evidence, `${mode}-${sample}.json`), JSON.stringify(row, null, 2));
    }
  }
  const after = db.serialize();
  const byMode = Object.fromEntries(['summary', 'community'].map(mode => {
    const selected = rows.filter(row => row.mode === mode);
    return [mode, { generated: selected.length, alphaPass: selected.filter(row => row.grades.alpha.pass).length,
      betaPass: selected.filter(row => row.grades.beta.pass).length,
      passedBoth: selected.filter(row => row.grades.alpha.pass && row.grades.beta.pass).length }];
  }));
  const verdict = {
    host: { platform: os.platform(), hostname: os.hostname() },
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    model: modelName, baseUrl, contextTokens, modelCalls: callNo, retries: 0, errors: 0,
    originalDatabaseTouched: false, isolatedDatabaseUnchangedDuringGeneration: before.equals(after),
    parameters: { summary: { max_tokens: SIDE_MODE_MAX_TOKENS, temperature: .3, top_p: .95 }, community: { max_tokens: SIDE_MODE_MAX_TOKENS, temperature: .8, top_p: .95 } },
    byMode, failures: rows.filter(row => !row.grades.alpha.pass || !row.grades.beta.pass).map(row => ({ mode: row.mode, sample: row.sample, grades: row.grades })),
    status: rows.every(row => row.grades.alpha.pass && row.grades.beta.pass) ? 'passed' : 'not-passed', rows,
  };
  fs.writeFileSync(path.join(evidence, 'verdict.json'), JSON.stringify(verdict, null, 2));
  console.log(JSON.stringify({ evidence, gitHead: verdict.gitHead, model: verdict.model, modelCalls: verdict.modelCalls, byMode, status: verdict.status }, null, 2));
  if (verdict.status !== 'passed') process.exitCode = 1;
}

main().finally(async () => {
  config.auth.mode = originalAuthMode;
  await app.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}).catch(error => {
  fs.writeFileSync(path.join(evidence, 'error.json'), JSON.stringify({ error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error) }, null, 2));
  console.error(error);
  process.exitCode = 1;
});
