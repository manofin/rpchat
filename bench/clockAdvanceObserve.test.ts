/**
 * npx tsx bench/clockAdvanceObserve.test.ts
 * clock-advance-observe (ADR-F9c §8.2) — classify the model's advance_minutes
 * proposal and hold it off the scene. The clock stays frozen; the log records
 * missing / zero / positive / invalid / unparsed so a later slice can pick
 * 1 / 2 / 3 / 5 without guessing.
 *
 * Isolated: no systemd, no live DB, no live generate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { openDb, parseJson } from '../apps/server/src/db/index.ts';
import { GenerationQueue } from '../apps/server/src/model/queue.ts';
import { characterRoutes } from '../apps/server/src/routes/characters.ts';
import { conversationRoutes } from '../apps/server/src/routes/conversations.ts';
import { storyRoutes } from '../apps/server/src/routes/stories.ts';
import { chatRoutes } from '../apps/server/src/routes/chat.ts';
import { DEFAULT_STORY_CLOCK_MINUTES } from '../apps/server/src/prompt/initScene.ts';
import { applySceneDelta } from '../apps/server/src/prompt/applySceneDelta.ts';
import {
  CLOCK_OBSERVE_FRAMING,
  classifyClockObserve,
  holdClockProposal,
  stripAdvanceMinutes,
} from '../apps/server/src/prompt/clockObserve.ts';
import { THOUGHT_MARKER } from '../apps/server/src/prompt/passes.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';
import type { Scene } from '../apps/server/src/types.ts';
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

function ok(text: string): GenResult {
  return { text, finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 };
}

function versionOf(prompt: string): number {
  const m = prompt.match(/\{"base_version": (\d+)\}/);
  return m ? Number(m[1]) : 0;
}

async function main() {
await t('missing / zero / positive / invalid / unparsed are distinct kinds', () => {
  const missing = classifyClockObserve({ base_version: 0 }, '안녕');
  assert.equal(missing.kind, 'missing');
  assert.equal(missing.value, null);
  assert.equal(missing.applied, false);
  assert.equal(missing.framing, CLOCK_OBSERVE_FRAMING);

  const zero = classifyClockObserve({ base_version: 0, advance_minutes: 0 }, '문을 열고 멈춘다');
  assert.equal(zero.kind, 'zero');
  assert.equal(zero.value, 0);

  const positive = classifyClockObserve({ base_version: 0, advance_minutes: 10 }, '10분쯤');
  assert.equal(positive.kind, 'positive');
  assert.equal(positive.value, 10);
  assert.equal(positive.user_time_expression, true);

  const over = classifyClockObserve({ base_version: 0, advance_minutes: 1441 }, '');
  assert.equal(over.kind, 'invalid');
  assert.equal(over.value, 1441);

  const neg = classifyClockObserve({ base_version: 0, advance_minutes: -1 }, '');
  assert.equal(neg.kind, 'invalid');

  const frac = classifyClockObserve({ base_version: 0, advance_minutes: 1.5 }, '');
  assert.equal(frac.kind, 'invalid');

  const str = classifyClockObserve({ base_version: 0, advance_minutes: '30' }, '30분');
  assert.equal(str.kind, 'invalid');
  assert.equal(str.raw_type, 'string');
  assert.equal(str.user_time_expression, true);

  const unparsed = classifyClockObserve(null, '이따 보자');
  assert.equal(unparsed.kind, 'unparsed');
  assert.equal(unparsed.user_time_expression, true);
});

await t('explicit 0 is not missing, and a missing key is not zero', () => {
  const zero = classifyClockObserve({ advance_minutes: 0 }, '');
  const missing = classifyClockObserve({ weather: '맑음' }, '');
  assert.equal(zero.kind, 'zero');
  assert.equal(missing.kind, 'missing');
  assert.notEqual(zero.kind, missing.kind);
});

await t('user time expression uses the ADR token set and is independent of the key', () => {
  assert.equal(classifyClockObserve({ advance_minutes: 5 }, '측정 끝났어요').user_time_expression, false);
  assert.equal(classifyClockObserve(null, '시간도 30분쯤 지났고').user_time_expression, true);
  assert.equal(classifyClockObserve({ advance_minutes: 0 }, '이따 복도에서').user_time_expression, true);
  assert.equal(classifyClockObserve({ advance_minutes: 2 }, '한 시간만').user_time_expression, true);
  assert.equal(classifyClockObserve({ advance_minutes: 2 }, '뒤에서 기다린다').user_time_expression, true);
  assert.equal(classifyClockObserve({ advance_minutes: 2 }, '그 후').user_time_expression, true);
  assert.equal(classifyClockObserve({ advance_minutes: 2 }, '나중에').user_time_expression, true);
});

await t('strip removes only advance_minutes and leaves the rest of the patch', () => {
  const stripped = stripAdvanceMinutes({
    base_version: 0, weather: '맑음', advance_minutes: 10, flags: { rulebreak: true },
  });
  assert.deepEqual(stripped, { base_version: 0, weather: '맑음', flags: { rulebreak: true } });
  assert.equal(stripAdvanceMinutes(null), null);
  const already = { base_version: 1 };
  assert.equal(stripAdvanceMinutes(already), already);
});

await t('applySceneDelta still moves the clock when the key is passed (observe is the generate-path hold)', () => {
  const scene: Scene = { clock_minutes: 578, scene_version: 0 };
  const catalog = { weathers: ['맑음'], locations: [], arcs: [], stagesByArc: {}, flags: {} };
  const applied = applySceneDelta(scene, { base_version: 0, advance_minutes: 10 }, catalog, 0);
  assert.equal(applied.state.clock_minutes, 588);
  assert.ok(applied.applied.includes('advance_minutes'));

  const held = holdClockProposal({ base_version: 0, advance_minutes: 10 }, '10분쯤');
  const frozen = applySceneDelta(scene, held.patch, catalog, 0);
  assert.equal(frozen.state.clock_minutes, 578);
  assert.equal(held.observe.kind, 'positive');
  assert.equal(held.observe.applied, false);
  assert.equal(held.observe.value, 10);
});

await t('chat.ts holds the clock on all three multi-row paths and records clock_observe', () => {
  const s = code('apps/server/src/routes/chat.ts');
  assert.equal((s.match(/holdClockProposal\(patch, userText\)/g) ?? []).length, 3);
  const beat = s.slice(s.indexOf('async function generateBeat'));
  const dialog = s.slice(s.indexOf('async function generateDialog'));
  const hunter = s.slice(s.indexOf('async function generateHunter'));
  assert.ok(beat.includes('clock_observe:'));
  assert.ok(dialog.includes('clock_observe:'));
  assert.ok(hunter.includes('clock_observe:'));
  assert.equal(s.includes('CLOCK_OBSERVE_FRAMING = '), false, 'framing is not redefined in chat.ts');
});

await t('sceneDeltaPrompt is not reframed in this slice', () => {
  const prompt = code('apps/server/src/prompt/sceneDeltaPrompt.ts');
  assert.ok(prompt.includes('사용자 입력으로 장면 상태가 실제로 바뀌었는지만 판정한다'));
  assert.ok(prompt.includes('advance_minutes": 5}'));
});

async function generatePath() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-clock-observe-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));
  db.prepare(
    `INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes) VALUES (?,?,?,?,?,?,?,?)`,
  ).run('rp-balanced', null, 0.8, 0.95, 400, '[]', 'system', null);

  let deltaBody: Record<string, unknown> = { advance_minutes: 10, weather: '맑음' };
  let deltaGarbage = false;
  const model = {
    complete: async (p: GenParams): Promise<GenResult> => {
      const prompt = String(p.messages?.[0]?.content ?? '');
      if (prompt.includes('장면 진행 판정기')) {
        if (deltaGarbage) return ok('not json');
        const v = versionOf(prompt);
        return ok(JSON.stringify({ base_version: v, ...deltaBody }));
      }
      if (prompt.includes('입력 초안만 쓴다')) return ok('<choices>["가","나","다"]</choices>');
      if (prompt.includes('너는 장면 서술자다') || prompt.includes('군중') || prompt.startsWith('당신은 카메라')) {
        return ok('서술이 이어진다.');
      }
      return ok('"교칙이야."');
    },
    stream: async (p: GenParams, onToken: (d: string) => void): Promise<GenResult> => {
      const text = `"……짝꿍?"\n${THOUGHT_MARKER} 왜 안 피하지.`;
      for (const c of text.match(/.{1,24}/gs) ?? [text]) onToken(c);
      return { text, finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 3 };
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
    const res = await fetch(`${origin}${url}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = text;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, json, text };
  };
  const send = async (conv: string, content: string) => {
    const res = await fetch(`${origin}/api/conversations/${conv}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }),
    });
    const text = await res.text();
    assert.equal(res.status, 200, text);
  };
  const sceneOf = (id: string): Scene => {
    const row = db.prepare('SELECT scene_json FROM conversations WHERE id = ?').get(id) as { scene_json: string };
    return JSON.parse(row.scene_json) as Scene;
  };
  const beatLogOf = (id: string) => {
    const row = db.prepare(
      `SELECT budget_json FROM generation_log WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(id) as { budget_json: string };
    return parseJson<{ beat_log?: { clock_observe?: Record<string, unknown> } }>(row.budget_json, {}).beat_log?.clock_observe;
  };

  const char = async (name: string, tags: string[]) => {
    const res = await api('POST', '/api/characters', { name, personality: `${name} 성격`, first_message: '', tags });
    return res.json as { id: string };
  };
  const nari = await char('나리', ['party:duty=이야기', 'party:place=교실']);
  const sera = await char('세라', ['party:duty=교칙', 'party:place=교실']);
  const hayeon = await char('하연', ['party:duty=수업', 'party:place=교실']);
  const storyRes = await api('POST', '/api/stories', {
    name: '히어로 아카데미', tagline: 'S반', setting: '교실', minor_cast: [],
    scene_catalog: { places: [{ id: '교실', name: 'S반 교실', default_focus: 'nari' }], weathers: ['맑음', '흐림'], arcs: ['entry'], duties: { 교칙: { slot: '질서' } } },
  });
  const story = (storyRes.json as { id: string }).id;
  for (const [id, order] of [[hayeon.id, 0], [nari.id, 1], [sera.id, 2]] as const) {
    await api('POST', `/api/stories/${story}/characters`, { characterId: id, sortOrder: order });
  }
  const convRes = await api('POST', '/api/conversations', { characterId: hayeon.id, storyId: story, mode: 'story' });
  const conv = (convRes.json as { id: string }).id;

  return { app, db, tmp, conv, send, sceneOf, beatLogOf, setDelta: (b: Record<string, unknown> | 'garbage') => {
    if (b === 'garbage') { deltaGarbage = true; return; }
    deltaGarbage = false;
    deltaBody = b;
  } };
}

await t('a successful beat records the proposal and does not move the clock', async () => {
  const h = await generatePath();
  try {
    assert.equal(h.sceneOf(h.conv).clock_minutes, DEFAULT_STORY_CLOCK_MINUTES);
    await h.send(h.conv, '10분쯤 지났어요');
    const scene = h.sceneOf(h.conv);
    assert.equal(scene.clock_minutes, DEFAULT_STORY_CLOCK_MINUTES, 'clock held');
    assert.equal(scene.weather, '맑음');
    const obs = h.beatLogOf(h.conv);
    assert.ok(obs);
    assert.equal(obs!.framing, CLOCK_OBSERVE_FRAMING);
    assert.equal(obs!.kind, 'positive');
    assert.equal(obs!.value, 10);
    assert.equal(obs!.applied, false);
    assert.equal(obs!.discarded, false);
    assert.equal(obs!.user_time_expression, true);
  } finally {
    await h.app.close();
    h.db.close();
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }
});

await t('explicit 0, missing, invalid, and unparsed all leave the clock frozen and are logged', async () => {
  const h = await generatePath();
  try {
    const cases: Array<{ delta: Record<string, unknown> | 'garbage'; text: string; kind: string; value: number | null; expr: boolean }> = [
      { delta: { advance_minutes: 0, weather: '맑음' }, text: '문을 열고 멈춘다', kind: 'zero', value: 0, expr: false },
      { delta: { weather: '맑음' }, text: '그냥 서 있는다', kind: 'missing', value: null, expr: false },
      { delta: { advance_minutes: 1441, weather: '맑음' }, text: '하루가 지났다', kind: 'invalid', value: 1441, expr: false },
      { delta: 'garbage', text: '이따 복도에서', kind: 'unparsed', value: null, expr: true },
    ];
    for (const c of cases) {
      h.setDelta(c.delta);
      const before = h.sceneOf(h.conv).clock_minutes;
      await h.send(h.conv, c.text);
      assert.equal(h.sceneOf(h.conv).clock_minutes, before, c.kind);
      const obs = h.beatLogOf(h.conv)!;
      assert.equal(obs.kind, c.kind, c.kind);
      assert.equal(obs.value, c.value, c.kind);
      assert.equal(obs.applied, false, c.kind);
      assert.equal(obs.user_time_expression, c.expr, c.kind);
    }
  } finally {
    await h.app.close();
    h.db.close();
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }
});

await t('other scene keys still apply while time is held', async () => {
  const h = await generatePath();
  try {
    h.setDelta({ advance_minutes: 30, weather: '흐림' });
    await h.send(h.conv, '밖이 개어서 날씨가 바뀌었고 시간도 30분쯤 지났어요');
    const scene = h.sceneOf(h.conv);
    assert.equal(scene.weather, '흐림');
    assert.equal(scene.clock_minutes, DEFAULT_STORY_CLOCK_MINUTES);
    const obs = h.beatLogOf(h.conv)!;
    assert.equal(obs.kind, 'positive');
    assert.equal(obs.value, 30);
    assert.equal(obs.user_time_expression, true);
  } finally {
    await h.app.close();
    h.db.close();
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
