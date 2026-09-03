/** npx tsx bench/coreRpLoop.test.ts
 * Core RP loop against shipped routes (not a reimplementation):
 *   POST /api/characters → POST /api/conversations (greeting) → prompt-preview
 *   POST /api/conversations/:id/messages → persist + SSE token chunks
 * Temp DB only. Does not start systemd or touch the live DB.
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
import { chatRoutes } from '../apps/server/src/routes/chat.js';
import { substitute } from '../apps/server/src/prompt/templates.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { GenParams, GenResult } from '../apps/server/src/model/adapter.js';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
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

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-core-rp-loop-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));
  db.prepare(
    `INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes) VALUES (?,?,?,?,?,?,?,?)`,
  ).run('rp-balanced', null, 0.8, 0.95, 400, '[]', 'system', null);

  const streamChunks = ['「Hey—', ' wait.」 ', '*tilts their head.*'];
  const model = {
    stream: async (_p: GenParams, onToken: (delta: string) => void): Promise<GenResult> => {
      for (const c of streamChunks) {
        onToken(c);
        await new Promise((r) => setImmediate(r));
      }
      return {
        text: streamChunks.join(''),
        finishReason: 'stop',
        usage: { prompt_tokens: 12, completion_tokens: 8 },
        ttftMs: 1,
        totalMs: 2,
      };
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

  const koCharBody = {
    name: '나리',
    personality: '교실에서 장난을 치지만 친구를 챙긴다. 반말.',
    first_message: '*창가에 기대어 웃었다.* 「{{user}}, 또 늦었네. 나 {{char}}야.」',
    description: '2학년. 짧은 단발.',
    speech_style: '반말, 짧게.',
    scenario: '방과 후 교실',
    example_dialogue: '',
    taboos: '사용자를 대신해 말하지 않는다.',
    tagline: '창가의 2학년',
    tags: [],
  };
  const enCharBody = {
    name: 'Mira',
    personality: 'Dry wit. Speaks in short clipped English. Loyal once trusted.',
    first_message: '*leans on the counter.* "You must be {{user}}. I\'m {{char}}."',
    description: 'Night-shift barista.',
    speech_style: 'clipped, dry',
    scenario: 'late cafe',
    example_dialogue: '',
    taboos: 'Does not speak for the user.',
    tagline: 'late shift',
    tags: [],
  };

  let koChar: any;
  let enChar: any;
  let koPersona: any;
  let enPersona: any;
  let koConv: any;
  let enConv: any;

  await t('POST /api/characters round-trips name, personality, first_message (ko)', async () => {
    const res = await api('POST', '/api/characters', koCharBody);
    assert.equal(res.status, 201, res.text);
    koChar = res.json;
    assert.equal(koChar.name, koCharBody.name);
    assert.equal(koChar.personality, koCharBody.personality);
    assert.equal(koChar.first_message, koCharBody.first_message);
  });

  await t('POST /api/characters round-trips English card fields', async () => {
    const res = await api('POST', '/api/characters', enCharBody);
    assert.equal(res.status, 201, res.text);
    enChar = res.json;
    assert.equal(enChar.name, 'Mira');
    assert.equal(enChar.personality, enCharBody.personality);
    assert.equal(enChar.first_message, enCharBody.first_message);
  });

  await t('GET /api/characters lists both authored cards', async () => {
    const res = await api('GET', '/api/characters');
    assert.equal(res.status, 200, res.text);
    const rows = res.json as any[];
    assert.ok(rows.some((c) => c.id === koChar.id && c.name === '나리'));
    assert.ok(rows.some((c) => c.id === enChar.id && c.name === 'Mira'));
  });

  await t('POST /api/personas attaches in-story me (ko + en)', async () => {
    const ko = await api('POST', '/api/personas', {
      name: '하준',
      personality: '과묵한 전학생. 관찰을 먼저 한다.',
      address_as: '하준아',
      appearance: '회색 후드',
      relationship: '같은 반',
      is_default: true,
    });
    assert.equal(ko.status, 201, ko.text);
    koPersona = ko.json;
    const en = await api('POST', '/api/personas', {
      name: 'Alex',
      personality: 'tired grad student who over-tips.',
      address_as: 'Alex',
      appearance: 'rain-soaked coat',
      relationship: 'regular',
      is_default: false,
    });
    assert.equal(en.status, 201, en.text);
    enPersona = en.json;
  });

  await t('new conversation first turn is the character greeting, not a system hello (ko)', async () => {
    const res = await api('POST', '/api/conversations', {
      characterId: koChar.id,
      personaId: koPersona.id,
      mode: 'chat',
      title: '교실',
    });
    assert.equal(res.status, 201, res.text);
    koConv = res.json;
    assert.equal(koConv.persona_id, koPersona.id);
    assert.ok(koConv.persona_applied_at, 'create must freeze the persona snapshot');
    assert.equal(koConv.persona_personality_snapshot, koPersona.personality);
    const detail = await api('GET', `/api/conversations/${koConv.id}`);
    assert.equal(detail.status, 200, detail.text);
    const msgs = (detail.json as any).messages as Array<{ role: string; content: string }>;
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, 'assistant');
    const expected = substitute(koChar.first_message, koChar.name, koPersona.name).trim();
    assert.equal(msgs[0].content, expected);
    assert.ok(msgs[0].content.includes('나리'));
    assert.ok(msgs[0].content.includes('하준'));
    assert.ok(!/hello,?\s*how can I help/i.test(msgs[0].content));
  });

  await t('new conversation greeting substitutes English {{char}}/{{user}}', async () => {
    const res = await api('POST', '/api/conversations', {
      characterId: enChar.id,
      personaId: enPersona.id,
      mode: 'chat',
    });
    assert.equal(res.status, 201, res.text);
    enConv = res.json;
    const detail = await api('GET', `/api/conversations/${enConv.id}`);
    const msgs = (detail.json as any).messages as Array<{ role: string; content: string }>;
    assert.equal(msgs[0].content, substitute(enChar.first_message, enChar.name, enPersona.name).trim());
    assert.ok(msgs[0].content.includes('Mira'));
    assert.ok(msgs[0].content.includes('Alex'));
  });

  await t('shipped prompt-preview includes personality + persona (ko + en drafts)', async () => {
    const koPrev = await api('GET', `/api/conversations/${koConv.id}/prompt-preview?draft=${encodeURIComponent('창가 쪽 자리 비었어?')}`);
    assert.equal(koPrev.status, 200, koPrev.text);
    const koSys = ((koPrev.json as any).messages as Array<{ role: string; content: string }>).find((m) => m.role === 'system')!.content;
    assert.ok(koSys.includes(koChar.personality), 'ko personality in assembled prompt');
    assert.ok(koSys.includes(koPersona.personality), 'ko persona personality in assembled prompt');
    assert.ok(koSys.includes('### 사용자 페르소나'));
    assert.ok(koSys.includes('하준'));

    const enPrev = await api('GET', `/api/conversations/${enConv.id}/prompt-preview?draft=${encodeURIComponent('Got anything left that is not burnt?')}`);
    assert.equal(enPrev.status, 200, enPrev.text);
    const enSys = ((enPrev.json as any).messages as Array<{ role: string; content: string }>).find((m) => m.role === 'system')!.content;
    assert.ok(enSys.includes(enChar.personality), 'en personality in assembled prompt');
    assert.ok(enSys.includes(enPersona.personality), 'en persona personality in assembled prompt');
    assert.ok(enSys.includes('Alex'));
  });

  await t('POST /messages persists user then character reply, with >1 SSE token chunks', async () => {
    const userLine = '창가 자리, 나 앉아도 돼?';
    const res = await fetch(`${origin}/api/conversations/${koConv.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: userLine }),
    });
    assert.equal(res.status, 200, `expected SSE 200, got ${res.status}`);
    const raw = await res.text();
    const events = parseSse(raw);
    const tokens = events.filter((e) => e.type === 'token');
    assert.ok(tokens.length > 1, `need incremental tokens, got ${tokens.length}: ${raw.slice(0, 400)}`);
    assert.equal(tokens.map((e) => e.text).join(''), streamChunks.join(''));
    const done = events.find((e) => e.type === 'done') as { type: string; message?: { content: string; role: string } } | undefined;
    assert.ok(done, 'done event missing');
    assert.equal(done!.message!.role, 'assistant');
    assert.equal(done!.message!.content, streamChunks.join('').trim());

    const detail = await api('GET', `/api/conversations/${koConv.id}`);
    const msgs = (detail.json as any).messages as Array<{ role: string; content: string }>;
    assert.equal(msgs.length, 3, JSON.stringify(msgs.map((m) => m.role)));
    assert.equal(msgs[0].role, 'assistant');
    assert.equal(msgs[1].role, 'user');
    assert.equal(msgs[1].content, userLine);
    assert.equal(msgs[2].role, 'assistant');
    assert.equal(msgs[2].content, streamChunks.join('').trim());
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
