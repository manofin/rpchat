/** npx tsx bench/profileInstructionOverflow.test.ts
 * profile-instruction (0023) — an instruction that does not fit is refused before generation.
 *
 *   1:1       → buildPrompt reports instruction_overflow → POST messages 422 before any model
 *               call; user message retracted, no assistant row, no generation_log row
 *   party     → the rendered block alone exceeds this format's smallest IC prompt budget →
 *               422 before the scene-delta call (beat and dialog); nothing persisted
 *   fitting   → a LITE-sized instruction still generates (1:1 and beat)
 *   report    → conversation prompt-preview / character prompt-preview stay 200 and show it
 *   EMA       → every refusal leaves settings.token_calibration unchanged (no model call → no usage)
 *   P1 regen  → a refused regenerate (1:1 422, 1:1 503, beat 422) restores head_message_id,
 *               so the existing reply stays on the active path
 *
 * Sets CONTEXT_TOKENS=16384 (the live value) before importing product modules — config.ts
 * reads it at import time. Temp DB with token_calibration 1.173 (live). Fake model counts calls.
 * Isolated: no systemd, no live DB, no real model call.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONTEXT_TOKENS = '16384';

let passed = 0;
async function t(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

async function main() {
  const { default: Fastify } = await import('fastify');
  const { config } = await import('../apps/server/src/config.ts');
  const { openMigratedDb } = await import('../apps/server/src/db/index.ts');
  const { GenerationQueue } = await import('../apps/server/src/model/queue.ts');
  const { characterRoutes } = await import('../apps/server/src/routes/characters.ts');
  const { conversationRoutes } = await import('../apps/server/src/routes/conversations.ts');
  const { storyRoutes } = await import('../apps/server/src/routes/stories.ts');
  const { chatRoutes } = await import('../apps/server/src/routes/chat.ts');
  const { THOUGHT_MARKER } = await import('../apps/server/src/prompt/passes.ts');
  type Ctx = import('../apps/server/src/ctx.ts').Ctx;
  type GenParams = import('../apps/server/src/model/adapter.ts').GenParams;

  await t('bench runs at the live context size', () => {
    assert.equal(config.model.contextTokens, 16384);
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-pi-overflow-'));
  const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
  db.prepare("INSERT INTO settings (key, value) VALUES ('token_calibration', '1.173')").run();
  const ins = db.prepare('INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes, instruction_enabled, instruction_text) VALUES (?,?,?,?,?,?,?,?,?,?)');
  ins.run('rp-balanced', null, 0.8, 0.95, 800, '[]', 'system', null, 0, null);
  // 20000 hangul ≈ 14000 × 1.173 ≈ 16422 tokens: over the 1:1 budget (15520) and every IC budget.
  ins.run('rp-huge', null, 0.8, 0.95, 800, '[]', 'system', '초과', 1, '가'.repeat(20000));
  ins.run('rp-lite', null, 0.8, 0.95, 800, '[]', 'system', '합성 LITE', 1, '# LITE_MARK 합성\n- {{user}} 대필 금지.\n');

  const calls: GenParams[] = [];
  const model = {
    complete: async (p: GenParams) => {
      calls.push(p);
      const prompt = String(p.messages?.[0]?.content ?? '');
      if (prompt.includes('장면 진행 판정기')) return { text: '{"base_version":0}', finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 };
      if (prompt.includes('입력 초안')) return { text: '<choices>["*a* 응.","*b* 아니.","*c* 왜?"]</choices>', finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 };
      return { text: '교실이 조용해졌다.', finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 };
    },
    stream: async (p: GenParams, onToken: (d: string) => void) => {
      calls.push(p);
      const text = `"응."\n${THOUGHT_MARKER} 흠.`;
      onToken(text);
      return { text, finishReason: 'stop', usage: { prompt_tokens: 20, completion_tokens: 5 }, ttftMs: 1, totalMs: 1 };
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
    const res = await fetch(`${origin}${url}`, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any = text;
    try { json = text ? JSON.parse(text) : null; } catch { /* sse */ }
    return { status: res.status, json, text };
  };
  const counts = (convId: string) => ({
    messages: (db.prepare('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?').get(convId) as { c: number }).c,
    logs: (db.prepare('SELECT COUNT(*) AS c FROM generation_log WHERE conversation_id = ?').get(convId) as { c: number }).c,
    head: (db.prepare('SELECT head_message_id AS h FROM conversations WHERE id = ?').get(convId) as { h: string | null }).h,
  });
  // A completed 1:1 turn feeds usage back into the EMA calibration; pin it to the live value
  // before each overflow case so the arithmetic in the header comment holds.
  const liveCalibration = () => db.prepare("UPDATE settings SET value = '1.173' WHERE key = 'token_calibration'").run();
  const calibration = () => (db.prepare("SELECT value FROM settings WHERE key = 'token_calibration'").get() as { value: string }).value;
  const REFUSAL = /^서술 지침이 컨텍스트 예산을 넘어 생성하지 않음: 프로필 rp-huge, 지침 추정 \d+토큰, 필요 \d+ > 가용 \d+\./;

  const solo = await api('POST', '/api/characters', { name: '단독캐', personality: '성격', first_message: '' });
  assert.equal(solo.status, 201, solo.text);
  const soloId = solo.json.id as string;
  const newConv = async (body: object) => {
    const r = await api('POST', '/api/conversations', body);
    assert.equal(r.status, 201, r.text);
    return r.json.id as string;
  };

  await t('1:1 overflow → 422 before any model call; nothing persisted', async () => {
    const convId = await newConv({ characterId: soloId, profileName: 'rp-huge' });
    const before = counts(convId);
    const calBefore = calibration();
    calls.length = 0;
    const r = await api('POST', `/api/conversations/${convId}/messages`, { content: '안녕.' });
    assert.equal(r.status, 422, r.text);
    assert.match(r.json.error, REFUSAL);
    assert.equal(calls.length, 0, 'model never called');
    assert.deepEqual(counts(convId), before, 'user message retracted, no assistant row, no log, head restored');
    assert.equal(calibration(), calBefore, 'token_calibration untouched');
  });

  await t('1:1 fitting (LITE-size) instruction still generates', async () => {
    const convId = await newConv({ characterId: soloId, profileName: 'rp-lite' });
    calls.length = 0;
    const r = await api('POST', `/api/conversations/${convId}/messages`, { content: '안녕.' });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.text.includes('"type":"done"'));
    assert.equal(calls.length, 1);
    assert.ok(String(calls[0].messages[0].content).includes('### 서술 지침\n# LITE_MARK'));
  });

  await t('conversation prompt-preview (inspector) stays 200 and reports the overflow', async () => {
    liveCalibration();
    const convId = await newConv({ characterId: soloId, profileName: 'rp-huge' });
    const r = await api('GET', `/api/conversations/${convId}/prompt-preview?draft=${encodeURIComponent('안녕.')}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.budget.instruction_overflow.profile, 'rp-huge');
    assert.match(r.json.budget.sections.find((s: { name: string }) => s.name === '서술 지침').note, /생성 거부/);
  });

  await t('character prompt-preview stays 200 with the refusal note', async () => {
    liveCalibration();
    db.prepare("UPDATE characters SET default_profile_name = 'rp-huge' WHERE id = ?").run(soloId);
    const r = await api('GET', `/api/characters/${soloId}/prompt-preview`);
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.sections.find((s: { name: string }) => s.name === '서술 지침').note, /생성 거부/);
    db.prepare('UPDATE characters SET default_profile_name = NULL WHERE id = ?').run(soloId);
  });

  // ── party ───────────────────────────────────────────────────────────────
  const mk = async (name: string, tags: string[]) => {
    const r = await api('POST', '/api/characters', { name, personality: `${name} 성격`, first_message: '', tags });
    assert.equal(r.status, 201, r.text);
    return r.json.id as string;
  };
  const a = await mk('파티가', ['party:duty=수업', 'party:place=교실']);
  const b = await mk('파티나', ['party:duty=교칙', 'party:place=교실']);
  const story = await api('POST', '/api/stories', {
    name: '초과 파티', tagline: '', setting: '교실', minor_cast: [],
    scene_catalog: { places: [{ id: '교실', name: '교실', default_focus: 'x' }], weathers: ['맑음'], arcs: ['entry'], stagesByArc: { entry: ['reg'] } },
  });
  assert.equal(story.status, 201, story.text);
  for (const [id, order] of [[a, 0], [b, 1]] as const) {
    assert.equal((await api('POST', `/api/stories/${story.json.id}/characters`, { characterId: id, sortOrder: order })).status, 201);
  }

  for (const fmt of ['beat', 'dialog'] as const) {
    await t(`party ${fmt}: block alone over the smallest IC budget → 422 before the scene-delta call`, async () => {
      liveCalibration();
      const convId = await newConv({ characterId: a, storyId: story.json.id, mode: 'story', profileName: 'rp-huge', ...(fmt === 'dialog' ? { scene: { format: 'dialog' } } : {}) });
      const before = counts(convId);
      const calBefore = calibration();
      calls.length = 0;
      const r = await api('POST', `/api/conversations/${convId}/messages`, { content: '파티가, 안녕.' });
      assert.equal(r.status, 422, r.text);
      assert.match(r.json.error, REFUSAL);
      assert.equal(calls.length, 0, 'no delta, no pass');
      assert.deepEqual(counts(convId), before);
      assert.equal(calibration(), calBefore, 'token_calibration untouched');
      assert.equal(ctx.queue.activeList.length, 0, 'queue not left registered');
    });
  }

  await t('party beat with a fitting instruction still runs and carries it', async () => {
    const convId = await newConv({ characterId: a, storyId: story.json.id, mode: 'story', profileName: 'rp-lite' });
    calls.length = 0;
    const r = await api('POST', `/api/conversations/${convId}/messages`, { content: '파티가, 안녕.' });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.text.includes('"type":"done"'));
    assert.ok(calls.some((p) => String(p.messages[0].content).includes('## 서술 지침\n# LITE_MARK')));
  });

  // ── P1: refused regenerate keeps the existing reply on the active path ──
  const lastAssistant = (convId: string) =>
    (db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(convId) as { id: string }).id;
  const regenRefused = async (convId: string, expectStatus: number) => {
    const before = counts(convId);
    assert.ok(before.head, 'room has an active head');
    const calBefore = calibration();
    calls.length = 0;
    const r = await api('POST', `/api/conversations/${convId}/regenerate`, { messageId: lastAssistant(convId) });
    assert.equal(r.status, expectStatus, r.text);
    assert.equal(calls.length, 0, 'model never called');
    assert.deepEqual(counts(convId), before, 'head restored, no rows, no log');
    assert.equal(calibration(), calBefore, 'token_calibration untouched');
    return r;
  };

  await t('P1 1:1 regenerate refused by 422 → head_message_id restored', async () => {
    const convId = await newConv({ characterId: soloId, profileName: 'rp-lite' });
    assert.equal((await api('POST', `/api/conversations/${convId}/messages`, { content: '안녕.' })).status, 200);
    assert.equal((await api('PATCH', `/api/conversations/${convId}`, { profileName: 'rp-huge' })).status, 200);
    liveCalibration();
    const r = await regenRefused(convId, 422);
    assert.match(r.json.error, REFUSAL);
  });

  await t('P1 1:1 regenerate refused by 503 (no model name) → head_message_id restored', async () => {
    const convId = await newConv({ characterId: soloId, profileName: 'rp-lite' });
    assert.equal((await api('POST', `/api/conversations/${convId}/messages`, { content: '안녕.' })).status, 200);
    const resolved = ctx.resolvedModel;
    ctx.resolvedModel = () => '';
    try {
      await regenRefused(convId, 503);
    } finally {
      ctx.resolvedModel = resolved;
    }
  });

  await t('P1 party beat regenerate refused by 422 → head_message_id restored', async () => {
    const convId = await newConv({ characterId: a, storyId: story.json.id, mode: 'story', profileName: 'rp-lite' });
    const sent = await api('POST', `/api/conversations/${convId}/messages`, { content: '파티가, 안녕.' });
    assert.equal(sent.status, 200, sent.text);
    assert.equal((await api('PATCH', `/api/conversations/${convId}`, { profileName: 'rp-huge' })).status, 200);
    liveCalibration();
    await regenRefused(convId, 422);
    assert.equal(ctx.queue.activeList.length, 0, 'queue not left registered');
  });

  await app.close();
  db.close();
  console.log(`PASS=${passed}`);
}

main().catch((e) => {
  console.error('RED', e);
  process.exit(1);
});
