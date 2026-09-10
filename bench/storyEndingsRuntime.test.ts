/** npx tsx bench/storyEndingsRuntime.test.ts
 * ADR-F8g Slice 3 (story-endings-slice3-runtime-ui): reader end action + read-only lock.
 * Isolated: temp DB + source inventory. No systemd, no live DB, no model call.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openDb } from '../apps/server/src/db/index.ts';
import { GenerationQueue } from '../apps/server/src/model/queue.ts';
import { characterRoutes } from '../apps/server/src/routes/characters.ts';
import { chatRoutes } from '../apps/server/src/routes/chat.ts';
import { conversationRoutes } from '../apps/server/src/routes/conversations.ts';
import { storyRoutes } from '../apps/server/src/routes/stories.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

async function main() {
  const convSrc = fs.readFileSync('apps/server/src/routes/conversations.ts', 'utf8');
  const chatSrc = fs.readFileSync('apps/web/src/pages/ChatPage.tsx', 'utf8');
  const storyPageSrc = fs.readFileSync('apps/web/src/pages/StoryPage.tsx', 'utf8');
  const webTypesSrc = fs.readFileSync('apps/web/src/types.ts', 'utf8');

  await t('end endpoint exists with snapshot validation (chat.ts guard owns sends)', () => {
    assert.ok(convSrc.includes('/api/conversations/:id/end'));
    assert.ok(convSrc.includes('reached_ending_id'));
    assert.ok(convSrc.includes('ended_at'));
    const chatRouteSrc = fs.readFileSync('apps/server/src/routes/chat.ts', 'utf8');
    for (const h of ['/api/conversations/:id/messages', '/api/conversations/:id/regenerate', '/api/conversations/:id/branch']) {
      assert.ok(chatRouteSrc.includes(h), h);
    }
    assert.equal(chatRouteSrc.split("conv.ended_at").length - 1 >= 3, true, 'guard on all three send-paths');
    assert.ok(chatRouteSrc.includes("code(409).send({ error: 'already ended' })"));
    const composeSrc = fs.readFileSync('apps/server/src/prompt/composeBeat.ts', 'utf8');
    assert.equal(composeSrc.includes('ended_at'), false, 'composeBeat');
    assert.equal(composeSrc.includes('reached_ending_id'), false, 'composeBeat');
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-story-endings-rt-'));
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
  await app.register(chatRoutes(ctx));
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
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json, text };
  }

  const hayeon = (await api('POST', '/api/characters', { name: '하연', personality: '반장', first_message: '카드인사' })).json as {
    id: string;
  };
  const created = await api('POST', '/api/stories', { name: '교실', setting: '학교' });
  assert.equal(created.status, 201, created.text);
  const story = created.json as { id: string };
  const ending = { id: 'true', title: '졸업', description: '함께 졸업한다', badge_label: 'TRUE' };
  const putEndings = await api('PUT', `/api/stories/${story.id}`, {
    name: '교실', tagline: '', setting: '학교', minor_cast: [], endings: [ending],
  });
  assert.equal(putEndings.status, 200, putEndings.text);

  const room = await api('POST', '/api/conversations', { characterId: hayeon.id, storyId: story.id, mode: 'story' });
  assert.equal(room.status, 201, room.text);
  const roomId = (room.json as { id: string }).id;

  await t('unknown endingId → 400; room stays open', async () => {
    const r = await api('POST', `/api/conversations/${roomId}/end`, { endingId: 'deleted-or-typo' });
    assert.equal(r.status, 400, r.text);
    const row = db.prepare('SELECT ended_at, reached_ending_id FROM conversations WHERE id = ?').get(roomId) as {
      ended_at: null; reached_ending_id: null;
    };
    assert.equal(row.ended_at, null);
    assert.equal(row.reached_ending_id, null);
  });

  await t('valid endingId ends the room; fields persist', async () => {
    const r = await api('POST', `/api/conversations/${roomId}/end`, { endingId: 'true' });
    assert.equal(r.status, 200, r.text);
    const body = r.json as { ended_at: string; reached_ending_id: string };
    assert.ok(body.ended_at);
    assert.equal(body.reached_ending_id, 'true');
    const row = db.prepare('SELECT ended_at, reached_ending_id FROM conversations WHERE id = ?').get(roomId) as {
      ended_at: string; reached_ending_id: string;
    };
    assert.equal(row.reached_ending_id, 'true');
    assert.ok(row.ended_at);
  });

  await t('second end on an ended room → 409; record frozen', async () => {
    const before = db.prepare('SELECT ended_at FROM conversations WHERE id = ?').get(roomId) as { ended_at: string };
    const r = await api('POST', `/api/conversations/${roomId}/end`, { endingId: 'true' });
    assert.equal(r.status, 409, r.text);
    const after = db.prepare('SELECT ended_at, reached_ending_id FROM conversations WHERE id = ?').get(roomId) as {
      ended_at: string; reached_ending_id: string;
    };
    assert.equal(after.ended_at, before.ended_at);
    assert.equal(after.reached_ending_id, 'true');
  });

  await t('1:1 end request → 400', async () => {
    const solo = await api('POST', '/api/conversations', { characterId: hayeon.id, mode: 'chat' });
    assert.equal(solo.status, 201, solo.text);
    const soloId = (solo.json as { id: string }).id;
    const r = await api('POST', `/api/conversations/${soloId}/end`, { endingId: 'true' });
    assert.equal(r.status, 400, r.text);
  });

  await t('ended room rejects sends: messages/regenerate/branch → 409, nothing stored', async () => {
    const before = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(roomId) as { n: number }).n;
    for (const [method, url, body] of [
      ['POST', `/api/conversations/${roomId}/messages`, { content: '우회 시도' }],
      ['POST', `/api/conversations/${roomId}/regenerate`, {}],
      ['POST', `/api/conversations/${roomId}/branch`, {}],
    ] as Array<[string, string, unknown]>) {
      const r = await api(method, url, body);
      assert.equal(r.status, 409, `${url} ${r.text}`);
    }
    const after = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(roomId) as { n: number }).n;
    assert.equal(after, before);
  });

  await t('GET detail exposes ended_at / reached_ending_id / snapshot', async () => {
    const detail = await api('GET', `/api/conversations/${roomId}`);
    assert.equal(detail.status, 200, detail.text);
    const conv = (detail.json as { conversation: Record<string, unknown> }).conversation;
    assert.equal(conv.reached_ending_id, 'true');
    assert.ok(typeof conv.ended_at === 'string');
    assert.deepEqual(JSON.parse(conv.story_endings_snapshot as string), [ending]);
  });

  await t('web Conversation type carries end state; ChatPage locks input when ended', () => {
    assert.match(webTypesSrc, /export interface Conversation[\s\S]*ended_at:\s*string\s*\|\s*null/);
    assert.match(webTypesSrc, /export interface Conversation[\s\S]*reached_ending_id:\s*string\s*\|\s*null/);
    assert.ok(chatSrc.includes('conv.ended_at'));
    assert.ok(chatSrc.includes('reached_ending_id'));
    assert.ok(chatSrc.includes('story_endings_snapshot'));
    assert.ok(chatSrc.includes('엔딩 선택') || chatSrc.includes('엔딩 고르기'));
    assert.ok(chatSrc.includes('완결'));
  });

  await t('StoryPage shows ending count only (spoiler blind)', () => {
    assert.ok(storyPageSrc.includes('개 수록'));
    assert.equal(storyPageSrc.includes('badge_label'), false);
    assert.equal(storyPageSrc.includes('reached_ending_id'), false);
  });

  await app.close();
  console.log(`passed ${passed}`);
}

void main();
