/** npm run test:benches -- responseLength
 * Actual routes + isolated DB/mock model. Baseline request hashes were measured at
 * 499afcf, before the room length policy. No real model or live data.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { GenParams, GenResult } from '../apps/server/src/model/adapter.js';
import type { ConversationRow, Scene } from '../apps/server/src/types.js';

process.env.CONTEXT_TOKENS = '8192';

async function main() {
  const { default: Fastify } = await import('fastify');
  const { openMigratedDb } = await import('../apps/server/src/db/index.js');
  const { GenerationQueue } = await import('../apps/server/src/model/queue.js');
  const { conversationRoutes } = await import('../apps/server/src/routes/conversations.js');
  const { chatRoutes } = await import('../apps/server/src/routes/chat.js');
  const { estimateMessageTokens } = await import('../apps/server/src/prompt/tokens.js');
  const { buildPrompt } = await import('../apps/server/src/prompt/builder.js');
  const { getPath, insertMessage, setHead } = await import('../apps/server/src/db/tree.js');
  const { buildSceneSnapshot, materializeSceneAtHead } = await import('../apps/server/src/db/sceneBase.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-response-length-'));
  const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
  db.prepare(`INSERT INTO model_profiles (name, max_tokens) VALUES ('rp-balanced', 800)`).run();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('token_calibration', '1.173')`).run();
  for (const [id, name, duty] of [['nari', '나리', '이야기'], ['sera', '세라', '교칙'], ['hayeon', '하연', '수업']]) {
    db.prepare(`INSERT INTO characters (id, name, personality, tags_json, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
      .run(id, name, `${name}의 성격`, JSON.stringify([`party:duty=${duty}`, 'party:place=교실']), '2026-01-01', '2026-01-01');
  }
  const catalog = { places: [{ id: '교실', default_focus: 'nari' }], weathers: ['맑음'], arcs: ['entry'], duties: { 교칙: { slot: '질서' } } };
  db.prepare(`INSERT INTO stories (id, name, setting, scene_catalog, created_at, updated_at) VALUES ('story', '합성 교실', '복도를 지나 교실에 모였다.', ?, '2026-01-01', '2026-01-01')`).run(JSON.stringify(catalog));
  for (const [order, id] of ['nari', 'sera', 'hayeon'].entries()) db.prepare(`INSERT INTO story_characters (story_id, character_id, sort_order) VALUES ('story', ?, ?)`).run(id, order);
  const calls: Array<{ method: 'complete' | 'stream'; p: GenParams }> = [];
  let finishReason: GenResult['finishReason'] = 'stop';
  const ok = (text: string): GenResult => ({ text, finishReason, usage: null, ttftMs: 1, totalMs: 1 });
  const model = {
    complete: async (p: GenParams) => {
      calls.push({ method: 'complete', p });
      const text = p.messages.map(m => m.content).join('\n');
      if (text.includes('장면 진행 판정기')) return ok('null');
      if (text.includes('입력 초안만 쓴다')) return ok('<choices>["고개를 끄덕인다","기다린다","다시 묻는다"]</choices>');
      if (text.startsWith('너는 장면 서술자다')) return ok('교실에 모인 이들이 서로를 바라본다.');
      return ok('"이야기를 계속해."');
    },
    stream: async (p: GenParams, token: (text: string) => void) => {
      calls.push({ method: 'stream', p });
      const dialog = p.messages.some(m => m.content.startsWith('너는 이 장면의 서술자다'));
      const text = dialog ? '교실이 조용해진다.\n나리 | 안녕.\n세라 | 기다렸어.' : '"안녕, 이야기를 들려줘."';
      token(text); return ok(text);
    },
  };
  const ctx = { db, model, queue: new GenerationQueue(1), resolvedModel: () => 'mock-model', log: { error() {}, warn() {}, info() {}, debug() {} } } as unknown as Ctx;
  const app = Fastify();
  app.register(conversationRoutes(ctx)); app.register(chatRoutes(ctx));
  type Format = 'solo' | 'dialog' | 'beat';
  type Length = 'short' | 'normal' | 'long';
  const input = '나리, 교실에서 기다리기로 했던 약속을 이야기해 줘.';
  let passed = 0;
  const failures: Error[] = [];
  async function t(name: string, test: () => void | Promise<void>) {
    try { await test(); console.log(`ok ${++passed} ${name}`); }
    catch (cause) { const error = new Error(name, { cause }); failures.push(error); console.error(error); }
  }
  async function api(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object, code = 200) {
    const res = await app.inject({ method, url, payload });
    assert.equal(res.statusCode, code, `${method} ${url}: ${res.body}`);
    return res;
  }
  const conv = (id: string) => db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow;
  const sceneOf = (id: string) => JSON.parse(conv(id).scene_json) as Scene;
  const newRoom = async (format: Format, length?: Length) => {
    const scene = format === 'solo' ? { place: '교실' } : {
      format, location: '교실', present_ids: ['nari', 'sera', 'hayeon'], clock_minutes: 540,
      day_index: 1, weekday: '월', weather: '맑음', arc: 'entry',
    };
    return (await api('POST', '/api/conversations', {
      characterId: 'nari', mode: format === 'solo' ? 'chat' : 'story',
      ...(format === 'solo' ? {} : { storyId: 'story' }), scene: { ...scene, ...(length ? { response_length: length } : {}) },
    }, 201)).json().id as string;
  };
  async function preview(id: string, query: Record<string, string> = { draft: input }) {
    return (await api('GET', `/api/conversations/${id}/prompt-preview?${new URLSearchParams(query)}`)).json();
  }
  async function send(id: string) {
    calls.length = 0;
    const res = await api('POST', `/api/conversations/${id}/messages`, { content: input });
    assert.match(res.body, /"type":"done"/);
    assert.doesNotMatch(res.body, /"type":"error"/);
    assert.deepEqual(ctx.queue.activeList, []);
    return calls.find(c => c.method === 'stream')!.p;
  }
  const comparable = (messages: GenParams['messages']) => messages.map(({ role, content }) => ({ role, content }));
  const requestDigest = () => createHash('sha256').update(JSON.stringify(calls.map(({ method, p }) => ({ method, model: p.model, messages: comparable(p.messages), temperature: p.temperature, top_p: p.top_p, max_tokens: p.max_tokens, stop: p.stop })))).digest('hex');
  const PIN: Record<Format, string> = { solo: '92515f7db5e97d27d5f712d86f2deb34a24a94bad3b2c297368abee7e57076f0', dialog: 'b9edf021708221b9bb607222d5d93ce79a77c71ef0ba6b8da38e57aa1e80c1e0', beat: '53910ce6f87f56aa3ac4564e3dbf3e43a69923eada518e6f1a018c482bb2d390' };
  const baselineDigests: Partial<Record<Format, string>> = {};
  try {
    // BASELINE_CAPTURE_START: the same fixture can be extracted read-only on the pre-feature tree.
    for (const format of ['solo', 'dialog', 'beat'] as const) {
      const room = await newRoom(format);
      await send(room);
      baselineDigests[format] = requestDigest();
    }
    console.log(`BASELINE_REQUESTS=${JSON.stringify(baselineDigests)}`);
    // BASELINE_CAPTURE_END
    const { responseMaxTokens, responseLengthHint } = await import('../apps/server/src/prompt/responseLength.js');
    await t('unset response length sends byte-identical baseline requests for solo, dialog and beat', () => {
      assert.deepEqual(baselineDigests, PIN);
    });
    await t('normal preserves baseline requests and creates no length instruction', async () => {
      for (const format of ['solo', 'dialog', 'beat'] as const) {
        const room = await newRoom(format, 'normal');
        await send(room);
        assert.equal(requestDigest(), PIN[format], format);
      }
      assert.equal(responseLengthHint({}), '');
      assert.equal(responseLengthHint({ response_length: 'normal' }), '');
    });
    await t('length mapping scales each existing budget; long never reduces a large custom profile', () => {
      for (const [normal, short, long] of [[800, 480, 1600], [900, 540, 1800], [500, 300, 1000]]) {
        assert.equal(responseMaxTokens({ response_length: 'short' }, normal), short);
        assert.equal(responseMaxTokens({ response_length: 'normal' }, normal), normal);
        assert.equal(responseMaxTokens({ response_length: 'long' }, normal), long);
      }
      assert.equal(responseMaxTokens({ response_length: 'long' }, 3000), 4096);
      assert.equal(responseMaxTokens({ response_length: 'long' }, 5000), 5000);
      assert.equal(responseMaxTokens({ response_length: 'short' }, 200), 128);
    });
    await t('create/PATCH persist room length across reads; invalid enum is rejected without writing', async () => {
      const room = await newRoom('solo', 'short');
      assert.equal(sceneOf(room).response_length, 'short');
      for (const length of ['long', 'normal', 'short'] as const) {
        await api('PATCH', `/api/conversations/${room}`, { scene: { response_length: length } });
        assert.equal((await api('GET', `/api/conversations/${room}`)).json().conversation.scene.response_length, length);
        assert.equal(sceneOf(room).response_length, length);
      }
      const before = conv(room).scene_json;
      for (const invalid of ['unlimited', '', 0, null]) {
        await api('PATCH', `/api/conversations/${room}`, { scene: { response_length: invalid } }, 400);
        assert.equal(conv(room).scene_json, before);
      }
      await api('POST', '/api/conversations', { characterId: 'nari', scene: { response_length: 'unlimited' } }, 400);
    });
    for (const format of ['solo', 'dialog'] as const) {
      await t(`${format}: every length preview matches actual messages, output reserve and packed budget`, async () => {
        for (const length of ['short', 'normal', 'long'] as const) {
          const room = await newRoom(format, length);
          const before = await preview(room);
          const actual = await send(room);
          const expected = { solo: { short: 480, normal: 800, long: 1600 }, dialog: { short: 540, normal: 900, long: 1800 } }[format][length];
          assert.equal(actual.max_tokens, expected);
          assert.equal(before.budget.reply_reserve, expected + 64);
          assert.equal(before.budget.available, 8192 - expected - 64);
          assert.equal(format === 'solo' ? before.profile.max_tokens : before.maxTokens, expected);
          assert.deepEqual(comparable(actual.messages), comparable(before.messages));
          const estimated = actual.messages.reduce((sum, m) => sum + estimateMessageTokens(m.content, before.budget.calibration), 0);
          if (format === 'dialog') assert.equal(estimated, before.budget.est_total);
          const logged = db.prepare('SELECT budget_json FROM generation_log WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1').get(room) as { budget_json: string };
          const budget = JSON.parse(logged.budget_json);
          assert.equal(budget.est_total, before.budget.est_total);
          assert.equal(budget.reply_reserve, before.budget.reply_reserve);
          assert.ok(estimated + actual.max_tokens <= 8192);
          assert.equal(sceneOf(room).response_length, length);
        }
      });
    }
    await t('beat length changes only focus output budget; N/E/C preserve their budgets', async () => {
      for (const length of ['short', 'normal', 'long'] as const) {
        const room = await newRoom('beat', length);
        const focus = await send(room);
        assert.equal(focus.max_tokens, { short: 300, normal: 500, long: 1000 }[length]);
        const optional = calls.filter(c => c.method === 'complete').map(c => c.p.max_tokens);
        assert.deepEqual(optional, [200, 300, 220, 220, 160]);
        assert.equal(sceneOf(room).response_length, length);
        assert.equal(comparable(focus.messages).map(m => m.content).join('\n').includes('응답 길이:'), length !== 'normal');
      }
    });
    await t('changing length after a committed dialog turn applies to preview, regeneration and persistence', async () => {
      const room = await newRoom('dialog', 'short');
      await send(room);
      const head = conv(room).head_message_id!;
      await api('PATCH', `/api/conversations/${room}`, { scene: { response_length: 'long' } });
      const before = await preview(room, { regenerate: head });
      calls.length = 0;
      await api('POST', `/api/conversations/${room}/regenerate`, { messageId: head });
      const actual = calls.find(c => c.method === 'stream')!.p;
      assert.equal(actual.max_tokens, 1800);
      assert.equal(before.maxTokens, 1800);
      assert.deepEqual(comparable(actual.messages), comparable(before.messages));
      assert.equal(sceneOf(room).response_length, 'long');
    });
    await t('branch materialization preserves current room length instead of historical snapshot length', async () => {
      const room = await newRoom('dialog', 'long');
      const old: Scene = { ...sceneOf(room), response_length: 'short', location: '옛 방' };
      const user = insertMessage(db, room, null, 'user', '옛 분기', 'complete');
      const row = insertMessage(db, room, user.id, 'assistant', '옛 응답', 'complete', { beat_seq: 0, block_kind: 'narration', scene_state: buildSceneSnapshot(old, old) });
      const scene = materializeSceneAtHead(db, { headId: row.id, fallback: sceneOf(room) });
      assert.equal(scene.response_length, 'long');
      assert.equal(scene.location, '옛 방');
    });
    await t('long history uses the selected output reserve and refuses no valid packed solo input', async () => {
      const room = await newRoom('solo', 'long');
      let head: string | null = null;
      for (let i = 0; i < 100; i++) head = insertMessage(db, room, head, i % 2 ? 'assistant' : 'user', `과거 ${i} ` + '대화의 사건을 기억한다. '.repeat(40), 'complete').id;
      setHead(db, room, head);
      const current = insertMessage(db, room, head, 'user', input, 'complete');
      setHead(db, room, current.id);
      const built = buildPrompt(db, conv(room), getPath(db, conv(room)), 8192, 'mock-model');
      assert.equal(built.profile.max_tokens, 1600);
      assert.equal(built.budget.reply_reserve, 1664);
      assert.ok(built.budget.dropped_messages > 0);
      const estimated = built.messages.reduce((sum, m) => sum + estimateMessageTokens(m.content, built.budget.calibration), 0);
      assert.ok(estimated + built.profile.max_tokens <= 8192, `wire ${estimated} + output ${built.profile.max_tokens} > context 8192`);
      assert.equal(built.budget.instruction_overflow, undefined);
    });
    await t('oversized current input is never truncated: preview reports it and send refuses before any model call', async () => {
      const room = await newRoom('solo', 'long');
      const current = '가'.repeat(8000);
      const headBefore = conv(room).head_message_id;
      const count = () => (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(room) as { n: number }).n;
      const countBefore = count();
      const p = await preview(room, { draft: current });
      assert.equal(p.messages.at(-1).content, current);
      assert.equal(p.budget.instruction_overflow.reason, 'response_length');
      assert.ok(p.budget.instruction_overflow.required > p.budget.instruction_overflow.available);
      calls.length = 0;
      const refused = await api('POST', `/api/conversations/${room}/messages`, { content: current }, 422);
      assert.match(refused.json().error, /선택한 응답 길이/);
      assert.doesNotMatch(refused.json().error, /지침|LITE/);
      assert.equal(calls.length, 0);
      assert.equal(conv(room).head_message_id, headBefore);
      assert.equal(count(), countBefore);
      assert.deepEqual(ctx.queue.activeList, []);
    });
    await t('explicit length bounds merged-system and instruction-enabled histories while retaining current input', async () => {
      db.prepare("INSERT INTO model_profiles (name, max_tokens, system_mode) VALUES ('merge-profile', 800, 'merge')").run();
      db.prepare("INSERT INTO model_profiles (name, max_tokens, instruction_enabled, instruction_text) VALUES ('instruction-profile', 800, 1, 'SYNTHETIC_LENGTH_INSTRUCTION: 명확한 행동과 대사를 쓴다.')").run();
      for (const profileName of ['merge-profile', 'instruction-profile']) for (const response_length of ['short', 'long'] as const) {
        const room = await newRoom('solo', response_length);
        await api('PATCH', `/api/conversations/${room}`, { profileName });
        let head: string | null = null;
        for (let i = 0; i < 50; i++) head = insertMessage(db, room, head, i % 2 ? 'assistant' : 'user', `과거 ${i} ` + '진행한 사건을 기억한다. '.repeat(60), 'complete').id;
        head = insertMessage(db, room, head, 'user', 'CURRENT_INPUT_KEEP', 'complete').id;
        setHead(db, room, head);
        const built = buildPrompt(db, conv(room), getPath(db, conv(room)), 8192, 'mock-model');
        const estimated = built.messages.reduce((sum, m) => sum + estimateMessageTokens(m.content, built.budget.calibration), 0);
        assert.ok(estimated + built.profile.max_tokens <= 8192);
        assert.equal(built.budget.est_total, estimated);
        assert.equal(built.budget.instruction_overflow, undefined);
        assert.ok(built.budget.dropped_messages > 0);
        assert.ok(built.messages.at(-1)!.content.endsWith('CURRENT_INPUT_KEEP'));
        assert.equal(built.messages[0].role, profileName === 'merge-profile' ? 'user' : 'system');
        if (profileName === 'instruction-profile') assert.ok(built.messages[0].content.includes('SYNTHETIC_LENGTH_INSTRUCTION'));
      }
    });
    await t('dialog persists model length termination for the first and final generated block', async () => {
      const room = await newRoom('dialog', 'long');
      finishReason = 'length';
      try { await send(room); } finally { finishReason = 'stop'; }
      const rows = getPath(db, conv(room)).filter(row => row.role === 'assistant');
      const generated = rows.filter(row => !['header', 'info', 'ui'].includes(JSON.parse(row.meta_json).block_kind));
      assert.ok(generated.length >= 2);
      assert.equal(JSON.parse(generated[0].meta_json).finish_reason, 'length');
      assert.equal(JSON.parse(rows.at(-1)!.meta_json).finish_reason, 'length');
    });
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) throw new AggregateError(failures, 'response length contract failures');
  } finally {
    await app.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exit(1); });
