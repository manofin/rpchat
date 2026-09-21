/**
 * npx tsx bench/failSendUserPersist.test.ts
 * LOCK-FinleyFailSend-20260919 — model failure must not leave a complete user
 * row; retry is one INSERT. Isolated: no systemd, no live DB, no live generate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.ts';
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

type Msg = { id: string; role: string; content: string; status: string };

async function main() {
  await t('strategy 2 retract: no pending column, no migration, generate still sees user first', () => {
    const chat = code('apps/server/src/routes/chat.ts');
    const post = chat.slice(chat.indexOf("app.post<{ Params: { id: string } }>('/api/conversations/:id/messages'"));
    const insertAt = post.indexOf("insertMessage(db, conv.id, conv.head_message_id, 'user'");
    const generateAt = post.indexOf('return await generate(');
    assert.ok(insertAt >= 0 && generateAt > insertAt, 'user INSERT still precedes generate');
    assert.ok(post.includes('retractUnconfirmedSend(user, conv.head_message_id)'));
    assert.ok(chat.includes('function retractUnconfirmedSend'));
    assert.equal(chat.includes('const restoreHead = user.parent_id'), false);
    assert.ok(chat.includes('retractUnconfirmedSend(userMessage, conv.head_message_id)'));
    assert.equal(code('apps/web/src/pages/ChatPage.tsx').includes('if (ok === false)'), true);
    assert.equal(code('apps/web/src/pages/useChat.ts').includes("e.type === 'error'"), true);
    const migs = fs.readdirSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps/server/migrations'));
    assert.ok(!migs.some((f) => f.includes('pending') || f.includes('failsend')));
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-failsend-'));
  const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
  db.prepare(
    `INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes) VALUES (?,?,?,?,?,?,?,?)`,
  ).run('rp-balanced', null, 0.8, 0.95, 400, '[]', 'system', null);

  let resolvedName = 'test-model';
  let failNext: false | 'model-error' | 'fetch-failed' = false;
  const streamChunks = ['「앉아.', '」'];
  const model = {
    stream: async (_p: GenParams, onToken: (delta: string) => void): Promise<GenResult> => {
      if (failNext === 'model-error') {
        failNext = false;
        throw new ModelError('fixture model fail');
      }
      if (failNext === 'fetch-failed') {
        failNext = false;
        const err = new TypeError('fetch failed');
        (err as Error & { cause?: Error }).cause = new Error('connect ECONNREFUSED');
        throw err;
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
    resolvedModel: () => resolvedName,
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

  const convRes = await api('POST', '/api/conversations', {
    characterId: char.id,
    personaId: persona.id,
    mode: 'chat',
    title: '교실',
  });
  assert.equal(convRes.status, 201, convRes.text);
  const conv = convRes.json as { id: string; head_message_id: string | null };
  const greetingId = conv.head_message_id;

  const userLine = '창가 자리, 나 앉아도 돼?';

  await t('success: user complete remains with assistant reply', async () => {
    const res = await fetch(`${origin}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: userLine }),
    });
    assert.equal(res.status, 200, `expected SSE 200, got ${res.status}`);
    const events = parseSse(await res.text());
    assert.ok(events.some((e) => e.type === 'done'), JSON.stringify(events.map((e) => e.type)));
    const detail = await api('GET', `/api/conversations/${conv.id}`);
    const msgs = (detail.json as { messages: Msg[] }).messages;
    const users = msgs.filter((m) => m.role === 'user' && m.content === userLine);
    assert.equal(users.length, 1, JSON.stringify(msgs));
    assert.equal(users[0]!.status, 'complete');
    assert.equal(msgs[msgs.length - 1]!.role, 'assistant');
    assert.equal(msgs[msgs.length - 1]!.status, 'complete');
  });

  const conv2Res = await api('POST', '/api/conversations', {
    characterId: char.id,
    personaId: persona.id,
    mode: 'chat',
    title: '실패방',
  });
  assert.equal(conv2Res.status, 201, conv2Res.text);
  const conv2 = conv2Res.json as { id: string; head_message_id: string | null };
  const greeting2 = conv2.head_message_id;

  await t('fail: no complete user residue; head restored to greeting', async () => {
    failNext = 'model-error';
    const res = await fetch(`${origin}/api/conversations/${conv2.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: userLine }),
    });
    assert.equal(res.status, 200, `expected SSE 200, got ${res.status}`);
    const raw = await res.text();
    const events = parseSse(raw);
    assert.ok(events.some((e) => e.type === 'error'), raw.slice(0, 400));
    const rows = db.prepare('SELECT role, content, status FROM messages WHERE conversation_id = ?').all(conv2.id) as Msg[];
    const users = rows.filter((m) => m.role === 'user');
    assert.equal(users.length, 0, JSON.stringify(rows));
    assert.equal(rows.some((m) => m.status === 'complete' && m.role === 'user'), false);
    const head = db.prepare('SELECT head_message_id FROM conversations WHERE id = ?').get(conv2.id) as { head_message_id: string | null };
    assert.equal(head.head_message_id, greeting2);
  });

  await t('model-fetch-failed: TypeError fetch failed retracts user; no complete residue', async () => {
    const conv3Res = await api('POST', '/api/conversations', {
      characterId: char.id,
      personaId: persona.id,
      mode: 'chat',
      title: 'fetch-failed방',
    });
    assert.equal(conv3Res.status, 201, conv3Res.text);
    const conv3 = conv3Res.json as { id: string; head_message_id: string | null };
    const greeting3 = conv3.head_message_id;
    failNext = 'fetch-failed';
    const res = await fetch(`${origin}/api/conversations/${conv3.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: userLine }),
    });
    assert.equal(res.status, 200, `expected SSE 200, got ${res.status}`);
    const raw = await res.text();
    const events = parseSse(raw);
    assert.ok(events.some((e) => e.type === 'error'), raw.slice(0, 400));
    assert.equal(events.some((e) => e.type === 'done' && (e as { message?: Msg }).message?.status === 'complete'), false);
    const rows = db.prepare('SELECT role, content, status FROM messages WHERE conversation_id = ?').all(conv3.id) as Msg[];
    const users = rows.filter((m) => m.role === 'user');
    assert.equal(users.length, 0, JSON.stringify(rows));
    const head = db.prepare('SELECT head_message_id FROM conversations WHERE id = ?').get(conv3.id) as { head_message_id: string | null };
    assert.equal(head.head_message_id, greeting3);
  });

  await t('setup-fail: empty resolvedModel 503 retracts user; composer path stays ApiError', async () => {
    const conv4Res = await api('POST', '/api/conversations', {
      characterId: char.id,
      personaId: persona.id,
      mode: 'chat',
      title: 'setup-fail방',
    });
    assert.equal(conv4Res.status, 201, conv4Res.text);
    const conv4 = conv4Res.json as { id: string; head_message_id: string | null };
    const greeting4 = conv4.head_message_id;
    resolvedName = '';
    const res = await fetch(`${origin}/api/conversations/${conv4.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: userLine }),
    });
    const raw = await res.text();
    assert.equal(res.status, 503, raw.slice(0, 400));
    resolvedName = 'test-model';
    const rows = db.prepare('SELECT role, content, status FROM messages WHERE conversation_id = ?').all(conv4.id) as Msg[];
    assert.equal(rows.filter((m) => m.role === 'user').length, 0, JSON.stringify(rows));
    const head = db.prepare('SELECT head_message_id FROM conversations WHERE id = ?').get(conv4.id) as { head_message_id: string | null };
    assert.equal(head.head_message_id, greeting4);
    const useChat = code('apps/web/src/pages/useChat.ts');
    assert.equal(useChat.includes('sendOkForComposer'), true);
    assert.equal(code('apps/web/src/lib/api.ts').includes('e instanceof ApiError ? false : true'), true);
    assert.equal(code('apps/web/src/pages/ChatPage.tsx').includes('if (ok === false)'), true);
  });

  await t('retry: one user INSERT, no duplicate, success path', async () => {
    failNext = false;
    const before = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role = ?').get(conv2.id, 'user') as { n: number };
    assert.equal(before.n, 0);
    const res = await fetch(`${origin}/api/conversations/${conv2.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: userLine }),
    });
    assert.equal(res.status, 200, `expected SSE 200, got ${res.status}`);
    const events = parseSse(await res.text());
    assert.ok(events.some((e) => e.type === 'done'), JSON.stringify(events.map((e) => e.type)));
    const rows = db.prepare('SELECT role, content, status FROM messages WHERE conversation_id = ? ORDER BY created_at').all(conv2.id) as Msg[];
    const users = rows.filter((m) => m.role === 'user' && m.content === userLine);
    assert.equal(users.length, 1, JSON.stringify(rows));
    assert.equal(users[0]!.status, 'complete');
    const assistants = rows.filter((m) => m.role === 'assistant' && m.status === 'complete');
    assert.ok(assistants.length >= 2, 'greeting + reply');
    const head = db.prepare('SELECT head_message_id FROM conversations WHERE id = ?').get(conv2.id) as { head_message_id: string | null };
    assert.notEqual(head.head_message_id, greeting2);
    assert.notEqual(head.head_message_id, greetingId);
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
