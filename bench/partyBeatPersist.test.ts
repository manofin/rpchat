/** npx tsx bench/partyBeatPersist.test.ts
 * Shipped generateBeat persist: POST /messages on a story-hosted party conv.
 * Fake model at the I/O edge only. Temp DB, never live 서리/카이 / school seed.
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
import { THOUGHT_MARKER } from '../apps/server/src/prompt/passes.js';
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
    try { out.push(JSON.parse(line.slice(6))); } catch { /* keepalive */ }
  }
  return out;
}

const CATALOG = {
  places: [{ id: '교실', name: 'S반 교실', default_focus: 'nari' }, { id: '사무실' }],
  weathers: ['맑음'],
  arcs: ['entry'],
  stagesByArc: { entry: ['reg', 'class'] },
  flags: { rulebreak: { owner_stage: 'reg', owner_duty: '교칙' } },
  stages: { class: { closer_duty: '수업' } },
  outfits: ['교복'],
  emotions: { '😡': 8, '🙂': 2 },
  duties: { 교칙: { slot: '질서' } },
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-party-persist-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));
  db.prepare(
    `INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes) VALUES (?,?,?,?,?,?,?,?)`,
  ).run('rp-balanced', null, 0.8, 0.95, 400, '[]', 'system', null);

  const streamChunks = ['"', '……짝꿍?', '"\n', `${THOUGHT_MARKER} `, '왜 안 피하지.'];
  const model = {
    complete: async (p: GenParams): Promise<GenResult> => {
      const prompt = String(p.messages?.[0]?.content ?? '');
      if (prompt.includes('장면 진행 판정기')) {
        return { text: '{"base_version":0}', finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 };
      }
      if (prompt.includes('서술') || prompt.includes('군중') || prompt.startsWith('당신은 카메라')) {
        return {
          text: '황지명이 나리 옆자리에 앉았다. 뒤에서 루나가 킥킥 웃었다.',
          finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 2,
        };
      }
      return { text: '"교칙이야."', finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 2 };
    },
    stream: async (_p: GenParams, onToken: (d: string) => void): Promise<GenResult> => {
      for (const c of streamChunks) {
        onToken(c);
        await new Promise((r) => setImmediate(r));
      }
      return {
        text: streamChunks.join(''),
        finishReason: 'stop',
        usage: { prompt_tokens: 20, completion_tokens: 10 },
        ttftMs: 1,
        totalMs: 3,
      };
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

  const char = async (name: string, tags: string[], extra: Record<string, string> = {}) => {
    const res = await api('POST', '/api/characters', {
      name, personality: `${name} 성격`, first_message: '', tags, ...extra,
    });
    assert.equal(res.status, 201, res.text);
    return res.json as { id: string; name: string };
  };

  const nari = await char('나리', ['party:duty=이야기', 'party:alias=나리쨩', 'party:place=교실', 'party:outfit=교복']);
  const sera = await char('세라', ['party:duty=교칙', 'party:place=교실', 'party:outfit=교복']);
  const hayeon = await char('하연', ['party:duty=수업', 'party:place=교실', 'party:outfit=교복']);
  const luna = await char('루나', ['party:talkative=0.8', 'party:place=교실']);
  const yura = await char('유라', ['party:talkative=0.4', 'party:place=교실']);
  const han = await char('한소연', ['party:place=사무실']);

  const storyRes = await api('POST', '/api/stories', {
    name: '히어로 아카데미',
    tagline: 'S반',
    setting: '교실',
    minor_cast: [],
    scene_catalog: CATALOG,
  });
  assert.equal(storyRes.status, 201, storyRes.text);
  const story = storyRes.json as { id: string };

  for (const [id, order] of [
    [hayeon.id, 0],
    [nari.id, 1],
    [sera.id, 2],
    [luna.id, 3],
    [yura.id, 4],
    [han.id, 5],
  ] as const) {
    const add = await api('POST', `/api/stories/${story.id}/characters`, { characterId: id, sortOrder: order });
    assert.equal(add.status, 201, add.text);
  }

  let convId = '';
  await t('story start with empty client scene is filled (header/UI can render)', async () => {
    const res = await api('POST', '/api/conversations', {
      characterId: hayeon.id,
      storyId: story.id,
      mode: 'story',
    });
    assert.equal(res.status, 201, res.text);
    const conv = res.json as { id: string; scene: Record<string, unknown> };
    convId = conv.id;
    assert.equal(conv.scene.location, '교실');
    assert.equal(conv.scene.weather, '맑음');
    assert.equal(conv.scene.clock_minutes, 9 * 60 + 38);
    assert.equal((conv.scene.user_sheet as { hp: number }).hp, 100);
    const present = conv.scene.present_ids as string[];
    assert.ok(present.includes(nari.id));
    assert.equal(present.includes(han.id), false);
  });

  await t('party story start drops 1:1 first_message; 1:1 keeps it', async () => {
    const guide = await char('길잡이', ['party:duty=안내', 'party:place=교실'], {
      first_message: '다리가 끊겼어. 밧줄을 잡아.',
    });
    const add = await api('POST', `/api/stories/${story.id}/characters`, { characterId: guide.id, sortOrder: 6 });
    assert.equal(add.status, 201, add.text);

    const party = await api('POST', '/api/conversations', {
      characterId: guide.id,
      storyId: story.id,
      mode: 'story',
    });
    assert.equal(party.status, 201, party.text);
    const partyDetail = await api('GET', `/api/conversations/${(party.json as { id: string }).id}`);
    const partyMsgs = (partyDetail.json as { messages: Array<{ role: string; content: string }> }).messages;
    assert.equal(
      partyMsgs.some((m) => m.content.includes('밧줄') || m.content.includes('다리')),
      false,
    );

    const solo = await api('POST', '/api/conversations', {
      characterId: guide.id,
      mode: 'chat',
    });
    assert.equal(solo.status, 201, solo.text);
    const soloDetail = await api('GET', `/api/conversations/${(solo.json as { id: string }).id}`);
    const soloMsgs = (soloDetail.json as { messages: Array<{ role: string; content: string }> }).messages;
    assert.ok(soloMsgs.some((m) => m.role === 'assistant' && m.content.includes('밧줄')));
  });

  await t('POST /messages persists header/line/thought/ui in order, with stream chunks', async () => {
    const res = await fetch(`${origin}/api/conversations/${convId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '나리, 네 이야기 말인데.' }),
    });
    assert.equal(res.status, 200, `expected SSE 200 got ${res.status}`);
    const raw = await res.text();
    const events = parseSse(raw);
    const tokens = events.filter((e) => e.type === 'token');
    assert.ok(tokens.length > 1, `need incremental tokens, got ${tokens.length} raw=${raw.slice(0, 300)}`);

    const detail = await api('GET', `/api/conversations/${convId}`);
    assert.equal(detail.status, 200, detail.text);
    const msgs = (detail.json as { messages: Array<{ role: string; content: string; meta: Record<string, unknown> }> }).messages;
    const user = msgs.find((m) => m.role === 'user');
    assert.equal(user?.content, '나리, 네 이야기 말인데.');
    const kinds = msgs.filter((m) => m.role === 'assistant').map((m) => m.meta.block_kind);
    assert.ok(kinds.includes('header'), JSON.stringify(kinds));
    assert.ok(kinds.includes('line'), JSON.stringify(kinds));
    assert.ok(kinds.includes('thought'), JSON.stringify(kinds));
    assert.ok(kinds.includes('ui'), JSON.stringify(kinds));
    assert.equal(kinds[kinds.length - 1], 'ui');

    const header = msgs.find((m) => m.meta.block_kind === 'header')!;
    assert.ok(String(header.content).includes('교실'));
    assert.ok(String(header.content).includes('09:38') || String(header.content).includes('맑음'));

    const line = msgs.find((m) => m.meta.block_kind === 'line')!;
    assert.equal(line.meta.speaker_name, '나리');
    assert.equal(line.meta.speaker_character_id, nari.id);
    assert.ok(String(line.content).includes('짝꿍'));

    const thought = msgs.find((m) => m.meta.block_kind === 'thought')!;
    assert.equal(thought.meta.speaker_name, '나리');
    assert.equal(thought.content, '왜 안 피하지.');

    const extraLines = msgs.filter((m) => m.meta.block_kind === 'line' && m.meta.speaker_name !== '나리');
    assert.ok(extraLines.length <= 2);
    assert.equal(extraLines.some((m) => m.meta.speaker_name === '루나'), false);

    const ui = JSON.parse(msgs.find((m) => m.meta.block_kind === 'ui')!.content);
    assert.equal(typeof ui.user_sheet.hp, 'number');
    assert.ok(ui.roster.some((r: { name: string; chip: string }) => r.name === '나리'));
    const hanChip = ui.roster.find((r: { name: string }) => r.name === '한소연');
    assert.ok(hanChip.locked || hanChip.chip === '🔒');
  });

  await t('greeting persist: header + named line + extras ≤ 2 + ui, no 1:1 first_message', async () => {
    const start = await api('POST', '/api/conversations', {
      characterId: hayeon.id,
      storyId: story.id,
      mode: 'story',
    });
    assert.equal(start.status, 201, start.text);
    const greetId = (start.json as { id: string }).id;
    const greetGet = await api('GET', `/api/conversations/${greetId}`);
    const greetBefore = (greetGet.json as { messages: Array<{ content: string }> }).messages;
    assert.equal(greetBefore.some((m) => m.content.includes('밧줄') || m.content.includes('다리')), false);

    const res = await fetch(`${origin}/api/conversations/${greetId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '안녕하시오' }),
    });
    assert.equal(res.status, 200, `greeting SSE 200 got ${res.status}`);
    const detail = await api('GET', `/api/conversations/${greetId}`);
    const msgs = (detail.json as { messages: Array<{ role: string; content: string; meta: Record<string, unknown> }> }).messages;
    const kinds = msgs.filter((m) => m.role === 'assistant').map((m) => m.meta.block_kind);
    assert.ok(kinds.includes('header'), JSON.stringify(kinds));
    assert.ok(kinds.includes('line'), JSON.stringify(kinds));
    assert.ok(kinds.includes('ui'), JSON.stringify(kinds));
    const lines = msgs.filter((m) => m.meta.block_kind === 'line');
    assert.ok(lines.length >= 1);
    assert.ok(lines.every((m) => m.meta.speaker_character_id && m.meta.speaker_name));
    const extraLines = lines.filter((m) => m.meta.speaker_character_id !== hayeon.id);
    assert.ok(extraLines.length >= 1 && extraLines.length <= 2, JSON.stringify(extraLines.map((m) => m.meta.speaker_name)));
    const focusLine = lines.find((m) => m.meta.speaker_character_id === hayeon.id);
    assert.ok(focusLine, 'conversation partner must have a named line');
    assert.equal(focusLine!.meta.speaker_name, '하연');
  });

  await t('second send on the same conv is still a structured beat; scene place+clock survive', async () => {
    const whisper = '*나리의 귓가에 낮게 속삭이며* 협박치고는 귀엽네요. 옮길 생각 없으니 안심해요, 나리 씨.';
    const res = await fetch(`${origin}/api/conversations/${convId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: whisper }),
    });
    assert.equal(res.status, 200, `turn2 expected SSE 200 got ${res.status}`);
    const raw = await res.text();
    const tokens = parseSse(raw).filter((e) => e.type === 'token');
    assert.ok(tokens.length > 1, `turn2 needs incremental tokens, got ${tokens.length}`);

    const detail = await api('GET', `/api/conversations/${convId}`);
    assert.equal(detail.status, 200, detail.text);
    const body = detail.json as {
      conversation: { scene: { location?: string; clock_minutes?: number } };
      messages: Array<{ role: string; content: string; meta: Record<string, unknown> }>;
    };
    assert.equal(body.conversation.scene.location, '교실');
    assert.equal(typeof body.conversation.scene.clock_minutes, 'number');
    assert.ok((body.conversation.scene.clock_minutes as number) >= 0);

    const users = body.messages.filter((m) => m.role === 'user').map((m) => m.content);
    assert.deepEqual(users, ['나리, 네 이야기 말인데.', whisper]);

    const kinds = body.messages.filter((m) => m.role === 'assistant').map((m) => m.meta.block_kind);
    const uiCount = kinds.filter((k) => k === 'ui').length;
    assert.equal(uiCount, 2, `expected two ui blocks, kinds=${JSON.stringify(kinds)}`);
    assert.ok(kinds.includes('header'));
    assert.ok(kinds.includes('line'));
    const extraLines = body.messages.filter((m) => m.meta.block_kind === 'line' && m.meta.speaker_name !== '나리');
    assert.ok(extraLines.length <= 4, 'two turns × extras ≤ 2');
    assert.equal(extraLines.some((m) => m.meta.speaker_name === '루나'), false);
    const beat2 = kinds.slice(kinds.indexOf('ui') + 1);
    assert.ok(beat2.includes('header') && beat2.includes('line') && beat2.includes('ui'), JSON.stringify(beat2));
  });

  await t('third send aims at 하연 in *direction* while speech names 나리; scene survives', async () => {
    const aim = '*하연을 향해 씩 웃으며* 과제 세 배라니, 첫날부터 가혹하시네요. 나리 씨랑 좀 더 친해지라는 뜻으로 받아들이겠습니다.';
    const res = await fetch(`${origin}/api/conversations/${convId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: aim }),
    });
    assert.equal(res.status, 200, `turn3 expected SSE 200 got ${res.status}`);
    const tokens = parseSse(await res.text()).filter((e) => e.type === 'token');
    assert.ok(tokens.length > 1, `turn3 needs incremental tokens, got ${tokens.length}`);

    const detail = await api('GET', `/api/conversations/${convId}`);
    const body = detail.json as {
      conversation: { scene: { location?: string; clock_minutes?: number } };
      messages: Array<{ role: string; content: string; meta: Record<string, unknown> }>;
    };
    assert.equal(body.conversation.scene.location, '교실');
    assert.equal(typeof body.conversation.scene.clock_minutes, 'number');
    const users = body.messages.filter((m) => m.role === 'user').map((m) => m.content);
    assert.equal(users[users.length - 1], aim);
    const kinds = body.messages.filter((m) => m.role === 'assistant').map((m) => m.meta.block_kind);
    assert.equal(kinds.filter((k) => k === 'ui').length, 3, JSON.stringify(kinds));
    const lines = body.messages.filter((m) => m.meta.block_kind === 'line');
    assert.ok(lines.some((m) => m.meta.speaker_character_id === hayeon.id && m.meta.speaker_name === '하연'));
    const extrasThis = lines.filter((m) => m.meta.speaker_character_id !== hayeon.id && m.meta.speaker_name !== '나리');
    assert.ok(extrasThis.length <= 2);
    assert.equal(lines.some((m) => m.meta.speaker_name === '루나'), false);
    assert.equal(lines.some((m) => m.meta.speaker_name === '미르'), false);
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
