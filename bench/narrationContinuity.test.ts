/**
 * npx tsx bench/narrationContinuity.test.ts
 * narration-continuity — Pass N is handed the narrations already on screen.
 *
 * bench/passPrompts.test.ts owns the prompt half (what the block says). This file
 * owns the reader half, which is where the bug can actually come back: *which*
 * narrations are collected. That is a message-tree question, not a prompt question
 * — the beat writes five or six rows per turn, and a regenerate leaves a whole
 * abandoned turn sitting in the table with a plausible narration in it. Selecting
 * by `created_at` would read fluent and be wrong: Pass N would be told not to
 * repeat a room the user never saw.
 *
 * So the assertions here run real turns through the real routes and read the
 * prompt the model was actually handed.
 *
 * Fake model at the I/O edge only. Temp DB, never the live DB.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openDb } from '../apps/server/src/db/index.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import { chatRoutes } from '../apps/server/src/routes/chat.js';
import { PASS_N_RECENT_NARRATIONS, THOUGHT_MARKER } from '../apps/server/src/prompt/passes.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { GenParams, GenResult } from '../apps/server/src/model/adapter.js';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const CATALOG = {
  places: [{ id: '교실', name: 'S반 교실', default_focus: 'nari' }],
  weathers: ['맑음'],
  arcs: ['entry'],
  duties: { 교칙: { slot: '질서' } },
};

type Call = { pass: string; prompt: string };

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-narration-continuity-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));
  db.prepare(
    `INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes) VALUES (?,?,?,?,?,?,?,?)`,
  ).run('rp-balanced', null, 0.8, 0.95, 400, '[]', 'system', null);

  const calls: Call[] = [];
  /**
   * Every narration is uniquely tagged, which is the whole point: with the fixed
   * string the other beat benches use, "did the right narration come back" is not
   * a question the assertions could ask.
   */
  let narrationSeq = 0;
  const narrationText = (n: number) => `서술${n}: 나리가 창가에서 돌아선다.`;

  const model = {
    complete: async (p: GenParams): Promise<GenResult> => {
      const prompt = String(p.messages?.[0]?.content ?? '');
      const ok = (text: string): GenResult => ({ text, finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 });
      if (prompt.includes('장면 진행 판정기')) {
        calls.push({ pass: 'delta', prompt });
        return ok('{"base_version":0}');
      }
      // Pass C's prompt also contains 서술, so it is matched first.
      if (prompt.includes('입력 초안만 쓴다')) {
        calls.push({ pass: 'c', prompt });
        return ok('<choices>["*고개를 들며* 그래서요?","*물러서며* 알겠어요.","*마주 보며* 왜죠?"]</choices>');
      }
      if (prompt.includes('너는 장면 서술자다')) {
        calls.push({ pass: 'n', prompt });
        narrationSeq += 1;
        return ok(narrationText(narrationSeq));
      }
      calls.push({ pass: 'e', prompt });
      return ok('"교칙이야."');
    },
    stream: async (p: GenParams, onToken: (d: string) => void): Promise<GenResult> => {
      calls.push({ pass: 'f', prompt: String(p.messages?.[0]?.content ?? '') });
      const chunks = ['"', '……짝꿍?', '"\n', `${THOUGHT_MARKER} `, '왜 안 피하지.'];
      for (const c of chunks) {
        onToken(c);
        await new Promise((r) => setImmediate(r));
      }
      return { text: chunks.join(''), finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 3 };
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
  const port = (app.addresses()[0] as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;

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

  const char = async (name: string, tags: string[]) => {
    const res = await api('POST', '/api/characters', { name, personality: `${name} 성격`, first_message: '', tags });
    assert.equal(res.status, 201, res.text);
    return res.json as { id: string; name: string };
  };

  type Msg = { id: string; role: string; content: string; meta: Record<string, unknown> };
  const messagesOf = async (convId: string): Promise<Msg[]> => {
    const detail = await api('GET', `/api/conversations/${convId}`);
    assert.equal(detail.status, 200, detail.text);
    return (detail.json as { messages: Msg[] }).messages;
  };
  const send = async (convId: string, content: string) => {
    calls.length = 0;
    const res = await fetch(`${origin}/api/conversations/${convId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }),
    });
    assert.equal(res.status, 200, `SSE 200 expected, got ${res.status}`);
    await res.text();
  };
  const regen = async (convId: string, messageId: string) => {
    calls.length = 0;
    const res = await fetch(`${origin}/api/conversations/${convId}/regenerate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messageId }),
    });
    assert.equal(res.status, 200, `SSE 200 expected, got ${res.status}`);
    await res.text();
  };
  /** The Pass N prompt from the turn that just ran. */
  const passNPrompt = () => {
    const n = calls.filter((c) => c.pass === 'n');
    assert.equal(n.length, 1, `exactly one Pass N per turn, saw ${n.length}`);
    return n[0].prompt;
  };
  const CONTINUITY = '앞서 이미 서술된 것';

  const nari = await char('나리', ['party:duty=이야기', 'party:place=교실']);
  const sera = await char('세라', ['party:duty=교칙', 'party:place=교실']);
  const hayeon = await char('하연', ['party:duty=수업', 'party:place=교실']);

  const storyRes = await api('POST', '/api/stories', {
    name: '히어로 아카데미', tagline: 'S반', setting: '교실', minor_cast: [], scene_catalog: CATALOG,
  });
  assert.equal(storyRes.status, 201, storyRes.text);
  const story = (storyRes.json as { id: string }).id;
  for (const [id, order] of [[hayeon.id, 0], [nari.id, 1], [sera.id, 2]] as const) {
    const add = await api('POST', `/api/stories/${story}/characters`, { characterId: id, sortOrder: order });
    assert.equal(add.status, 201, add.text);
  }
  const convRes = await api('POST', '/api/conversations', { characterId: hayeon.id, storyId: story, mode: 'story' });
  assert.equal(convRes.status, 201, convRes.text);
  const convId = (convRes.json as { id: string }).id;

  // ── the opening turn ──────────────────────────────────────────────────────

  await t('the first turn of a conversation gets no continuity block', async () => {
    await send(convId, '첫 턴이오');
    const p = passNPrompt();
    assert.equal(p.includes(CONTINUITY), false, 'nothing is on screen yet');
    assert.equal(p.includes('처음 보여주듯'), false, 'and no rule against establishing the room');
  });

  // ── later turns ───────────────────────────────────────────────────────────

  await t('the second turn is handed the first turn narration', async () => {
    await send(convId, '나리, 네 이야기 말인데.');
    const p = passNPrompt();
    assert.ok(p.includes(CONTINUITY));
    assert.ok(p.includes(narrationText(1)), 'turn 1 narration must come back');
    assert.ok(p.includes('다시 소개하지 않는다'));
    // It is context, not the turn: it sits above the user input being answered.
    assert.ok(p.indexOf(narrationText(1)) < p.indexOf('## 사용자 입력'));
  });

  await t('only the newest narrations are carried once there are more than the cap', async () => {
    await send(convId, '세 번째 턴');   // narration 3, sees 1+2
    await send(convId, '네 번째 턴');   // narration 4, sees 2+3
    const p = passNPrompt();
    assert.equal(PASS_N_RECENT_NARRATIONS, 2, 'the cap this test is written against');
    assert.ok(p.includes(narrationText(2)));
    assert.ok(p.includes(narrationText(3)));
    assert.equal(p.includes(narrationText(1)), false, 'past the cap must be dropped');
    assert.ok(p.indexOf(narrationText(2)) < p.indexOf(narrationText(3)), 'oldest first');
  });

  await t('only narration blocks come back — no line, thought, header or ui', async () => {
    const p = passNPrompt();
    // The focus line and the extra line are in the same turn, on the same branch.
    assert.equal(p.includes('……짝꿍?'), false, 'a line block is not narration');
    assert.equal(p.includes('왜 안 피하지.'), false, 'nor is a thought');
    assert.equal(p.includes('교칙이야.'), false, 'nor is an extra line');
    assert.equal(p.includes('user_sheet'), false, 'nor is the ui block');
  });

  // ── the tree ──────────────────────────────────────────────────────────────

  await t('a regenerated turn replaces its narration in the context, it does not add to it', async () => {
    // Regenerate the last turn: a new sibling branch under the same user message.
    const before = await messagesOf(convId);
    const lastTurnHeader = [...before].reverse().find((m) => m.meta.block_kind === 'header');
    assert.ok(lastTurnHeader, 'the last turn has a header block to regenerate from');
    await regen(convId, lastTurnHeader!.id);
    const abandoned = narrationText(4);
    const replacement = narrationText(5);

    // The next turn must see the branch the user is actually on.
    await send(convId, '재생성 이후 턴');
    const p = passNPrompt();
    assert.ok(p.includes(replacement), 'the narration that replaced it is on the active branch');
    assert.equal(p.includes(abandoned), false, 'the abandoned sibling must not come back');
  });

  await t('the abandoned narration is still in the table — it was filtered, not deleted', () => {
    // Proves the previous assertion tested branch selection rather than a delete.
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND content = ?`,
    ).get(convId, narrationText(4)) as { n: number };
    assert.equal(row.n, 1, 'regenerate keeps the sibling, getPath just does not walk it');
  });

  await app.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
