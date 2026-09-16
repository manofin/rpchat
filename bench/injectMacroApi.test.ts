/** npx tsx bench/injectMacroApi.test.ts
 * inject-macro-api — optional inject_instruction accept + bound (carrier only).
 * Temp DB only. LIVE_NO_TOUCH. Does not start systemd or touch the live DB.
 *
 *   omit field              → ok; send works; instruction effectively null
 *   valid short string      → parsed; inserted user content ≠ instruction
 *   over max                → 400; no truncated inject row in storage
 *   carrier unconsumed      → GenParams.messages unchanged vs omit (no systemParts / ## 규칙 side effect)
 *   regression              → existing send without field still SSE-completes
 *   branch                  → same accept/bound shape
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
import {
  INJECT_INSTRUCTION_MAX,
  parseInjectInstruction,
} from '../apps/server/src/prompt/injectContext.js';
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

function flattenGenMessages(captured: GenParams[]): string {
  return captured
    .flatMap((p) => p.messages.map((m) => `${m.role}\n${m.content}`))
    .join('\n---\n');
}

async function main() {
  await t('parseInjectInstruction: absent / empty / whitespace → null', () => {
    assert.deepEqual(parseInjectInstruction(undefined), { ok: true, ctx: { instruction: null } });
    assert.deepEqual(parseInjectInstruction(null), { ok: true, ctx: { instruction: null } });
    assert.deepEqual(parseInjectInstruction(''), { ok: true, ctx: { instruction: null } });
    assert.deepEqual(parseInjectInstruction('   \n\t  '), { ok: true, ctx: { instruction: null } });
  });

  await t('parseInjectInstruction: trims and accepts within max', () => {
    const r = parseInjectInstruction('  do not speak for user  ');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.ctx.instruction, 'do not speak for user');
  });

  await t('parseInjectInstruction: over max rejects (never truncate)', () => {
    const over = 'x'.repeat(INJECT_INSTRUCTION_MAX + 1);
    const r = parseInjectInstruction(over);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /exceeds max length 800/);
      assert.match(r.error, /got 801/);
    }
  });

  await t('INJECT_INSTRUCTION_MAX is 800', () => {
    assert.equal(INJECT_INSTRUCTION_MAX, 800);
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-inject-macro-api-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));
  db.prepare(
    `INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes) VALUES (?,?,?,?,?,?,?,?)`,
  ).run('rp-balanced', null, 0.8, 0.95, 400, '[]', 'system', null);

  const streamChunks = ['「Hey—', ' wait.」 ', '*tilts their head.*'];
  const capturedParams: GenParams[] = [];
  const model = {
    stream: async (p: GenParams, onToken: (delta: string) => void): Promise<GenResult> => {
      capturedParams.push({
        model: p.model,
        messages: p.messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: p.temperature,
        top_p: p.top_p,
        max_tokens: p.max_tokens,
        stop: p.stop,
      });
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

  const charRes = await api('POST', '/api/characters', {
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
  });
  assert.equal(charRes.status, 201, charRes.text);
  const char = charRes.json as { id: string };

  const personaRes = await api('POST', '/api/personas', {
    name: '하준',
    personality: '과묵한 전학생.',
    address_as: '하준아',
    appearance: '회색 후드',
    relationship: '같은 반',
    is_default: true,
  });
  assert.equal(personaRes.status, 201, personaRes.text);
  const persona = personaRes.json as { id: string };

  async function newConv(title: string) {
    const res = await api('POST', '/api/conversations', {
      characterId: char.id,
      personaId: persona.id,
      mode: 'chat',
      title,
    });
    assert.equal(res.status, 201, res.text);
    return res.json as { id: string };
  }

  await t('omit inject_instruction → SSE completes; user content only IC body', async () => {
    capturedParams.length = 0;
    const conv = await newConv('omit-field');
    const userLine = '창가 자리, 나 앉아도 돼?';
    const res = await fetch(`${origin}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: userLine }),
    });
    assert.equal(res.status, 200, `expected SSE 200, got ${res.status}`);
    const events = parseSse(await res.text());
    assert.ok(events.some((e) => e.type === 'done'), 'done missing');
    const detail = await api('GET', `/api/conversations/${conv.id}`);
    const msgs = (detail.json as any).messages as Array<{ role: string; content: string; meta?: unknown }>;
    const user = msgs.find((m) => m.role === 'user');
    assert.ok(user);
    assert.equal(user!.content, userLine);
    assert.ok(!JSON.stringify(user!.meta ?? {}).includes('inject'));
  });

  const MARKER = 'INJECT_MARKER_XYZ_DO_NOT_ECHO_INTO_PROMPT';

  await t('valid short inject_instruction → send ok; content ≠ instruction; not in meta', async () => {
    capturedParams.length = 0;
    const conv = await newConv('valid-inject');
    const userLine = '창가 쪽이야.';
    const instruction = `  ${MARKER}: never speak for the user.  `;
    const res = await fetch(`${origin}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: userLine, inject_instruction: instruction }),
    });
    assert.equal(res.status, 200, `expected SSE 200, got ${res.status}`);
    const events = parseSse(await res.text());
    assert.ok(events.some((e) => e.type === 'done'), 'done missing');

    const detail = await api('GET', `/api/conversations/${conv.id}`);
    const msgs = (detail.json as any).messages as Array<{ role: string; content: string; meta?: unknown }>;
    const user = msgs.find((m) => m.role === 'user');
    assert.ok(user);
    assert.equal(user!.content, userLine);
    assert.notEqual(user!.content, instruction.trim());
    assert.ok(!user!.content.includes(MARKER));
    const blob = JSON.stringify(msgs);
    assert.ok(!blob.includes(MARKER), 'inject must not persist into messages.content / meta_json history');
  });

  await t('over-max inject_instruction → 400; no user row with truncated inject', async () => {
    const conv = await newConv('over-max');
    const before = await api('GET', `/api/conversations/${conv.id}`);
    const beforeMsgs = (before.json as any).messages as unknown[];
    const beforeCount = beforeMsgs.length;

    const over = 'Z'.repeat(INJECT_INSTRUCTION_MAX + 1);
    const userLine = '이 메시지는 저장되면 안 됨';
    const res = await api('POST', `/api/conversations/${conv.id}/messages`, {
      content: userLine,
      inject_instruction: over,
    });
    assert.equal(res.status, 400, res.text);
    const err = res.json as { error?: string };
    assert.equal(typeof err.error, 'string');
    assert.match(String(err.error), /exceeds max length 800/);

    const after = await api('GET', `/api/conversations/${conv.id}`);
    const afterMsgs = (after.json as any).messages as Array<{ role: string; content: string }>;
    assert.equal(afterMsgs.length, beforeCount, 'must not insert user row on inject reject');
    assert.ok(!afterMsgs.some((m) => m.content.includes(over.slice(0, 40))));
    assert.ok(!afterMsgs.some((m) => m.content === userLine));
  });

  await t('carrier unconsumed: GenParams.messages identical omit vs inject (no ## 규칙 / systemParts side effect)', async () => {
    const convA = await newConv('carrier-omit');
    const convB = await newConv('carrier-inject');
    const userLine = '같은 본문으로 비교.';

    capturedParams.length = 0;
    const omitRes = await fetch(`${origin}/api/conversations/${convA.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: userLine }),
    });
    assert.equal(omitRes.status, 200);
    await omitRes.text();
    const omitSnap = JSON.stringify(
      capturedParams.map((p) => p.messages.map((m) => ({ role: m.role, content: m.content }))),
    );

    capturedParams.length = 0;
    const injRes = await fetch(`${origin}/api/conversations/${convB.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: userLine,
        inject_instruction: `${MARKER}: attach later, not now.`,
      }),
    });
    assert.equal(injRes.status, 200);
    const injEvents = parseSse(await injRes.text());
    assert.ok(injEvents.some((e) => e.type === 'done'), 'assistant path still completes');
    const injFlat = flattenGenMessages(capturedParams);
    const injSnap = JSON.stringify(
      capturedParams.map((p) => p.messages.map((m) => ({ role: m.role, content: m.content }))),
    );

    assert.ok(!injFlat.includes(MARKER), 'instruction must not appear in any GenParams message content');
    // 1:1 path: no systemParts / ## 규칙 attach this slice — prompt must match omit
    assert.equal(injSnap, omitSnap, 'prompt assembly must be unchanged when inject field present');
  });

  await t('regression: existing send without field still SSE-completes with tokens', async () => {
    capturedParams.length = 0;
    const conv = await newConv('regression-send');
    const res = await fetch(`${origin}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '회귀: 필드 없이 보내기' }),
    });
    assert.equal(res.status, 200);
    const events = parseSse(await res.text());
    const tokens = events.filter((e) => e.type === 'token');
    assert.ok(tokens.length > 1, `need incremental tokens, got ${tokens.length}`);
    assert.ok(events.some((e) => e.type === 'done'));
  });

  await t('branch: valid inject_instruction → ok; content ≠ instruction; over-max → 400', async () => {
    const conv = await newConv('branch-inject');
    // seed a user message via normal send
    const seed = await fetch(`${origin}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '원래 메시지' }),
    });
    assert.equal(seed.status, 200);
    await seed.text();

    const detail = await api('GET', `/api/conversations/${conv.id}`);
    const msgs = (detail.json as any).messages as Array<{ id: string; role: string; content: string }>;
    const userMsg = msgs.find((m) => m.role === 'user' && m.content === '원래 메시지');
    assert.ok(userMsg, 'seed user missing');

    capturedParams.length = 0;
    const branchBody = '분기 본문만';
    const branchMarker = 'BRANCH_INJECT_MARKER_QQQ';
    const br = await fetch(`${origin}/api/conversations/${conv.id}/branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageId: userMsg!.id,
        content: branchBody,
        inject_instruction: branchMarker,
      }),
    });
    assert.equal(br.status, 200, await br.clone().text());
    const brEvents = parseSse(await br.text());
    assert.ok(brEvents.some((e) => e.type === 'done'));

    const after = await api('GET', `/api/conversations/${conv.id}`);
    const afterMsgs = (after.json as any).messages as Array<{ role: string; content: string }>;
    const branched = afterMsgs.find((m) => m.role === 'user' && m.content === branchBody);
    assert.ok(branched);
    assert.ok(!JSON.stringify(afterMsgs).includes(branchMarker));
    assert.ok(!flattenGenMessages(capturedParams).includes(branchMarker));

    const over = await api('POST', `/api/conversations/${conv.id}/branch`, {
      messageId: userMsg!.id,
      content: '거부될 분기',
      inject_instruction: 'Y'.repeat(INJECT_INSTRUCTION_MAX + 1),
    });
    assert.equal(over.status, 400, over.text);
    const afterOver = await api('GET', `/api/conversations/${conv.id}`);
    const afterOverMsgs = (afterOver.json as any).messages as Array<{ content: string }>;
    assert.ok(!afterOverMsgs.some((m) => m.content === '거부될 분기'));
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
