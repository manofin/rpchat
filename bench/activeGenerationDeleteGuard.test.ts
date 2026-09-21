/**
 * npx tsx bench/activeGenerationDeleteGuard.test.ts
 * LOCK ActiveGenerationDeleteGuard — DELETE of an ancestor or conversation
 * must 409 while F1 activeList still owns that path. Isolated: no systemd,
 * no live DB, no live generate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.ts';
import {
  DELETE_BLOCKED_BY_GENERATION,
  generationBlocksDelete,
} from '../apps/server/src/db/generation.ts';
import { GenerationQueue } from '../apps/server/src/model/queue.ts';
import { characterRoutes } from '../apps/server/src/routes/characters.ts';
import { conversationRoutes } from '../apps/server/src/routes/conversations.ts';
import { storyRoutes } from '../apps/server/src/routes/stories.ts';
import { chatRoutes } from '../apps/server/src/routes/chat.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';
import type { GenParams, GenResult } from '../apps/server/src/model/adapter.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

function ok(text: string): GenResult {
  return { text, finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 };
}

function abortErr(): Error {
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

async function waitUntil(pred: () => boolean, label: string) {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < 4000) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.ok(pred(), label);
}

async function main() {
  await t('helper: idle conversation and idle subtree do not block', () => {
    const gens = [{ conversationId: 'c1', messageId: 'a1' }];
    assert.equal(generationBlocksDelete({ gens, conversationId: 'c2', scope: 'conversation' }), false);
    assert.equal(generationBlocksDelete({
      gens: [],
      conversationId: 'c1',
      scope: 'conversation',
    }), false);
    assert.equal(generationBlocksDelete({
      gens,
      conversationId: 'c1',
      scope: { deletedIds: new Set(['sib']), headMessageId: 'a1' },
    }), false);
  });

  await t('helper: conversation delete and ancestor-of-head overlap', () => {
    const gens = [{ conversationId: 'c1', messageId: '' }];
    assert.equal(generationBlocksDelete({ gens, conversationId: 'c1', scope: 'conversation' }), true);
    assert.equal(generationBlocksDelete({
      gens,
      conversationId: 'c1',
      scope: { deletedIds: new Set(['user', 'head']), headMessageId: 'head' },
    }), true);
    assert.equal(generationBlocksDelete({
      gens: [{ conversationId: 'c1', messageId: 'stream' }],
      conversationId: 'c1',
      scope: { deletedIds: new Set(['user', 'stream']), headMessageId: 'other' },
    }), true);
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-f2-del-'));
  const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
  db.prepare(
    `INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes) VALUES (?,?,?,?,?,?,?,?)`,
  ).run('rp-balanced', null, 0.8, 0.95, 400, '[]', 'system', null);

  let holdStream = false;
  let streamHeld = false;
  let streamRelease: (() => void) | undefined;
  let holdDelta = false;
  let deltaHeld = false;
  let deltaRelease: (() => void) | undefined;

  const model = {
    complete: async (p: GenParams): Promise<GenResult> => {
      const prompt = String(p.messages?.[0]?.content ?? '');
      if (prompt.includes('장면 진행 판정기')) {
        if (holdDelta) {
          await new Promise<void>((resolve, reject) => {
            const fail = () => reject(abortErr());
            if (p.signal?.aborted) return fail();
            deltaRelease = resolve;
            p.signal?.addEventListener('abort', fail, { once: true });
            deltaHeld = true;
          });
        }
        return ok(JSON.stringify({ base_version: 0, advance_minutes: 10, weather: '맑음' }));
      }
      if (prompt.includes('입력 초안만 쓴다')) return ok('<choices>["가","나","다"]</choices>');
      if (prompt.includes('너는 장면 서술자다') || prompt.includes('군중') || prompt.startsWith('당신은 카메라')) {
        return ok('서술이 이어진다.');
      }
      return ok('"교칙이야."');
    },
    stream: async (p: GenParams, onToken: (d: string) => void): Promise<GenResult> => {
      if (holdStream) {
        await new Promise<void>((resolve, reject) => {
          const fail = () => reject(abortErr());
          if (p.signal?.aborted) return fail();
          streamRelease = resolve;
          p.signal?.addEventListener('abort', fail, { once: true });
          streamHeld = true;
        });
      }
      onToken('「앉아.」');
      return ok('「앉아.」');
    },
    listModels: async () => ['test-model'],
  };

  const ctx = {
    db,
    model: model as unknown as Ctx['model'],
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

  const api = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${origin}${url}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = text;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, json, text };
  };

  type Msg = { id: string; role: string; status: string };

  const countMsgs = (cid: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?`).get(cid) as { n: number }).n;

  try {
    const charRes = await api('POST', '/api/characters', {
      name: '나리',
      personality: '반말.',
      first_message: '',
      tags: [],
    });
    assert.equal(charRes.status, 201, charRes.text);
    const char = charRes.json as { id: string };

    const idleRes = await api('POST', '/api/conversations', { characterId: char.id, mode: 'chat' });
    assert.equal(idleRes.status, 201, idleRes.text);
    const idleId = (idleRes.json as { id: string }).id;

    const liveRes = await api('POST', '/api/conversations', { characterId: char.id, mode: 'chat' });
    assert.equal(liveRes.status, 201, liveRes.text);
    const liveId = (liveRes.json as { id: string }).id;

    holdStream = true;
    streamHeld = false;
    const first = fetch(`${origin}/api/conversations/${liveId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '안녕' }),
    });
    await waitUntil(() => streamHeld, '1:1 stream is held');

    const pathRes = await api('GET', `/api/conversations/${liveId}`);
    assert.equal(pathRes.status, 200, pathRes.text);
    const msgs = (pathRes.json as { messages: Msg[] }).messages;
    const user = [...msgs].reverse().find((m) => m.role === 'user');
    const assistant = [...msgs].reverse().find((m) => m.role === 'assistant' && m.status === 'streaming');
    assert.ok(user && assistant, 'user + streaming assistant on path');
    const before = countMsgs(liveId);

    await t('1:1 streaming: parent user DELETE is 409 and rows remain', async () => {
      const del = await api('DELETE', `/api/messages/${user!.id}`);
      assert.equal(del.status, 409, del.text);
      assert.deepEqual(del.json, { error: DELETE_BLOCKED_BY_GENERATION });
      assert.equal(countMsgs(liveId), before);
      const still = db.prepare(`SELECT status FROM messages WHERE id = ?`).get(assistant!.id) as { status: string };
      assert.equal(still.status, 'streaming');
    });

    await t('1:1 streaming: conversation DELETE is 409', async () => {
      const del = await api('DELETE', `/api/conversations/${liveId}`);
      assert.equal(del.status, 409, del.text);
      assert.deepEqual(del.json, { error: DELETE_BLOCKED_BY_GENERATION });
      const still = await api('GET', `/api/conversations/${liveId}`);
      assert.equal(still.status, 200);
    });

    await t('1:1 streaming: idle other conversation DELETE still 200', async () => {
      const del = await api('DELETE', `/api/conversations/${idleId}`);
      assert.equal(del.status, 200, del.text);
    });

    const active = await api('GET', '/api/generations/active');
    const gid = (active.json as { active: Array<{ id: string }> }).active[0]?.id;
    assert.ok(gid);
    holdStream = false;
    const abortRes = await api('POST', `/api/generations/${gid}/abort`);
    assert.equal(abortRes.status, 200, abortRes.text);
    const firstRes = await first;
    assert.ok(firstRes.status === 499 || firstRes.status === 200, `abort/finish status ${firstRes.status}`);

    await t('inactive path: complete 1:1 user DELETE is 200', async () => {
      const convRes = await api('POST', '/api/conversations', { characterId: char.id, mode: 'chat' });
      const cid = (convRes.json as { id: string }).id;
      const send = await fetch(`${origin}/api/conversations/${cid}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '완료' }),
      });
      assert.equal(send.status, 200, await send.text());
      const got = await api('GET', `/api/conversations/${cid}`);
      const userRow = (got.json as { messages: Msg[] }).messages.find((m) => m.role === 'user');
      assert.ok(userRow);
      const del = await api('DELETE', `/api/messages/${userRow!.id}`);
      assert.equal(del.status, 200, del.text);
      assert.equal(countMsgs(cid), 0);
    });

    await t('inactive path: conversation DELETE is 200', async () => {
      const convRes = await api('POST', '/api/conversations', { characterId: char.id, mode: 'chat' });
      const cid = (convRes.json as { id: string }).id;
      const send = await fetch(`${origin}/api/conversations/${cid}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '지워' }),
      });
      assert.equal(send.status, 200, await send.text());
      const del = await api('DELETE', `/api/conversations/${cid}`);
      assert.equal(del.status, 200, del.text);
      const got = await api('GET', `/api/conversations/${cid}`);
      assert.equal(got.status, 404);
    });

    await t('1:1 streaming: unrelated sibling branch DELETE is 200', async () => {
      const convRes = await api('POST', '/api/conversations', { characterId: char.id, mode: 'chat' });
      assert.equal(convRes.status, 201, convRes.text);
      const cid = (convRes.json as { id: string }).id;
      const send1 = await fetch(`${origin}/api/conversations/${cid}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'U1' }),
      });
      assert.equal(send1.status, 200, await send1.text());
      const after1 = await api('GET', `/api/conversations/${cid}`);
      const msgs1 = (after1.json as { messages: Msg[] }).messages;
      const u1 = msgs1.find((m) => m.role === 'user');
      const a1 = msgs1.find((m) => m.role === 'assistant');
      assert.ok(u1 && a1, 'U1 + assistant on main path');

      const branch = await fetch(`${origin}/api/conversations/${cid}/branch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: u1.id, content: 'U1-sib' }),
      });
      assert.equal(branch.status, 200, await branch.text());
      const sibUser = db.prepare(
        `SELECT id FROM messages WHERE conversation_id = ? AND role = 'user' AND content = 'U1-sib'`,
      ).get(cid) as { id: string } | undefined;
      assert.ok(sibUser);

      const sel = await api('POST', `/api/messages/${a1.id}/select`);
      assert.equal(sel.status, 200, sel.text);

      holdStream = true;
      streamHeld = false;
      const live = fetch(`${origin}/api/conversations/${cid}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'U2' }),
      });
      await waitUntil(() => streamHeld, 'sibling-case stream is held');
      const beforeLive = countMsgs(cid);
      const del = await api('DELETE', `/api/messages/${sibUser.id}`);
      assert.equal(del.status, 200, del.text);
      assert.equal(
        (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE id = ?`).get(sibUser.id) as { n: number }).n,
        0,
      );
      assert.ok(countMsgs(cid) < beforeLive, 'sibling subtree removed');
      const liveStill = db.prepare(
        `SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND content = 'U2'`,
      ).get(cid) as { n: number };
      assert.equal(liveStill.n, 1);

      const active = await api('GET', '/api/generations/active');
      const gid = (active.json as { active: Array<{ id: string }> }).active[0]?.id;
      holdStream = false;
      if (gid) await api('POST', `/api/generations/${gid}/abort`);
      else streamRelease?.();
      const liveRes = await live;
      assert.ok(liveRes.status === 499 || liveRes.status === 200, `abort/finish status ${liveRes.status}`);
    });

    const nari = await api('POST', '/api/characters', { name: '나리P', personality: 'n', first_message: '', tags: ['party:duty=이야기', 'party:place=교실'] });
    const sera = await api('POST', '/api/characters', { name: '세라P', personality: 's', first_message: '', tags: ['party:duty=교칙', 'party:place=교실'] });
    const hayeon = await api('POST', '/api/characters', { name: '하연P', personality: 'h', first_message: '', tags: ['party:duty=수업', 'party:place=교실'] });
    const nariId = (nari.json as { id: string }).id;
    const seraId = (sera.json as { id: string }).id;
    const hayeonId = (hayeon.json as { id: string }).id;
    const storyRes = await api('POST', '/api/stories', {
      name: '히어로 아카데미', tagline: 'S반', setting: '교실', minor_cast: [],
      scene_catalog: { places: [{ id: '교실', default_focus: 'nari' }], weathers: ['맑음'], arcs: ['entry'] },
    });
    assert.equal(storyRes.status, 201, storyRes.text);
    const story = (storyRes.json as { id: string }).id;
    for (const [id, order] of [[hayeonId, 0], [nariId, 1], [seraId, 2]] as const) {
      await api('POST', `/api/stories/${story}/characters`, { characterId: id, sortOrder: order });
    }

    const beatConv = await api('POST', '/api/conversations', { characterId: hayeonId, storyId: story, mode: 'story' });
    assert.equal(beatConv.status, 201, beatConv.text);
    const beatId = (beatConv.json as { id: string }).id;

    holdDelta = true;
    deltaHeld = false;
    const beatSend = fetch(`${origin}/api/conversations/${beatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '들어간다' }),
    });
    await waitUntil(() => deltaHeld, 'beat scene-delta is held');
    const beatActive = await api('GET', '/api/generations/active');
    const beatGen = (beatActive.json as { active: Array<{ id: string; messageId: string; conversationId: string }> }).active[0];
    assert.ok(beatGen, 'F1 register during delta');
    assert.equal(beatGen.conversationId, beatId);
    assert.equal(beatGen.messageId, '');

    const beatPath = await api('GET', `/api/conversations/${beatId}`);
    const beatUser = (beatPath.json as { messages: Msg[] }).messages.find((m) => m.role === 'user');
    assert.ok(beatUser);
    const beatBefore = countMsgs(beatId);

    await t('beat empty messageId: parent user DELETE is 409', async () => {
      const del = await api('DELETE', `/api/messages/${beatUser!.id}`);
      assert.equal(del.status, 409, del.text);
      assert.deepEqual(del.json, { error: DELETE_BLOCKED_BY_GENERATION });
      assert.equal(countMsgs(beatId), beatBefore);
    });

    await t('beat empty messageId: conversation DELETE is 409', async () => {
      const del = await api('DELETE', `/api/conversations/${beatId}`);
      assert.equal(del.status, 409, del.text);
      assert.deepEqual(del.json, { error: DELETE_BLOCKED_BY_GENERATION });
    });

    holdDelta = false;
    const beatAbort = await api('POST', `/api/generations/${beatGen.id}/abort`);
    assert.equal(beatAbort.status, 200, beatAbort.text);
    const beatDone = await beatSend;
    assert.ok(beatDone.status === 499 || beatDone.status === 200, `beat abort status ${beatDone.status}`);

    const dialogConv = await api('POST', '/api/conversations', { characterId: hayeonId, storyId: story, mode: 'story' });
    const dialogId = (dialogConv.json as { id: string }).id;
    const patch = await api('PATCH', `/api/conversations/${dialogId}`, {
      scene: { format: 'dialog', location: '교실', present_ids: [hayeonId, nariId, seraId] },
    });
    assert.equal(patch.status, 200, patch.text);
    holdDelta = true;
    deltaHeld = false;
    const dialogSend = fetch(`${origin}/api/conversations/${dialogId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '대사' }),
    });
    await waitUntil(() => deltaHeld, 'dialog scene-delta is held');
    const dialogPath = await api('GET', `/api/conversations/${dialogId}`);
    const dialogUser = (dialogPath.json as { messages: Msg[] }).messages.find((m) => m.role === 'user');
    assert.ok(dialogUser);

    await t('dialog empty messageId: parent user DELETE is 409', async () => {
      const del = await api('DELETE', `/api/messages/${dialogUser!.id}`);
      assert.equal(del.status, 409, del.text);
      assert.deepEqual(del.json, { error: DELETE_BLOCKED_BY_GENERATION });
    });

    await t('dialog empty messageId: conversation DELETE is 409', async () => {
      const del = await api('DELETE', `/api/conversations/${dialogId}`);
      assert.equal(del.status, 409, del.text);
      assert.deepEqual(del.json, { error: DELETE_BLOCKED_BY_GENERATION });
    });

    const dialogActive = await api('GET', '/api/generations/active');
    const dialogGid = (dialogActive.json as { active: Array<{ id: string }> }).active[0]?.id;
    holdDelta = false;
    if (dialogGid) await api('POST', `/api/generations/${dialogGid}/abort`);
    else deltaRelease?.();
    await dialogSend;
  } finally {
    await app.close();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
