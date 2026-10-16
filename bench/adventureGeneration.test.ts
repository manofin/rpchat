// npm run test:benches -- adventureGeneration — scripted adapter, real HTTP/SSE, temporary DB.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { openMigratedDb, one } from '../apps/server/src/db/index.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { chatRoutes } from '../apps/server/src/routes/chat.js';
import { adventureRoutes } from '../apps/server/src/routes/adventure.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { GenParams, GenResult } from '../apps/server/src/model/adapter.js';
import type { Scene, ConversationRow } from '../apps/server/src/types.js';

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-adventure-generation-'));
  const db = openMigratedDb(temp, path.resolve('apps/server/migrations'));
  const app = Fastify();
  const calls: string[] = [];
  let fail = false;
  const result = (text: string): GenResult => ({ text, finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 });
  const model = {
    complete: async (p: GenParams) => {
      const text = p.messages.map(m => m.content).join('\n'); calls.push(text);
      if (text.includes('장면 진행 판정기')) return result(JSON.stringify({ base_version: Number(text.match(/\{"base_version": (\d+)\}/)?.[1] ?? 0), money_delta: -1, inventory_add: '호미', quest_set: '자동 수락', grade_up: true }));
      if (text.includes('입력 초안만 쓴다')) return result('<choices>["조건 질문","보류","떠나기"]</choices>');
      return result('접수원은 답을 기다린다.');
    },
    stream: async (p: GenParams, token: (s: string) => void) => {
      const prompt = p.messages.map(m => m.content).join('\n'); calls.push(prompt);
      if (fail) throw new Error('scripted generation failure');
      const text = prompt.includes('대본으로 쓴다') ? '나리 | 조건을 먼저 확인해 주세요.' : '조건을 먼저 확인해 주세요.\n속마음: 기다리자.';
      token(text); return result(text);
    },
  };
  const ctx = { db, model, queue: new GenerationQueue(1), resolvedModel: () => 'mock', log: app.log } as unknown as Ctx;
  for (const route of [characterRoutes, storyRoutes, conversationRoutes, chatRoutes, adventureRoutes]) app.register(route(ctx));
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const api = async (method: string, url: string, body?: unknown) => {
    const r = await fetch(address + url, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text(); let data: any; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, text };
  };
  let checks = 0;
  const ok = (name: string, fn: () => void) => { fn(); console.log(`ok ${++checks} ${name}`); };
  try {
    const nari = (await api('POST', '/api/characters', { name: '나리', first_message: '무엇을 알아볼까요?' })).data;
    const sera = (await api('POST', '/api/characters', { name: '세라', first_message: '' })).data;
    const story = (await api('POST', '/api/stories', { name: '합성 의뢰', scene_catalog: { places: [], items: ['호미'], grades: ['불', '치'] } })).data;
    for (const format of ['beat', 'dialog']) {
      fail = false; calls.length = 0;
      const created = await api('POST', '/api/conversations', { characterId: nari.id, storyId: story.id, participantIds: [nari.id, sera.id], scene: { format, user_sheet: { money: 2, inventory: [] }, hunter: { trait: { grade: '불' } } } });
      assert.equal(created.status, 201, created.text);
      const id = created.data.id;
      const row = () => one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id=?', id)!;
      const state = (): Scene => JSON.parse(row().scene_json);
      for (const action of [{ kind: 'initialize', currency: '은화', balance: 2, rank: '불', experience: 0, skills: [] }, { kind: 'register', organization: '유사단', fee: 1 }]) {
        const r = await api('POST', `/api/conversations/${id}/adventure-actions`, { expected_head_id: row().head_message_id, expected_scene_version: state().scene_version ?? 0, idempotency_key: randomUUID(), action });
        assert.equal(r.status, 201, r.text);
      }
      const before = state().adventure;
      const generated = await api('POST', `/api/conversations/${id}/messages`, { content: '나리, 의뢰 조건만 알려 주세요. 수락과 대여는 보류합니다.' });
      ok(`${format}: real send blocks scripted resource mutations and supplies confirmed state`, () => {
        assert.equal(generated.status, 200, generated.text); assert.doesNotMatch(generated.text, /"type":"error"/);
        assert.deepEqual(state().adventure, before); assert.deepEqual(state().user_sheet?.inventory, []);
        assert.equal(state().hunter?.quest, undefined); assert.equal(state().hunter?.trait?.grade, '불');
        assert.ok(calls.some(text => text.includes('"balance":1') && text.includes('제안·질문·고려는 실행이 아니다')));
      });
      const generatedHead = row().head_message_id;
      const regenerated = await api('POST', `/api/conversations/${id}/regenerate`, { messageId: generatedHead });
      ok(`${format}: regenerating the narrative cannot charge the registration again`, () => {
        assert.equal(regenerated.status, 200); assert.doesNotMatch(regenerated.text, /"type":"error"/); assert.deepEqual(state().adventure, before);
      });
      fail = true;
      const failed = await api('POST', `/api/conversations/${id}/messages`, { content: '나리, 조건을 다시 물어봅니다.' });
      ok(`${format}: model failure preserves prior human-confirmed state`, () => {
        assert.match(failed.text, /"type":"error"/); assert.deepEqual(state().adventure, before);
      });
    }
  } finally { await app.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
