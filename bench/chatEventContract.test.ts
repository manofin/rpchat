/** npm run test:chat-events — synthetic DB/model only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Fastify from 'fastify';
import { adaptChatEvents, createChatEventStream } from '../apps/server/src/contracts/chatEventAdapter.js';
import { parseScript } from '../apps/server/src/prompt/dialogScript.js';
import { openMigratedDb } from '../apps/server/src/db/index.js';
import { seed } from '../apps/server/src/db/seed.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { chatRoutes } from '../apps/server/src/routes/chat.js';
import { EventRenderer } from '../apps/web/src/components/EventRenderer.tsx';
import { initialChatState, reduceChatEvent } from '../apps/web/src/lib/chatStreamState.ts';
import { chatEventFixtures } from './fixtures/chatEvents.ts';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { GenParams } from '../apps/server/src/model/adapter.js';
import type { ChatEvent } from '@rpchat/contracts/chat-event';
import type { Message, SseEvent } from '../apps/web/src/types.ts';

let passed = 0;
async function test(name: string, run: () => void | Promise<void>) {
  await run();
  console.log(`ok ${++passed} ${name}`);
}
const render = (events: ChatEvent[]) => renderToStaticMarkup(React.createElement(EventRenderer, { events }));
const eventsFromSse = (raw: string): SseEvent[] => raw.split('\n\n').flatMap((frame) => {
  const data = frame.split('\n').find((line) => line.startsWith('data:'));
  return data ? [JSON.parse(data.slice(5))] : [];
});

async function main() {
  for (const fixture of chatEventFixtures) {
    await test(`${fixture.name}: server adapter → render`, () => {
      const events = adaptChatEvents(fixture.message, fixture.options);
      assert.deepEqual(events.map((e) => e.type), fixture.types);
      assert.deepEqual(events.map((e) => 'text' in e ? e.text : ''), fixture.texts);
      if (fixture.actorIds) assert.deepEqual(events.flatMap((e) => e.type === 'dialogue' ? [e.actorId] : []), fixture.actorIds);
      const html = render(events);
      for (const text of fixture.texts) assert.ok(html.includes(text), html);
      assert.ok(!html.includes('PRIVATE_FIXTURE'), html);
      assert.equal(new Set(events.map((e) => e.id)).size, events.length);
      assert.equal(render(adaptChatEvents(fixture.message, fixture.options)), html, 'stable read/render');
    });
  }

  await test('every character boundary suppresses private tags and thought labels', () => {
    for (const raw of ['<think>PRIVATE_FIXTURE</think>\n"보이는 대사"', '"보이는 대사"\n속마음: PRIVATE_FIXTURE', '<analysis>PRIVATE_FIXTURE</analysis>\n"대사"']) {
      const stream = createChatEventStream({ id: 'partial', role: 'assistant', content: '' });
      for (let end = 1; end <= raw.length; end++) {
        const snapshot = stream(raw.slice(0, end));
        const visible = snapshot.events.map((e) => 'text' in e ? e.text : '').join('');
        assert.ok(!/PRIVATE|<\/?(?:th|an)|속마음/.test(visible), `boundary ${end}: ${visible}`);
        assert.ok(!snapshot.text.includes('PRIVATE'), snapshot.text);
      }
    }
  });

  await test('completed script lines keep the same events during streaming and final parsing', () => {
    const actors = [{ id: 'ari', name: '아리' }];
    const withoutIds = (events: ChatEvent[]) => events.map(({ id: _id, ...event }) => event);
    for (const raw of [
      '아리 | 앞 "안녕" 뒤\n',
      '[아리] : "안녕"\n',
      '첫째 지문\n둘째 지문\n\n셋째 지문\n아리 | "안녕"\n',
    ]) {
      const live = createChatEventStream({ id: 'script', role: 'assistant', content: '',
        meta: { chat_event_script: true, chat_event_actors: actors } })(raw).events;
      const final = parseScript(raw, actors).items.flatMap((item, index) => adaptChatEvents({
        id: `final-${index}`, role: 'assistant', content: item.text, status: 'complete',
        meta: { block_kind: item.kind, speaker_character_id: item.kind === 'line' ? item.character_id : undefined,
          speaker_name: item.kind === 'line' ? item.name : undefined },
      }, { actors }));
      assert.deepEqual(withoutIds(live), withoutIds(final), `live/final mismatch for ${JSON.stringify(raw)}`);
      assert.equal(render(live), render(final), 'equal text must keep its dialogue/narration presentation');
      if (raw.startsWith('[아리] :')) assert.deepEqual(live.map((event) => event.type), ['narration'], 'unsupported colon syntax stays narration');
      if (raw.startsWith('아리 | 앞')) assert.deepEqual(live.map((event) => event.type), ['narration', 'dialogue', 'narration']);
    }
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-events-contract-'));
  let db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
  seed(db, path.join(tmp, 'no-content'), () => {});
  let mode: 'complete' | 'interrupt' | 'failure' = 'complete';
  let partialRead: Message | undefined;
  let app: ReturnType<typeof Fastify>;
  let conversationId = '';
  const output = '<think>PRIVATE_FIXTURE</think>\n*그가 손을 흔든다.*\n[이든] : "반가워요."';
  const model = {
    stream: async (params: GenParams, onToken: (text: string) => void) => {
      for (let index = 0; index < output.length; index += 2) {
        onToken(output.slice(index, index + 2));
        if (index === 24) {
          // Cross the persistence interval and observe the actual GET resume path.
          await new Promise((resolve) => setTimeout(resolve, 820));
        }
        if (index === 28) {
          const detail = (await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}` })).json();
          partialRead = detail.messages.find((m: Message) => m.status === 'streaming');
        }
        if (mode === 'interrupt' && index >= 50) {
          const active = ctx.queue.activeList[0];
          active.controller.abort();
          throw new Error('fixture interruption');
        }
        if (mode === 'failure' && index >= 30) throw new Error('fixture model failure');
      }
      return { text: output, finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 900 };
    },
    complete: async () => ({ text: '', finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 }),
  };
  const ctx = {
    db, model, queue: new GenerationQueue(1), resolvedModel: () => 'fixture', setResolvedModel: () => {},
    log: { error() {}, info() {}, warn() {}, debug() {} },
  } as unknown as Ctx;
  async function boot() {
    app = Fastify();
    await app.register(characterRoutes(ctx));
    await app.register(conversationRoutes(ctx));
    await app.register(chatRoutes(ctx));
    await app.ready();
  }
  const post = async (url: string, payload: unknown) => {
    const response = await app.inject({ method: 'POST', url, payload: payload as Record<string, unknown> });
    assert.ok(response.statusCode < 300, response.body);
    return response;
  };
  try {
    await boot();
    const character = (await post('/api/characters', { name: '이든', first_message: '*창문이 열린다.*\n[이든] : "어서 와요."' })).json();
    conversationId = (await post('/api/conversations', { characterId: character.id, mode: 'chat' })).json().id;
    let complete: Message;
    let sse: SseEvent[];

    await test('new character → session → token snapshots → atomic DB events → GET render parity', async () => {
      const response = await post(`/api/conversations/${conversationId}/messages`, { content: '안녕하세요.' });
      sse = eventsFromSse(response.body);
      const tokens = sse.filter((e) => e.type === 'token');
      assert.ok(tokens.length > 3, 'response must actually stream');
      for (const token of tokens) {
        assert.equal(token.eventVersion, 1);
        assert.ok(token.events);
        assert.ok(!JSON.stringify(token.events).includes('PRIVATE_FIXTURE'));
      }
      const done = sse.find((e) => e.type === 'done');
      assert.ok(done?.type === 'done');
      complete = done.message;
      assert.deepEqual(complete.events?.map((e) => e.type), ['narration', 'dialogue']);
      assert.ok(!complete.content.includes('PRIVATE_FIXTURE'));
      const stored = db.prepare('SELECT content,meta_json FROM messages WHERE id=?').get(complete.id) as { content: string; meta_json: string };
      assert.deepEqual(JSON.parse(stored.meta_json).events, complete.events);
      assert.equal(JSON.parse(stored.meta_json).chat_event_version, 1);
      assert.ok(!stored.content.includes('PRIVATE_FIXTURE'));
      const detail = (await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}` })).json();
      const resumed = detail.messages.find((m: Message) => m.id === complete.id);
      assert.deepEqual(resumed.events, complete.events);
      assert.equal(render(resumed.events), render(complete.events!));
      let state = { ...initialChatState, loading: false };
      for (const event of sse) state = reduceChatEvent(state, event, conversationId);
      assert.deepEqual(state.messages.find((m) => m.id === complete.id)?.events, complete.events);
      assert.equal(state.generating, false);
    });

    await test('reconnect while streaming reads a safe canonical snapshot', () => {
      assert.ok(partialRead);
      assert.equal(partialRead.eventVersion, 1);
      assert.equal(partialRead.status, 'streaming');
      assert.ok(!JSON.stringify(partialRead.events).includes('PRIVATE_FIXTURE'));
      assert.ok(!partialRead.content.includes('PRIVATE_FIXTURE'));
    });

    await test('restart and character rename preserve persisted event identity and presentation', async () => {
      const expected = complete!.events;
      await app.close();
      db.close();
      db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
      ctx.db = db;
      db.prepare('UPDATE characters SET name=? WHERE id=?').run('새 이름', character.id);
      await boot();
      const detail = (await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}` })).json();
      const restored = detail.messages.find((m: Message) => m.id === complete!.id);
      assert.deepEqual(restored.events, expected);
      assert.equal(render(restored.events), render(expected!));
      const bookmarked = await app.inject({ method: 'PATCH', url: `/api/messages/${complete!.id}`, payload: { bookmarked: true } });
      assert.equal(bookmarked.statusCode, 200, bookmarked.body);
      assert.deepEqual(bookmarked.json().events, expected, 'bookmark does not reattribute old dialogue');
    });

    await test('legacy read adapts without rewriting raw DB content or metadata', async () => {
      const row = db.prepare('SELECT id FROM messages WHERE conversation_id=? AND role=? ORDER BY created_at LIMIT 1').get(conversationId, 'assistant') as { id: string };
      db.prepare('UPDATE messages SET content=?,meta_json=? WHERE id=?').run('<think>PRIVATE_FIXTURE</think>\n"옛 대사"', '{}', row.id);
      const before = db.prepare('SELECT content,meta_json FROM messages WHERE id=?').get(row.id);
      const response = (await app.inject({ method: 'GET', url: `/api/messages/${row.id}` })).json();
      assert.equal(response.eventVersion, 1);
      assert.ok(!render(response.events).includes('PRIVATE_FIXTURE'));
      assert.deepEqual(db.prepare('SELECT content,meta_json FROM messages WHERE id=?').get(row.id), before);
    });

    await test('non-object legacy metadata reads safely without rewriting stored data', async () => {
      const row = db.prepare('SELECT id,content,meta_json FROM messages WHERE conversation_id=? AND role=? ORDER BY created_at LIMIT 1')
        .get(conversationId, 'assistant') as { id: string; content: string; meta_json: string };
      try {
        for (const rawMeta of ['null', '[]', '42', '"legacy"']) {
          db.prepare('UPDATE messages SET meta_json=? WHERE id=?').run(rawMeta, row.id);
          const response = await app.inject({ method: 'GET', url: `/api/messages/${row.id}` });
          assert.equal(response.statusCode, 200, `${rawMeta}: ${response.body}`);
          const message = response.json();
          assert.deepEqual(message.meta, {}, 'non-object metadata normalizes at the read boundary');
          assert.ok(Array.isArray(message.events));
          assert.ok(!render(message.events).includes('PRIVATE_FIXTURE'));
          const detail = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}` });
          assert.equal(detail.statusCode, 200, `${rawMeta}: conversation read ${detail.body}`);
          assert.equal((db.prepare('SELECT meta_json FROM messages WHERE id=?').get(row.id) as { meta_json: string }).meta_json, rawMeta);
        }
      } finally {
        db.prepare('UPDATE messages SET meta_json=? WHERE id=?').run(row.meta_json, row.id);
      }
    });

    await test('regeneration creates a sibling response without another user turn', async () => {
      const usersBefore = db.prepare("SELECT count(*) AS n FROM messages WHERE conversation_id=? AND role='user'").get(conversationId);
      const response = await post(`/api/conversations/${conversationId}/regenerate`, { messageId: complete!.id });
      const done = eventsFromSse(response.body).find((e) => e.type === 'done');
      assert.ok(done?.type === 'done');
      assert.notEqual(done.message.id, complete!.id);
      assert.equal(done.message.parent_id, complete!.parent_id);
      assert.deepEqual(db.prepare("SELECT count(*) AS n FROM messages WHERE conversation_id=? AND role='user'").get(conversationId), usersBefore);
      assert.deepEqual(JSON.parse((db.prepare('SELECT meta_json FROM messages WHERE id=?').get(done.message.id) as { meta_json: string }).meta_json).events, done.message.events);
    });

    await test('explicit interruption persists safe events and reload equals terminal SSE', async () => {
      mode = 'interrupt';
      const response = await post(`/api/conversations/${conversationId}/messages`, { content: '중단 검증' });
      const done = eventsFromSse(response.body).find((e) => e.type === 'done');
      assert.ok(done?.type === 'done');
      assert.equal(done.message.status, 'interrupted');
      const restored = (await app.inject({ method: 'GET', url: `/api/messages/${done.message.id}` })).json();
      assert.deepEqual(restored.events, done.message.events);
      assert.ok(!JSON.stringify(restored.events).includes('PRIVATE_FIXTURE'));
      assert.equal(ctx.queue.activeList.length, 0);
    });

    await test('model failure retracts unconfirmed user turn and leaves no active generation', async () => {
      mode = 'failure';
      const before = (await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}` })).json();
      const response = await post(`/api/conversations/${conversationId}/messages`, { content: '실패 검증' });
      assert.ok(eventsFromSse(response.body).some((e) => e.type === 'error'));
      const after = (await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}` })).json();
      assert.equal(after.conversation.head_message_id, before.conversation.head_message_id);
      assert.equal(after.messages.some((m: Message) => m.content === '실패 검증'), false);
      assert.equal(ctx.queue.activeList.length, 0);
    });

    await test('editing a message replaces persisted events; bookmark leaves edited events intact', async () => {
      const edited = await app.inject({ method: 'PATCH', url: `/api/messages/${complete!.id}`, payload: { content: '*수정된 장면*\n"수정된 대사"' } });
      assert.equal(edited.statusCode, 200, edited.body);
      const message = edited.json();
      assert.deepEqual(message.events.map((e: ChatEvent) => e.type), ['narration', 'dialogue']);
      assert.deepEqual(message.events.map((e: ChatEvent) => 'text' in e ? e.text : ''), ['수정된 장면', '수정된 대사']);
      const stored = db.prepare('SELECT meta_json FROM messages WHERE id=?').get(complete!.id) as { meta_json: string };
      assert.deepEqual(JSON.parse(stored.meta_json).events, message.events);
    });
  } finally {
    await app!.close();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`PASS ${passed} chat event contract checks`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
