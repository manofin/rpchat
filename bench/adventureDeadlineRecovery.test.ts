/** npx tsx bench/adventureDeadlineRecovery.test.ts */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.ts';
import { GenerationQueue } from '../apps/server/src/model/queue.ts';
import { characterRoutes } from '../apps/server/src/routes/characters.ts';
import { conversationRoutes } from '../apps/server/src/routes/conversations.ts';
import { chatRoutes } from '../apps/server/src/routes/chat.ts';
import { storyRoutes } from '../apps/server/src/routes/stories.ts';
import { adventureRoutes } from '../apps/server/src/routes/adventure.ts';
import { renderAdventureState } from '../apps/server/src/adventure/state.ts';
import { TurnDeadlineError } from '../apps/server/src/model/turnDeadline.ts';
import type { Ctx } from '../apps/server/src/ctx.ts';
import type { GenParams, GenResult } from '../apps/server/src/model/adapter.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}
const T = '2026-10-15 00:00:00';
const adv = (currency: string, balance: number) => ({
  version: 1, revision: 1, currency, balance, registration: null, rank: '', experience: 0, skills: [] as string[], quests: [] as unknown[], items: [] as unknown[],
});
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-deadline-'));
const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
const seen: string[] = [];
let mode: 'record' | 'deadline' = 'record';
const model = {
  complete: async (p: GenParams): Promise<GenResult> => {
    seen.push(p.messages.map((m) => m.content).join('\n'));
    if (mode === 'deadline') throw new TurnDeadlineError();
    return { text: 'null', finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 };
  },
  stream: async (p: GenParams, cb: (d: string) => void) => {
    seen.push(p.messages.map((m) => m.content).join('\n'));
    if (mode === 'deadline') throw new TurnDeadlineError();
    cb('나리 | 응답');
    return { text: '나리 | 응답', finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 };
  },
  listModels: async () => ['test-model'],
};
const ctx = {
  db, model, queue: new GenerationQueue(1),
  log: { error() {}, info() {}, warn() {}, debug() {} },
  resolvedModel: () => 'test-model', setResolvedModel() {},
  health: async () => ({ ok: true, checkedAt: T, latencyMs: 0, models: ['test-model'] }),
  effectiveDataDir: tmp,
} as unknown as Ctx;
const app = Fastify({ logger: false });

