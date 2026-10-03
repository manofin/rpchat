import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { execFileSync } from 'node:child_process';
import { openMigratedDb } from '../apps/server/src/db/index.js';
import { insertMessage, setHead } from '../apps/server/src/db/tree.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { memoryRoutes } from '../apps/server/src/routes/memory.js';
import { chatRoutes } from '../apps/server/src/routes/chat.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { GenParams } from '../apps/server/src/model/adapter.js';

// Strict wire boundary, not merely separation inside a shared narrator packet.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-longplay-'));
const evidence = process.env.RPCHAT_LONGPLAY_EVIDENCE_DIR || path.join(tmp, 'evidence');
fs.mkdirSync(evidence, { recursive: true });
const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
const captures: Array<{ kind: string; params: GenParams }> = [];
const issues: Array<{ turn: number; gate: string; detail: string }> = [];
const records: any[] = [];
let output = '';
const result = (text: string) => ({ text, usage: null, finishReason: 'stop', ttftMs: 1, totalMs: 1 });
const model = {
  complete: async (params: GenParams) => { captures.push({ kind: 'complete', params }); return result('null'); },
  stream: async (params: GenParams, emit: (text: string) => void) => { captures.push({ kind: 'stream', params }); emit(output); return result(output); },
};
const app = Fastify();
const ctx = { db, model, queue: new GenerationQueue(1), resolvedModel: () => 'mock', effectiveDataDir: tmp } as unknown as Ctx;
for (const route of [characterRoutes, storyRoutes, conversationRoutes, memoryRoutes, chatRoutes]) app.register(route(ctx));
async function api(method: any, url: string, payload?: unknown) {
  const r = await app.inject({ method, url, payload });
  assert.ok(r.statusCode < 400, `${r.statusCode} ${r.body}`);
  return String(r.headers['content-type']).includes('text/event-stream') ? r : r.json();
}
const SECRET = 'NARI_ONLY_CODE_7391';
const facts = ['USER_LEFT_WRIST_INJURY', 'USER_POWER_COST_TWO_HP', 'USER_PROMISE_RETURN_NOTEBOOK'];
function check(turn: number, gate: string, condition: boolean, detail: string) {
  if (!condition) issues.push({ turn, gate, detail });
}
async function main() {
  db.prepare(`INSERT INTO model_profiles(name,temperature,top_p,max_tokens,stop_json,system_mode) VALUES('rp-balanced',.8,.95,400,'[]','system')`).run();
  const cast = [];
  for (const name of ['나리', '세라', '하연']) cast.push(await api('POST', '/api/characters', { name, first_message: '', tags: ['party:place=전시장'] }));
  const story = await api('POST', '/api/stories', { name: '장기 인과관계 합성 fixture', setting: '전시장의 수첩을 돌려주기로 했다.', scene_catalog: { places: [{ id: '전시장' }] } });
  for (const [sortOrder, c] of cast.entries()) await api('POST', `/api/stories/${story.id}/characters`, { characterId: c.id, sortOrder });
  const room = await api('POST', '/api/conversations', { characterId: cast[0].id, storyId: story.id, mode: 'story', scene: { format: 'dialog', user_sheet: { hp: 68, inventory: ['수첩'], traits: ['능력 사용 시 체력 2 소모'] } } });
  const root = insertMessage(db, room.id, null, 'user', '부상과 대가, 약속을 기록한다.', 'complete');
  setHead(db, room.id, root.id);
  const entries: any[] = [];
  async function remember(text: string, anchor: string, kind: string, known_by: unknown, target_id?: string) {
    const m = await api('POST', '/api/memories', { conversationId: room.id, content: text, evidenceMessageIds: [anchor] });
    entries.push({ memory_id: m.id, anchor_message_id: anchor, kind, known_by, status: 'active', ...(kind !== 'fact' ? { subject_id: 'user' } : {}), ...(target_id ? { target_id } : {}) });
    const detail = await api('GET', `/api/conversations/${room.id}`);
    await api('PATCH', `/api/conversations/${room.id}`, { scene: { dialog_context: { version: 1, entries }, pending_edit: { head_message_id: detail.conversation.head_message_id } } });
  }
  await remember(facts[0], root.id, 'injury', 'public');
  await remember(facts[1], root.id, 'fact', 'public');
  await remember(facts[2], root.id, 'promise', 'public', cast[0].id);
  await remember(SECRET, root.id, 'fact', [cast[0].id]);
  const turns: any[] = [];
  async function generate(turn: number, method: 'send' | 'branch' | 'regenerate', content: string, target?: string, inject?: string) {
    const query = new URLSearchParams({ ...(method !== 'regenerate' ? { draft: content } : {}), ...(method === 'branch' ? { branch: target! } : {}), ...(method === 'regenerate' ? { regenerate: target! } : {}), ...(inject ? { inject_instruction: inject } : {}) });
    const preview = await api('GET', `/api/conversations/${room.id}/prompt-preview?${query}`);
    captures.length = 0;
    output = `전시장의 시계가 흐른다.\n나리 | ${turn}번째 장면을 살펴보자.\n세라 | 창가를 지킬게.\n하연 | 출입문에서 기다릴게.`;
    const url = method === 'send' ? 'messages' : method;
    const response = await api('POST', `/api/conversations/${room.id}/${url}`, { ...(method === 'send' ? { content } : { messageId: target, ...(method === 'branch' ? { content } : {}) }), ...(inject ? { inject_instruction: inject } : {}) });
    check(turn, 'completed', response.body.includes('"type":"done"'), method);
    const requests = captures.filter(c => c.kind === 'stream');
    check(turn, 'wire-captured', requests.length > 0, 'no script adapter call');
    // Current engine has one shared S request. Never pretend actor packets are separate wire requests.
    const script = requests[0]?.params.messages;
    check(turn, 'preview-equals-wire', JSON.stringify(script) === JSON.stringify(preview.messages), method);
    for (const capture of requests) {
      const text = JSON.stringify(capture.params.messages);
      for (const fact of facts) check(turn, 'persistent-fact', text.includes(fact), fact);
      for (const actor of cast.slice(1)) {
        const servesActor = text.includes(actor.name);
        check(turn, 'unknown-actor-wire-secret', !(servesActor && text.includes(SECRET)), `${actor.name}: common S input contains unassigned secret`);
      }
      if (turn >= 7) {
        check(turn, 'branch-isolation', !text.includes('BRANCH_A_ONLY_FACT'), 'discarded evidence');
        check(turn, 'branch-isolation', !text.includes('BRANCH_A_EVENT'), 'discarded user input');
      }
      if (inject) check(turn, 'inject-present', text.includes(inject), inject);
    }
    const detail = await api('GET', `/api/conversations/${room.id}`);
    const user = [...detail.messages].reverse().find((m: any) => m.role === 'user');
    const info = [...detail.messages].reverse().find((m: any) => m.meta.block_kind === 'info');
    check(turn, 'saved-state', info?.meta.scene_state?.after_delta?.user_sheet?.hp === 68, 'HP snapshot');
    const saved = { turn, operation: method, preview, calls: JSON.parse(JSON.stringify(captures)), head: detail.conversation.head_message_id };
    records.push(saved);
    fs.writeFileSync(path.join(evidence, `turn-${String(turn).padStart(2, '0')}-${method}.json`), JSON.stringify(saved, null, 2));
    return { userId: user.id, head: detail.conversation.head_message_id };
  }
  for (let turn = 1; turn <= 12; turn++) {
    const content = turn === 4 ? '나리, BRANCH_A_EVENT' : `나리, 공개 장면 ${turn}`;
    turns.push(turn === 7
      ? await generate(turn, 'branch', '나리, BRANCH_B_EVENT', turns[3].userId, 'BRANCH_INJECT_MARKER')
      : await generate(turn, 'send', content, undefined, turn % 3 === 0 ? `INJECT_MARKER_${turn}` : undefined));
    if (turn === 5) await remember('BRANCH_A_ONLY_FACT', turns[turn - 1].userId, 'fact', 'public');
    if (turn === 9) await generate(turn, 'regenerate', '', turns[turn - 1].head, 'REGENERATE_INJECT_MARKER');
  }
  fs.writeFileSync(path.join(evidence, 'verdict.json'), JSON.stringify({ host: { platform: os.platform(), hostname: os.hostname() }, gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baseline: 'c890148', turns: 12, generationOperations: records.length, realModelCalls: 0, issues, gates: ['persistent-fact', 'unknown-actor-wire-secret', 'branch-isolation', 'preview-equals-wire', 'saved-state', 'inject-present'], knownBoundary: 'single_narrator_request' }, null, 2));
  console.log(`Evidence: ${evidence}`);
  for (const gate of ['persistent-fact', 'unknown-actor-wire-secret', 'branch-isolation', 'preview-equals-wire', 'saved-state', 'inject-present']) console.log(`${gate}: ${issues.filter(i => i.gate === gate).length} violations`);
  assert.deepEqual(issues, [], 'longplay wire boundary does not satisfy the Goal');
  console.log('ok 1 three-NPC twelve-turn causal and branch boundary');
}
main().finally(async () => { await app.close(); db.close(); if (!evidence.startsWith(tmp + path.sep)) fs.rmSync(tmp, { recursive: true, force: true }); }).catch(e => { console.error(e); process.exitCode = 1; });
