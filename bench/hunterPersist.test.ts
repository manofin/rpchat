/**
 * npx tsx bench/hunterPersist.test.ts
 * hunter-format S-D — shipped generateHunter through the real Fastify routes.
 * Proves the whole path: scene.format switches the generator, the script and
 * turn-final panel persist as ordered blocks, an unapproved speaker gets no voice,
 * and the scene round-trips through the PATCH schema instead of being silently
 * stripped. Fake model at the I/O edge only. Temp DB, never live 서리/카이 rows.
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
  places: [{ id: '게이트', name: '미등록 D급 게이트 내부' }],
  weathers: ['지하'],
};

const SCRIPT = [
  '『게이트 밖, 홀로그램 스크린으로 내부 상황을 주시하던 강다은의 미간이 좁아졌다.』',
  '💬 강다은│(통신) "황지명, 접근한다. 열두 개체."',
  '[경고. 해석 불가능한 고밀도 정보 반응.]',
  '💬 설록│"네 이름을 줘."',
  '<상태>',
  '모드: ⚔️',
  '일정: 망자 고블린 제도 -> 원한의 근원 탐색',
  '상황: 시무외인으로 망자들을 일시 정화함',
  '강다은│😳│경악·흥미│게이트 외부(통신)│저것이... 제도? 파괴 없이 원한을...',
  '</상태>',
  '<choices>["근원을 찾아 들어간다.","강다은에게 상황을 묻는다.","잠시 숨을 고른다."]</choices>',
].join('\n');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-hunter-persist-'));
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
      return { text: '(should not be reached on the hunter path)', finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 };
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

  const daeun = await char('강다은', ['party:alias=다은', 'party:place=게이트']);
  const extra = await char('한여진', ['party:alias=여진', 'party:place=게이트']);

  const storyRes = await api('POST', '/api/stories', {
    name: '헌터와 성좌의 가호', tagline: '게이트', setting: '미등록 D급 게이트', minor_cast: [], scene_catalog: CATALOG,
  });
  assert.equal(storyRes.status, 201, storyRes.text);
  const story = storyRes.json as { id: string };
  for (const [id, order] of [[daeun.id, 0], [extra.id, 1]] as const) {
    const add = await api('POST', `/api/stories/${story.id}/characters`, { characterId: id, sortOrder: order });
    assert.equal(add.status, 201, add.text);
  }

  const conv = await api('POST', '/api/conversations', {
    characterId: daeun.id, storyId: story.id, mode: 'story',
  });
  assert.equal(conv.status, 201, conv.text);
  const convId = (conv.json as { id: string }).id;

  const hunterScene = {
    format: 'hunter' as const,
    turn_no: 10,
    day_index: 1,
    weekday: '월',
    clock_minutes: 10 * 60 + 50,
    location: '미등록 D급 게이트 내부',
    present_ids: [daeun.id],
    hunter: {
      date: '26.03.02.',
      gender: '남',
      affiliation: '무소속',
      trait: { name: '금강불괴', grade: '-', note: '육체 강도·정신 내성 극대화' },
      patron: { name: '달마', note: '골수 통찰·요마 제도의 가호' },
      skills: ['나한복마인'],
      quest: "게이트 내부의 '원한'을 제도하고 실력 증명하기",
    },
    user_sheet: { inventory: ['헌터 신분증'], money: 500_000 },
  };

  await t('the hunter scene survives PATCH instead of being stripped by the schema', async () => {
    const res = await api('PATCH', `/api/conversations/${convId}`, { scene: hunterScene });
    assert.equal(res.status, 200, res.text);
    const scene = (res.json as { scene: Record<string, unknown> }).scene;
    assert.equal(scene.format, 'hunter');
    assert.equal(scene.turn_no, 10);
    assert.equal((scene.hunter as { affiliation: string }).affiliation, '무소속');
    assert.deepEqual((scene.hunter as { skills: string[] }).skills, ['나한복마인']);
    assert.equal((scene.user_sheet as { money: number }).money, 500_000);
  });

  let blocks: Block[] = [];
  await t('POST /messages on a hunter scene persists the script then the panel', async () => {
    const res = await fetch(`${origin}/api/conversations/${convId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '강다은, 상황 보고.' }),
    });
    assert.equal(res.status, 200, `SSE 200 got ${res.status}`);
    await res.text();

    const detail = await api('GET', `/api/conversations/${convId}`);
    const msgs = (detail.json as { messages: Block[] }).messages;
    blocks = msgs.filter((m) => m.role === 'assistant');
    assert.deepEqual(
      blocks.map((b) => b.meta.block_kind),
      ['narration', 'line', 'system', 'narration', 'panel'],
    );
  });

  await t('the panel is last, and it is the transcript sheet built from scene + state', () => {
    const panel = blocks.at(-1)!;
    assert.equal(panel.meta.block_kind, 'panel');
    assert.ok(panel.content.startsWith('INFO'));
    assert.ok(panel.content.includes('⏳️-10│1일차│🗓 26.03.02. 월'));
    assert.ok(panel.content.includes('💰: 500,000원'));
    assert.ok(panel.content.includes('📖상황: 시무외인으로 망자들을 일시 정화함'));
    assert.ok(panel.content.includes('[💬 등장 중 인물: 강다은]'));
  });

  await t('every line block names an approved speaker by id', () => {
    const lines = blocks.filter((b) => b.meta.block_kind === 'line');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].meta.speaker_character_id, daeun.id);
    assert.equal(lines[0].meta.speaker_name, '강다은');
  });

  await t('the unapproved 설록 line got no voice — it persisted as narration', () => {
    const narration = blocks.filter((b) => b.meta.block_kind === 'narration');
    const seolrok = narration.find((b) => b.content.includes('네 이름을 줘'));
    assert.ok(seolrok, '설록 line must survive as narration');
    assert.equal(seolrok!.meta.speaker_character_id, undefined);
    assert.ok(!blocks.some((b) => b.meta.speaker_name === '설록'));
  });

  await t('the system voice persisted as its own kind, not as narration or a line', () => {
    const sys = blocks.filter((b) => b.meta.block_kind === 'system');
    assert.equal(sys.length, 1);
    assert.equal(sys[0].content, '[경고. 해석 불가능한 고밀도 정보 반응.]');
  });

  await t('beat_seq is the append order, with no gaps and no reordering', () => {
    assert.deepEqual(blocks.map((b) => b.meta.beat_seq), [0, 1, 2, 3, 4]);
  });

  await t('the trailing <choices> and <상태> fences never leak into message content', () => {
    for (const b of blocks) {
      assert.ok(!b.content.includes('<choices>'));
      assert.ok(!b.content.includes('<상태>'));
    }
  });

  await t('choices land on the last block of the turn — the panel', () => {
    const withChoices = blocks.filter((b) => Array.isArray(b.meta.choices));
    assert.equal(withChoices.length, 1);
    assert.equal(withChoices[0].meta.beat_seq, 4);
    assert.equal(withChoices[0].meta.block_kind, 'panel');
    assert.deepEqual(withChoices[0].meta.choices, [
      '근원을 찾아 들어간다.', '강다은에게 상황을 묻는다.', '잠시 숨을 고른다.',
    ]);
  });

  await t('one streamed call wrote the whole turn — no per-speaker round trips', () => {
    assert.equal(streamPrompts, 1);
    assert.equal(completePrompts, 1);
  });

  await t('the committed scene advanced turn_no and kept the authored identity', async () => {
    const detail = await api('GET', `/api/conversations/${convId}`);
    const scene = (detail.json as { conversation: { scene: Record<string, unknown> } }).conversation.scene;
    assert.equal(scene.turn_no, 11);
    assert.equal(scene.format, 'hunter');
    assert.equal((scene.hunter as { affiliation: string }).affiliation, '무소속');
    assert.deepEqual((scene.last_beat as { extra_ids: string[] }).extra_ids, []);
  });

  await t('the next turn renders ⏳️-11, so the counter is the server\'s alone', async () => {
    const res = await fetch(`${origin}/api/conversations/${convId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '계속한다.' }),
    });
    assert.equal(res.status, 200);
    await res.text();
    const detail = await api('GET', `/api/conversations/${convId}`);
    const msgs = (detail.json as { messages: Block[] }).messages;
    const panels = msgs.filter((m) => m.meta.block_kind === 'panel');
    assert.equal(panels.length, 2);
    assert.ok(panels[1].content.includes('⏳️-11│'));
  });

  await t('a beat-format story is untouched: no panel block, header + ui instead', async () => {
    const beatConv = await api('POST', '/api/conversations', {
      characterId: daeun.id, storyId: story.id, mode: 'story',
    });
    assert.equal(beatConv.status, 201, beatConv.text);
    const beatId = (beatConv.json as { id: string }).id;

    const res = await fetch(`${origin}/api/conversations/${beatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '강다은?' }),
    });
    assert.equal(res.status, 200);
    await res.text();

    const detail = await api('GET', `/api/conversations/${beatId}`);
    const kinds = (detail.json as { messages: Block[] }).messages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.meta.block_kind);
    assert.ok(!kinds.includes('panel'), 'the beat path must not emit a hunter panel');
    assert.ok(!kinds.includes('system'), 'the beat path must not emit a system block');
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
