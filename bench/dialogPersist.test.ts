/**
 * npx tsx bench/dialogPersist.test.ts
 * dialog-format S-D — shipped generateDialog through the real Fastify routes.
 * Proves the whole path: scene.format switches the generator, the INFO sheet and
 * script persist as ordered blocks, an unapproved speaker gets no voice, and the
 * scene round-trips through the PATCH schema instead of being silently stripped.
 * Fake model at the I/O edge only. Temp DB, never live 서리/카이 rows.
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
import type { Ctx } from '../apps/server/src/ctx.js';
import type { GenParams, GenResult } from '../apps/server/src/model/adapter.js';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

type Block = { role: string; content: string; meta: Record<string, unknown> };

const CATALOG = {
  places: [{ id: '제3검사실', name: '제3검사실' }],
  weathers: ['실내'],
};

/** The script the fake model "writes" — Dialog.txt T-29 shape. */
const SCRIPT = [
  '오세린의 자안이 우산에서 황지명의 얼굴로 돌아왔다.',
  '오세린 | 아라, 벌써 면역이 되셨네요.',
  '한 박자의 침묵.',
  '오세린 | 들어오세요.',
  '한여진 | 불편하시면 말씀하세요.',
  '설록 | 네 이름을 줘.',
].join('\n');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-dialog-persist-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));
  db.prepare(
    `INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes) VALUES (?,?,?,?,?,?,?,?)`,
  ).run('rp-balanced', null, 0.8, 0.95, 400, '[]', 'system', null);

  let streamPrompts = 0;
  let completePrompts = 0;
  const model = {
    complete: async (p: GenParams): Promise<GenResult> => {
      completePrompts++;
      const prompt = String(p.messages?.[0]?.content ?? '');
      if (prompt.includes('장면 진행 판정기')) {
        return { text: '{"base_version":0}', finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 };
      }
      return { text: '(should not be reached on the dialog path)', finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 };
    },
    stream: async (_p: GenParams, onToken: (d: string) => void): Promise<GenResult> => {
      streamPrompts++;
      for (const chunk of SCRIPT.match(/.{1,24}/gs) ?? []) {
        onToken(chunk);
        await new Promise((r) => setImmediate(r));
      }
      return { text: SCRIPT, finishReason: 'stop', usage: { prompt_tokens: 30, completion_tokens: 40 }, ttftMs: 1, totalMs: 3 };
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
    const res = await api('POST', '/api/characters', {
      name, personality: `${name} 성격`, first_message: '', tags,
    });
    assert.equal(res.status, 201, res.text);
    return res.json as { id: string; name: string };
  };

  const seorin = await char('오세린', ['party:alias=국장', 'party:place=제3검사실']);
  const yeojin = await char('한여진', ['party:alias=여진', 'party:place=제3검사실']);

  const storyRes = await api('POST', '/api/stories', {
    name: '진령청', tagline: '봉인국', setting: '제3검사실', minor_cast: [], scene_catalog: CATALOG,
  });
  assert.equal(storyRes.status, 201, storyRes.text);
  const story = storyRes.json as { id: string };
  for (const [id, order] of [[seorin.id, 0], [yeojin.id, 1]] as const) {
    const add = await api('POST', `/api/stories/${story.id}/characters`, { characterId: id, sortOrder: order });
    assert.equal(add.status, 201, add.text);
  }

  const conv = await api('POST', '/api/conversations', {
    characterId: seorin.id, storyId: story.id, mode: 'story',
  });
  assert.equal(conv.status, 201, conv.text);
  const convId = (conv.json as { id: string }).id;

  await t('the dialog scene survives PATCH instead of being stripped by the schema', async () => {
    const res = await api('PATCH', `/api/conversations/${convId}`, {
      scene: {
        format: 'dialog',
        turn_no: 28,
        time_phrase: '이틀 뒤·오전 10시',
        location: '제3검사실',
        weather: '실내',
        present_ids: [seorin.id, yeojin.id],
        roster: {
          [seorin.id]: { note: '봉인국 국장·1급·검사 중' },
          [yeojin.id]: { note: '계약국 1급·보증·관찰' },
        },
        info: {
          status: ['민간인(영시+혈족능력 보유·비계약)', '비전투', '무소속'],
          goals: ['봉인국 영적 상태 검사'],
        },
      },
    });
    assert.equal(res.status, 200, res.text);
    const scene = (res.json as { scene: Record<string, unknown> }).scene;
    assert.equal(scene.format, 'dialog');
    assert.equal(scene.turn_no, 28);
    assert.equal(scene.time_phrase, '이틀 뒤·오전 10시');
    assert.deepEqual((scene.info as { goals: string[] }).goals, ['봉인국 영적 상태 검사']);
    assert.equal((scene.roster as Record<string, { note: string }>)[seorin.id].note, '봉인국 국장·1급·검사 중');
  });

  let blocks: Block[] = [];
  await t('POST /messages on a dialog scene persists INFO + the script in order', async () => {
    const res = await fetch(`${origin}/api/conversations/${convId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '오세린 국장님, 검사부터 시작할까요?' }),
    });
    assert.equal(res.status, 200, `SSE 200 got ${res.status}`);
    await res.text();

    const detail = await api('GET', `/api/conversations/${convId}`);
    const msgs = (detail.json as { messages: Block[] }).messages;
    blocks = msgs.filter((m) => m.role === 'assistant');
    assert.deepEqual(
      blocks.map((b) => b.meta.block_kind),
      // The last narration is the 설록 line the allow-list refused to voice.
      ['info', 'narration', 'line', 'narration', 'line', 'line', 'narration'],
    );
  });

  await t('the INFO block is the transcript sheet, built from scene state', async () => {
    const info = blocks[0].content.split('\n');
    assert.equal(info[0], '[T-28] [이틀 뒤·오전 10시] [제3검사실] [실내]');
    assert.ok(info[1].startsWith('[정보]: '));
    assert.equal(info[2], '[계약]: —');
    assert.equal(info[3], '[침식]: —');
    assert.equal(info[4], '[목표]: 봉인국 영적 상태 검사');
    assert.ok(info[5].startsWith('[인물]: 오세린 | 봉인국 국장·1급·검사 중 / 한여진 | 계약국 1급·보증·관찰'));
  });

  await t('every line block names an approved speaker by id', () => {
    const lines = blocks.filter((b) => b.meta.block_kind === 'line');
    assert.equal(lines.length, 3);
    for (const l of lines) {
      assert.ok(l.meta.speaker_character_id, 'line must carry a speaker id');
      assert.ok([seorin.id, yeojin.id].includes(l.meta.speaker_character_id as string));
    }
    assert.equal(lines.filter((l) => l.meta.speaker_character_id === seorin.id).length, 2);
  });

  await t('the unapproved 설록 line got no voice — it persisted as narration', () => {
    const narration = blocks.filter((b) => b.meta.block_kind === 'narration');
    const seolrok = narration.find((b) => b.content.includes('네 이름을 줘'));
    assert.ok(seolrok, '설록 line must survive as narration');
    assert.equal(seolrok!.meta.speaker_character_id, undefined);
    assert.ok(!blocks.some((b) => b.meta.speaker_name === '설록'));
  });

  await t('beat_seq is the append order, with no gaps and no reordering', () => {
    assert.deepEqual(blocks.map((b) => b.meta.beat_seq), [0, 1, 2, 3, 4, 5, 6]);
  });

  await t('one streamed call wrote the whole turn — no per-speaker round trips', () => {
    assert.equal(streamPrompts, 1);
    // Only the scene-delta proposal uses complete() on this path.
    assert.equal(completePrompts, 1);
  });

  await t('the committed scene advanced turn_no and kept the authored fields', async () => {
    const detail = await api('GET', `/api/conversations/${convId}`);
    const scene = (detail.json as { conversation: { scene: Record<string, unknown> } }).conversation.scene;
    assert.equal(scene.turn_no, 29);
    assert.equal(scene.format, 'dialog');
    assert.equal(scene.time_phrase, '이틀 뒤·오전 10시');
    assert.deepEqual((scene.last_beat as { extra_ids: string[] }).extra_ids, [yeojin.id]);
  });

  await t('the next turn renders T-29, so the counter is the server\'s alone', async () => {
    const res = await fetch(`${origin}/api/conversations/${convId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '알겠습니다.' }),
    });
    assert.equal(res.status, 200);
    await res.text();
    const detail = await api('GET', `/api/conversations/${convId}`);
    const msgs = (detail.json as { messages: Block[] }).messages;
    const infos = msgs.filter((m) => m.meta.block_kind === 'info');
    assert.equal(infos.length, 2);
    assert.ok(infos[1].content.startsWith('[T-29] '));
  });

  await t('a beat-format story is untouched: no info block, header + ui instead', async () => {
    const beatConv = await api('POST', '/api/conversations', {
      characterId: seorin.id, storyId: story.id, mode: 'story',
    });
    assert.equal(beatConv.status, 201, beatConv.text);
    const beatId = (beatConv.json as { id: string }).id;

    const res = await fetch(`${origin}/api/conversations/${beatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '오세린 국장님?' }),
    });
    assert.equal(res.status, 200);
    await res.text();

    const detail = await api('GET', `/api/conversations/${beatId}`);
    const kinds = (detail.json as { messages: Block[] }).messages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.meta.block_kind);
    assert.ok(!kinds.includes('info'), 'the beat path must not emit an info block');
    assert.ok(kinds.includes('ui'), 'the beat path still closes with its UI block');
  });

  await app.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
