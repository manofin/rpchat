/**
 * npx tsx bench/branchFailureHeadRestore.test.ts
 * LOCK BranchFailureHeadRestore — Astra F3. /branch from an older user then
 * model-fail must restore the request-time active head, not the new user's
 * parent. Isolated: no systemd, no live DB, no live generate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { openDb } from '../apps/server/src/db/index.ts';
import { GenerationQueue } from '../apps/server/src/model/queue.ts';
import { ModelError } from '../apps/server/src/model/adapter.ts';
import { characterRoutes } from '../apps/server/src/routes/characters.ts';
import { conversationRoutes } from '../apps/server/src/routes/conversations.ts';
import { chatRoutes } from '../apps/server/src/routes/chat.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';
import type { GenParams, GenResult } from '../apps/server/src/model/adapter.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

function code(rel: string): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  return fs.readFileSync(path.join(dir, '..', rel), 'utf8');
}

function parseSse(raw: string): Array<{ type: string; [k: string]: unknown }> {
  const out: Array<{ type: string; [k: string]: unknown }> = [];
  for (const block of raw.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    try {
      out.push(JSON.parse(line.slice(6)));
    } catch {
      /* ignore keepalives */
    }
  }
  return out;
}

function okText(text: string): GenResult {
  return { text, finishReason: 'stop', usage: { prompt_tokens: 8, completion_tokens: 4 }, ttftMs: 1, totalMs: 2 };
}