async function confirmedDeadlineCase(format: 'beat' | 'dialog', lateReject: boolean, index: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-confirmed-deadline-'));
  const isolatedDb = openMigratedDb(dir, path.resolve('apps/server/migrations'));
  const queue = new GenerationQueue(1);
  const requests: string[] = [];
  const result = (text: string): GenResult => ({ text, finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 });
  type Held = { reject: boolean; release?: () => void; lateToken?: () => void };
  let hang: Held | null = null;
  let held: Held | null = null;
  let pending: Promise<{ body: string }> | undefined;
  const adapter = {
    complete: async (p: GenParams) => {
      const text = p.messages.map(m => m.content).join('\n');
      requests.push(text);
      return result(text.includes('장면 진행 판정기') ? 'null'
        : text.includes('입력 초안만 쓴다') ? '<choices>["기다린다"]</choices>'
        : text.startsWith('너는 장면 서술자다') ? '바람이 창문을 흔든다.' : '"알겠어."');
    },
    stream: async (p: GenParams, token: (text: string) => void) => {
      requests.push(p.messages.map(m => m.content).join('\n'));
      const old = hang;
      if (old) {
        old.lateToken = () => token('LATE_OLD_TOKEN');
        await new Promise<void>(resolve => { old.release = resolve; });
        if (old.reject) throw new Error('late old adapter failure');
      }
      token('나리 | 알겠어.');
      return result('나리 | 알겠어.');
    },
  };
  const isolatedApp = Fastify({ logger: false });
  const isolatedCtx = {
    db: isolatedDb, queue, model: adapter, resolvedModel: () => 'mock',
    log: { warn() {}, error() {}, info() {}, debug() {} },
  } as unknown as Ctx;
  const post = (url: string, payload: object) => isolatedApp.inject({ method: 'POST', url, payload });
  const api = async (url: string, payload: object) => {
    const response = await post(url, payload);
    assert.ok(response.statusCode < 400, response.body);
    return response.json();
  };
  const snapshot = (id: string) => ({
    conversation: isolatedDb.prepare('SELECT head_message_id, scene_json FROM conversations WHERE id=?').get(id),
    messages: isolatedDb.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY id').all(id),
  });
  const logCount = (id: string) => (isolatedDb.prepare('SELECT count(*) AS n FROM generation_log WHERE conversation_id=?').get(id) as { n: number }).n;
  const spin = async (predicate: () => boolean) => {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(predicate(), 'async route reached expected phase');
  };
  const phase = (step: number, detail: string) => console.log(`phase ${format} late ${lateReject ? 'error' : 'tokens'} step=${step} ${detail}`);
  try {
    isolatedDb.prepare("INSERT INTO model_profiles(name,temperature,top_p,max_tokens,stop_json,system_mode) VALUES ('rp-balanced',0.8,0.95,500,'[]','system')").run();
    for (const routes of [characterRoutes, storyRoutes, conversationRoutes, chatRoutes, adventureRoutes]) isolatedApp.register(routes(isolatedCtx));
    const actor = await api('/api/characters', { name: '나리', first_message: '', tags: ['party:place=교실'] });
    const other = await api('/api/characters', { name: '세라', first_message: '', tags: ['party:place=교실'] });
    const story = await api('/api/stories', { name: 'confirmed deadline fixture', setting: '교실', scene_catalog: { places: [{ id: '교실' }] } });
    for (const [i, character] of [actor, other].entries()) await api(`/api/stories/${story.id}/characters`, { characterId: character.id, sortOrder: i });
    const room = async () => {
      const conversation = await api('/api/conversations', {
        characterId: actor.id, storyId: story.id, mode: 'story',
        scene: { format, location: '교실', present_ids: [actor.id, other.id] },
      });
      const response = await post(`/api/conversations/${conversation.id}/messages`, { content: '나리, 인사해.' });
      assert.match(response.body, /"type":"done"/);
      assert.doesNotMatch(response.body, /"type":"error"/);
      return conversation.id as string;
    };
    const id = await room();
    const load = () => isolatedDb.prepare('SELECT head_message_id, scene_json FROM conversations WHERE id=?').get(id) as { head_message_id: string; scene_json: string };
    const A = adv(`AURUM_${format}_${index}`, 37 + index);
    const initial = load();
    const initialized = await post(`/api/conversations/${id}/adventure-actions`, {
      expected_head_id: initial.head_message_id,
      expected_scene_version: JSON.parse(initial.scene_json).scene_version ?? 0,
      idempotency_key: randomUUID(),
      action: { kind: 'initialize', currency: A.currency, balance: A.balance, rank: A.rank, experience: A.experience, skills: A.skills },
    });
    assert.equal(initialized.statusCode, 201, initialized.body);
    assert.deepEqual(JSON.parse(load().scene_json).adventure, A);
    phase(1, `initialize committed ${A.currency} balance=${A.balance}`);
    const before = snapshot(id);
    const old: Held = { reject: lateReject };
    held = hang = old;
    let settled = false;
    mock.timers.enable({ apis: ['setTimeout'] });
    pending = post(`/api/conversations/${id}/messages`, { content: '나리, 제한 시간을 기다린다.' }).then(response => {
      settled = true;
      return response;
    });
    await spin(() => Boolean(old.release));
    const active = queue.activeList.find(generation => generation.conversationId === id);
    assert.ok(active?.turnDeadline, 'held generation has a real turn deadline');
    phase(2, `adapter held generation=${active.id}`);
    active.turnDeadline.tripDeadline();
    await spin(() => settled);
    const expired = await pending;
    assert.match(expired.body, /"code":"turn_deadline_exceeded"/);
    assert.deepEqual(snapshot(id), before, 'deadline restores head, scene and every message row');
    assert.ok(queue.activeList.some(generation => generation.id === active.id), 'old adapter still holds its slot');
    phase(2, 'typed deadline returned; request snapshot restored');
    mock.timers.tick(5000);
    assert.equal(queue.activeList.some(generation => generation.id === active.id), false);
    phase(3, '5000ms grace force-released old generation');
    hang = null;
    requests.length = 0;
    const beforeNextIds = new Set(snapshot(id).messages.map(row => (row as { id: string }).id));
    const next = await post(`/api/conversations/${id}/messages`, { content: '나리, 확인 상태를 유지한 다음 턴.' });
    assert.match(next.body, /"type":"done"/);
    assert.doesNotMatch(next.body, /"type":"error"/);
    const rendered = renderAdventureState(A as never);
    assert.ok(rendered, 'confirmed A has a rendered packet');
    assert.ok(requests.some(text => text.includes(rendered)), 'next generation receives the exact confirmed A packet');
    const assistants = snapshot(id).messages.filter(row => {
      const message = row as { id: string; role: string };
      return message.role === 'assistant' && !beforeNextIds.has(message.id);
    }) as Array<{ meta_json: string }>;
    const snapshots = assistants.map(row => JSON.parse(row.meta_json).scene_state).filter(Boolean);
    assert.ok(snapshots.length > 0, 'next generation committed an assistant scene snapshot');
    for (const snap of snapshots) assert.deepEqual(snap.after_delta.adventure, A);
    assert.deepEqual(JSON.parse(load().scene_json).adventure, A);
    phase(4, `next turn done; exact A packet supplied; ${snapshots.length} assistant snapshot(s) and scene committed A`);
    const completed = snapshot(id);
    const completedLogs = logCount(id);
    old.lateToken!();
    old.release!();
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(snapshot(id), completed, 'late old tokens/result/error cannot mutate the completed turn');
    assert.equal(logCount(id), completedLogs, 'late old route must not log twice');
    phase(5, 'late token and release delivered; snapshot and generation_log count unchanged');
  } finally {
    hang = null;
    held?.release?.();
    try { await pending; }
    finally {
      mock.timers.reset();
      await isolatedApp.close();
      isolatedDb.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

async function main() {
for (const route of [characterRoutes, conversationRoutes, chatRoutes]) await app.register(route(ctx));
db.prepare(`INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, instruction_enabled) VALUES ('rp-balanced', 'test-model', 0.8, 0.95, 400, '[]', 'system', 0)`).run();
db.prepare(`INSERT INTO characters (id, name, tagline, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, tags_json, archived, created_at, updated_at, play_guide) VALUES ('c1','나리','창가','설명','성격','말투','장면','','','','["party:place=교실"]',0,?,?,'')`).run(T, T);
db.prepare(`INSERT INTO characters (id, name, tagline, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, tags_json, archived, created_at, updated_at, play_guide) VALUES ('c2','세라','교칙','설명','성격','말투','장면','','','','["party:place=교실"]',0,?,?,'')`).run(T, T);
db.prepare(`INSERT INTO stories (id, name, tagline, setting, minor_cast, archived, created_at, updated_at, scene_catalog, opening_json, stats_json, openings_extra_json, endings_json) VALUES ('s1','이야기','','WORLD','[]',0,?,?,?,?,?,?,?)`).run(T, T, '{"places":[{"id":"교실"}]}', '{}', '{}', '[]', '[]');
db.prepare(`INSERT INTO story_characters (story_id, character_id, role, sort_order) VALUES ('s1','c1','host',0), ('s1','c2','cast',1)`).run();
const sceneA = { scene_version: 1, location: '교실', present_ids: ['c1', 'c2'], adventure: adv('원A', 11) };
const sceneB = { scene_version: 9, location: '교실', present_ids: ['c1', 'c2'], adventure: adv('원B', 22) };
const snap = { schema_version: 1, before_delta: sceneA, after_delta: sceneA };
db.prepare(`INSERT INTO conversations (id, character_id, title, mode, profile_name, scene_json, head_message_id, prompt_version, favorite, archived, created_at, updated_at, story_id, story_participant_ids_snapshot) VALUES ('room','c1','r','story','rp-balanced',?,'head','2026.08.22-r1+story+compact+roster+opening',0,0,?,?, 's1', ?)`).run(JSON.stringify(sceneB), T, T, JSON.stringify(['c1', 'c2']));
db.prepare(`INSERT INTO messages (id, conversation_id, parent_id, role, content, status, meta_json, bookmarked, created_at) VALUES ('head','room',null,'assistant','나리 | 이전','complete',?,0,?)`).run(JSON.stringify({ beat_seq: 0, scene_state: snap }), T);

await t('artificial cache mismatch uses branch A, not cached B', async () => {
  seen.length = 0;
  mode = 'record';
  const res = await app.inject({ method: 'POST', url: '/api/conversations/room/messages', payload: { content: '나리, 계속' } });
  assert.ok(res.statusCode < 500, res.body.slice(0, 240));
  const blob = seen.join('\n');
  assert.equal(blob.includes('원A'), true, 'branch currency missing');
  assert.equal(blob.includes('원B'), false, 'cached other-branch currency leaked');
});

await t('deadline during model calls retracts and does not claim a post-write cut', async () => {
  const chat = fs.readFileSync(path.resolve('apps/server/src/routes/chat.ts'), 'utf8');
  const writeAt = chat.indexOf('UPDATE conversations SET scene_json');
  const callAt = chat.indexOf('ctx.model.complete');
  assert.ok(callAt > 0 && writeAt > callAt, 'scene_json write is after the first model call site');
  console.log('POST_WRITE_DEADLINE_IN_SAME_GENERATION not_reached write_after_model_calls');
  mode = 'deadline';
  const before = db.prepare('SELECT scene_json, head_message_id FROM conversations WHERE id = ?').get('room') as { scene_json: string; head_message_id: string };
  const res = await app.inject({ method: 'POST', url: '/api/conversations/room/messages', payload: { content: 'deadline' } });
  assert.ok(res.statusCode >= 400, res.body.slice(0, 200));
  const after = db.prepare('SELECT scene_json, head_message_id FROM conversations WHERE id = ?').get('room') as { scene_json: string; head_message_id: string };
  assert.equal(after.scene_json, before.scene_json);
  assert.equal(after.head_message_id, before.head_message_id);
});
await app.close();
let caseIndex = 0;
for (const format of ['beat', 'dialog'] as const) {
  for (const lateReject of [false, true]) {
    const index = caseIndex++;
    await t(`${format} late ${lateReject ? 'error' : 'tokens'}: deadline keeps A, next turn commits A, late callback changes nothing`,
      () => confirmedDeadlineCase(format, lateReject, index));
  }
}
console.log(`ok ${passed} done`);
}
main().catch((err) => { console.error(err); process.exit(1); });
