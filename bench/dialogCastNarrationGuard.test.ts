/** Exact room cast matching for narration-only scripts; mock model and temp DB only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { parseScript } from '../apps/server/src/prompt/dialogScript.ts';
import { adaptChatEvents, createChatEventStream } from '../apps/server/src/contracts/chatEventAdapter.ts';
import { openMigratedDb } from '../apps/server/src/db/index.ts';
import { GenerationQueue } from '../apps/server/src/model/queue.ts';
import { characterRoutes } from '../apps/server/src/routes/characters.ts';
import { storyRoutes } from '../apps/server/src/routes/stories.ts';
import { conversationRoutes } from '../apps/server/src/routes/conversations.ts';
import { chatRoutes } from '../apps/server/src/routes/chat.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';

const CAST = [{ id: 'hs', name: '한소연', aliases: ['소연', 'Soyeon', '등록된긴별칭'.repeat(8)] }];
const PROSE = 'A | B 구간은 막혀 있다.';
let passed = 0;
let failed = 0;
async function t(name: string, fn: () => unknown) {
  try { await fn(); console.log(`ok ${++passed} ${name}`); }
  catch (error) { failed++; console.error(`not ok ${name}`, error); }
}

async function main() {
  await t('empty speakers preserve A | B prose and an unknown prefix verbatim', () => {
    const text = `${PROSE}\n낯선 사람 | 지나갔다.`;
    assert.deepEqual(parseScript(text, [], CAST).items, [{ kind: 'narration', text }]);
  });
  await t('room names and aliases become separate narration, never dialogue', () => {
    const result = parseScript('한소연 | 안녕\n소연 | 잘 지내', [], CAST);
    assert.deepEqual(result.items, [{ kind: 'narration', text: '안녕' }, { kind: 'narration', text: '잘 지내' }]);
    assert.deepEqual(result.spoke_ids, []);
    assert.deepEqual(result.rejected_names, ['한소연', '소연']);
  });
  await t('near matches, case folding and Markdown are not exact room identities', () => {
    for (const prefix of ['한 소연', 'soyeon', '**한소연**', '한소연:', '- 한소연']) {
      const text = `${prefix} | 그대로 남는다.`;
      assert.deepEqual(parseScript(text, [], CAST).items, [{ kind: 'narration', text }]);
    }
  });
  await t('registered long alias works without the 24-character guess', () => {
    assert.deepEqual(parseScript(`${CAST[0].aliases[2]} | 안녕`, [], CAST).items, [{ kind: 'narration', text: '안녕' }]);
  });
  await t('missing roster and empty speech preserve original text', () => {
    assert.deepEqual(parseScript('한소연 | 안녕', []).items, [{ kind: 'narration', text: '한소연 | 안녕' }]);
    assert.deepEqual(parseScript('한소연 |', [], CAST).items, [{ kind: 'narration', text: '한소연 |' }]);
  });
  await t('nonempty speaker contract is unchanged by room cast', () => {
    const text = '한소연 | 안녕\n소연 | 잘 지내\n외부인 | 여기에 있어.';
    assert.deepEqual(parseScript(text, CAST, CAST), parseScript(text, CAST));
  });
  await t('streaming and rebuilt script events share strict room matching', () => {
    const content = `${PROSE}\n한소연 | 안녕\n소연 | 잘 지내\n`;
    const message = { id: 'script', role: 'assistant' as const, content, meta: {
      chat_event_script: true, chat_event_actors: [], chat_event_cast: CAST,
    } };
    for (const events of [adaptChatEvents(message), createChatEventStream(message)(content).events]) {
      assert.ok(events.every(event => event.type === 'narration'));
      assert.deepEqual(events.map(event => event.text), [PROSE, '안녕', '잘 지내']);
    }
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-cast-narration-'));
  const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
  const app = Fastify();
  let polled: any;
  let roomId = '';
  const content = `${PROSE}\n한소연 | 안녕\n소연 | 잘 지내\n`;
  const ctx = { db, queue: new GenerationQueue(1), log: app.log, resolvedModel: () => 'mock',
    model: {
      complete: async () => ({ text: '{}', finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 }),
      stream: async (_params: unknown, emit: (text: string) => void) => {
        emit(content);
        await new Promise(resolve => setTimeout(resolve, 900));
        emit('\n');
        polled = (await app.inject({ method: 'GET', url: `/api/conversations/${roomId}` })).json();
        return { text: content, finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 2 };
      },
    },
  } as unknown as Ctx;
  for (const route of [characterRoutes, storyRoutes, conversationRoutes, chatRoutes]) await app.register(route(ctx));
  const api = async (method: any, url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, payload }); assert.ok(r.statusCode < 400, r.body); return r;
  };
  try {
    db.prepare("INSERT INTO model_profiles(name,temperature,top_p,max_tokens,stop_json,system_mode) VALUES('rp-balanced',.8,.95,800,'[]','system')").run();
    const host = (await api('POST', '/api/characters', { name: '한소연', tags: ['party:alias=소연'], first_message: '' })).json();
    const other = (await api('POST', '/api/characters', { name: '다른 인물', first_message: '' })).json();
    const story = (await api('POST', '/api/stories', { name: '합성 테스트 이야기' })).json();
    for (const [sortOrder, c] of [host, other].entries()) await api('POST', `/api/stories/${story.id}/characters`, { characterId: c.id, sortOrder });
    roomId = (await api('POST', '/api/conversations', { characterId: host.id, storyId: story.id, scene: { format: 'dialog' } })).json().id;
    for (const endpoint of ['messages', 'continue']) await t(`actual ${endpoint}: SSE, polling and saved narration retain prose and strip room names`, async () => {
      const before = (await api('GET', `/api/conversations/${roomId}`)).json();
      const r = await api('POST', `/api/conversations/${roomId}/${endpoint}`, endpoint === 'messages'
        ? { content: '조용히 주변을 둘러본다.' } : { messageId: before.conversation.head_message_id });
      const events = r.body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
      assert.ok(events.some(e => e.type === 'done'), r.body);
      const token = events.filter(e => e.type === 'token' && e.events?.length).at(-1);
      assert.deepEqual(token.events.map((e: any) => e.text), [PROSE, '안녕', '잘 지내']);
      assert.ok(token.events.every((e: any) => e.type === 'narration'));
      const stream = polled.messages.find((m: any) => m.status === 'streaming'); assert.ok(stream);
      assert.deepEqual(stream.meta.chat_event_actors, []);
      assert.ok(stream.meta.chat_event_cast.some((actor: any) => actor.id === host.id && actor.aliases.includes('소연')));
      assert.deepEqual(stream.events.map((e: any) => e.text), [PROSE, '안녕', '잘 지내']);
      const after = (await api('GET', `/api/conversations/${roomId}`)).json();
      const rows = after.messages.filter((m: any) => m.meta.generation_id === stream.meta.generation_id && m.meta.block_kind === 'narration');
      assert.ok(rows.some((m: any) => m.content === PROSE));
      assert.ok(rows.some((m: any) => m.content === '안녕'));
      assert.ok(rows.some((m: any) => m.content === '잘 지내'));
    });
  } finally { await app.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`PASS=${passed} FAIL=${failed}`);
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