function abortErr(): Error {
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

type Msg = { id: string; role: string; content: string; status: string; parent_id: string | null };

async function waitUntil(fn: () => Promise<boolean> | boolean, label: string, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout: ${label}`);
}

async function main() {
  await t('head-restore contract: restore request-time head, not user.parent_id', () => {
    const chat = code('apps/server/src/routes/chat.ts');
    const fn = chat.slice(chat.indexOf('function retractUnconfirmedSend'));
    const body = fn.slice(0, fn.indexOf('async function generate'));
    assert.ok(body.includes('restoreHead: string | null'));
    assert.equal(body.includes('user.parent_id'), false);
    assert.equal((chat.match(/retractUnconfirmedSend\(userMessage, conv\.head_message_id\)/g) ?? []).length, 10);
    const branch = chat.slice(chat.indexOf("app.post<{ Params: { id: string } }>('/api/conversations/:id/branch'"));
    assert.ok(branch.includes("insertMessage(db, conv.id, m.parent_id, 'user'"));
    assert.ok(branch.includes('retractUnconfirmedSend(user, conv.head_message_id)'));
    const post = chat.slice(chat.indexOf("app.post<{ Params: { id: string } }>('/api/conversations/:id/messages'"));
    const messagesFn = post.slice(0, post.indexOf("app.post<{ Params: { id: string } }>('/api/conversations/:id/regenerate'"));
    assert.ok(messagesFn.includes("insertMessage(db, conv.id, conv.head_message_id, 'user'"));
    assert.ok(messagesFn.includes('retractUnconfirmedSend(user, conv.head_message_id)'));
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-branch-head-restore-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));
  db.prepare(
    `INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes) VALUES (?,?,?,?,?,?,?,?)`,
  ).run('rp-balanced', null, 0.8, 0.95, 400, '[]', 'system', null);

  let failNext: false | 'model-error' | 'hang' = false;
  const streamChunks = ['「앉아.', '」'];
  const model = {
    stream: async (p: GenParams, onToken: (delta: string) => void): Promise<GenResult> => {
      if (failNext === 'model-error') {
        failNext = false;
        throw new ModelError('fixture model fail');
      }
      if (failNext === 'hang') {
        failNext = false;
        await new Promise<never>((_, reject) => {
          const fail = () => reject(abortErr());
          if (p.signal?.aborted) return fail();
          p.signal?.addEventListener('abort', fail, { once: true });
        });
      }
      for (const c of streamChunks) {
        onToken(c);
        await new Promise((r) => setImmediate(r));
      }
      return okText(streamChunks.join(''));
    },
    complete: async (p: GenParams) => model.stream(p, () => {}),
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
  await app.register(conversationRoutes(ctx));
  await app.register(chatRoutes(ctx));
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.addresses()[0] as { port: number };
  const origin = `http://127.0.0.1:${addr.port}`;

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

  const charRes = await api('POST', '/api/characters', {
    name: '나리',
    personality: '반말.',
    first_message: '*창가.* 「{{user}}, {{char}}야.」',
    description: '2학년',
    speech_style: '반말',
    scenario: '교실',
    example_dialogue: '',
    taboos: '',
    tagline: '창가',
    tags: [],
  });
  assert.equal(charRes.status, 201, charRes.text);
  const char = charRes.json as { id: string };

  const personaRes = await api('POST', '/api/personas', {
    name: '하준',
    personality: '과묵',
    address_as: '하준아',
    appearance: '',
    relationship: '',
    is_default: true,
  });
  assert.equal(personaRes.status, 201, personaRes.text);
  const persona = personaRes.json as { id: string };

  async function seedPath(): Promise<{
    convId: string;
    A: string;
    U1: string;
    B: string;
    U2: string;
    C: string;
  }> {
    const convRes = await api('POST', '/api/conversations', {
      characterId: char.id,
      personaId: persona.id,
      mode: 'chat',
      title: '교실',
    });
    assert.equal(convRes.status, 201, convRes.text);
    const conv = convRes.json as { id: string; head_message_id: string | null };
    const A = conv.head_message_id;
    assert.ok(A);

    const u1 = await fetch(`${origin}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'U1' }),
    });
    assert.equal(u1.status, 200, await u1.text());
    const u2 = await fetch(`${origin}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'U2' }),
    });
    assert.equal(u2.status, 200, await u2.text());

    const rows = db.prepare(
      'SELECT id, role, content, parent_id, status FROM messages WHERE conversation_id = ? ORDER BY created_at, id',
    ).all(conv.id) as Msg[];
    const U1 = rows.find((m) => m.role === 'user' && m.content === 'U1');
    const B = rows.find((m) => m.role === 'assistant' && m.parent_id === U1?.id);
    const U2 = rows.find((m) => m.role === 'user' && m.content === 'U2');
    const C = rows.find((m) => m.role === 'assistant' && m.parent_id === U2?.id);
    assert.ok(U1 && B && U2 && C, JSON.stringify(rows));
    const head = db.prepare('SELECT head_message_id FROM conversations WHERE id = ?').get(conv.id) as { head_message_id: string };
    assert.equal(head.head_message_id, C.id);
    return { convId: conv.id, A, U1: U1.id, B: B.id, U2: U2.id, C: C.id };
  }

  const tree = await seedPath();

  await t('U1-edit-fail: head returns to C; C row and getPath stay; branch user gone', async () => {
    failNext = 'model-error';
    const beforeCount = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(tree.convId) as { n: number }).n;
    const res = await fetch(`${origin}/api/conversations/${tree.convId}/branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: tree.U1, content: 'U1-edit' }),
    });
    assert.equal(res.status, 200, `expected SSE 200, got ${res.status}`);
    const events = parseSse(await res.text());
    assert.ok(events.some((e) => e.type === 'error'), JSON.stringify(events.map((e) => e.type)));

    const head = db.prepare('SELECT head_message_id FROM conversations WHERE id = ?').get(tree.convId) as { head_message_id: string | null };
    assert.equal(head.head_message_id, tree.C, 'request-time head C, not A');
    assert.notEqual(head.head_message_id, tree.A);

    const rows = db.prepare(
      'SELECT id, role, content, parent_id, status FROM messages WHERE conversation_id = ?',
    ).all(tree.convId) as Msg[];
    assert.equal(rows.some((m) => m.content === 'U1-edit'), false, JSON.stringify(rows));
    assert.ok(rows.some((m) => m.id === tree.C));
    assert.ok(rows.some((m) => m.id === tree.U1));
    assert.ok(rows.some((m) => m.id === tree.B));
    assert.ok(rows.some((m) => m.id === tree.U2));
    assert.ok(rows.some((m) => m.id === tree.A));
    assert.equal(rows.length, beforeCount, 'failed branch retracted; live rows intact');

    const detail = await api('GET', `/api/conversations/${tree.convId}`);
    const path = (detail.json as { messages: Msg[] }).messages.map((m) => m.id);
    assert.deepEqual(path, [tree.A, tree.U1, tree.B, tree.U2, tree.C]);
  });

  await t('latest-turn fail retract: /messages still restores greeting (FailSend)', async () => {
    const convRes = await api('POST', '/api/conversations', {
      characterId: char.id,
      personaId: persona.id,
      mode: 'chat',
      title: 'failsend',
    });
    assert.equal(convRes.status, 201, convRes.text);
    const conv = convRes.json as { id: string; head_message_id: string | null };
    failNext = 'model-error';
    const res = await fetch(`${origin}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'latest' }),
    });
    assert.equal(res.status, 200);
    const events = parseSse(await res.text());
    assert.ok(events.some((e) => e.type === 'error'));
    const rows = db.prepare('SELECT role FROM messages WHERE conversation_id = ?').all(conv.id) as Array<{ role: string }>;
    assert.equal(rows.filter((m) => m.role === 'user').length, 0);
    const head = db.prepare('SELECT head_message_id FROM conversations WHERE id = ?').get(conv.id) as { head_message_id: string | null };
    assert.equal(head.head_message_id, conv.head_message_id);
  });

  await t('abort: no-retract; user row stays', async () => {
    const convRes = await api('POST', '/api/conversations', {
      characterId: char.id,
      personaId: persona.id,
      mode: 'chat',
      title: 'abort',
    });
    assert.equal(convRes.status, 201, convRes.text);
    const conv = convRes.json as { id: string; head_message_id: string | null };
    failNext = 'hang';
    const sendP = fetch(`${origin}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'abort-me' }),
    });
    await waitUntil(async () => {
      const active = await api('GET', '/api/generations/active');
      const list = (active.json as { active: Array<{ id: string; conversationId: string }> }).active;
      return list.some((g) => g.conversationId === conv.id);
    }, 'generation registered');
    const active = await api('GET', '/api/generations/active');
    const gid = (active.json as { active: Array<{ id: string; conversationId: string }> }).active.find((g) => g.conversationId === conv.id)!.id;
    const abortRes = await api('POST', `/api/generations/${gid}/abort`);
    assert.equal(abortRes.status, 200, abortRes.text);
    const raw = await sendP;
    assert.equal(raw.status, 200);
    const events = parseSse(await raw.text());
    assert.equal(events.some((e) => e.type === 'error'), false, JSON.stringify(events.map((e) => e.type)));
    const rows = db.prepare(
      'SELECT id, role, content, status FROM messages WHERE conversation_id = ?',
    ).all(conv.id) as Msg[];
    const users = rows.filter((m) => m.role === 'user' && m.content === 'abort-me');
    assert.equal(users.length, 1, JSON.stringify(rows));
    assert.equal(users[0]!.status, 'complete');
    const head = db.prepare('SELECT head_message_id FROM conversations WHERE id = ?').get(conv.id) as { head_message_id: string | null };
    assert.notEqual(head.head_message_id, conv.head_message_id);
  });

  await app.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`PASS=${passed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
