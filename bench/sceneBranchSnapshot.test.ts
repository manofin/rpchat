/**
 * npx tsx bench/sceneBranchSnapshot.test.ts
 * scene-branch-snapshot — a generation plans against the branch, not the row.
 *
 * `conversations.scene_json` is one value per conversation. Messages are a tree.
 * Regenerating a turn used to read the abandoned delta back out of that row and
 * apply another one on top: three regenerations of the same logical turn moved
 * the clock 598 → 628 and `scene_version` 2 → 5. The snapshots on each turn's
 * first block are what stop that, and what stop a swipe from planning against
 * the sibling the user just left.
 *
 * Fake model at the I/O edge only. Temp DB, never the live DB.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openDb, parseJson } from '../apps/server/src/db/index.js';
import {
  SCENE_SNAPSHOT_VERSION,
  buildSceneSnapshot,
  readSceneSnapshot,
  resolveSceneBase,
} from '../apps/server/src/db/sceneBase.js';
import { getPath } from '../apps/server/src/db/tree.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import { chatRoutes } from '../apps/server/src/routes/chat.js';
import { DEFAULT_STORY_CLOCK_MINUTES } from '../apps/server/src/prompt/initScene.js';
import { THOUGHT_MARKER } from '../apps/server/src/prompt/passes.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { ConversationRow, MessageMeta, MessageRow, Scene } from '../apps/server/src/types.js';
import type { GenParams, GenResult } from '../apps/server/src/model/adapter.js';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const CATALOG = {
  places: [{ id: '교실', name: 'S반 교실', default_focus: 'nari' }],
  weathers: ['맑음'],
  arcs: ['entry'],
  duties: { 교칙: { slot: '질서' } },
};

const DIALOG_SCRIPT = '나리 | "대사입니다."\n<choices>["가","나","다"]</choices>';
const HUNTER_SCRIPT = [
  '『교실이 조용하다.』',
  '💬 나리│"대사입니다."',
  '<상태>',
  '모드: ⚔️',
  '상황: 수업 전',
  '</상태>',
  '<choices>["가","나","다"]</choices>',
].join('\n');

function ok(text: string): GenResult {
  return { text, finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 };
}

function versionOf(prompt: string): number {
  const m = prompt.match(/\{"base_version": (\d+)\}/);
  return m ? Number(m[1]) : 0;
}

async function main() {
  // ── pure snapshot helpers ──────────────────────────────────────────────────

  await t('buildSceneSnapshot deep-copies so later mutation cannot rewrite the record', () => {
    const before: Scene = { clock_minutes: 578, scene_version: 0 };
    const after: Scene = { clock_minutes: 588, scene_version: 1 };
    const snap = buildSceneSnapshot(before, after);
    assert.equal(snap.schema_version, SCENE_SNAPSHOT_VERSION);
    before.clock_minutes = 999;
    after.clock_minutes = 0;
    after.last_beat = { focus_id: 'x', extra_ids: [], unresolved: [] };
    assert.equal(snap.before_delta.clock_minutes, 578);
    assert.equal(snap.after_delta.clock_minutes, 588);
    assert.equal(snap.after_delta.last_beat, undefined);
  });

  await t('readSceneSnapshot accepts only this schema and both halves', () => {
    const good = buildSceneSnapshot({ clock_minutes: 1 }, { clock_minutes: 2 });
    assert.deepEqual(readSceneSnapshot({ scene_state: good }), good);
    const cases: unknown[] = [
      undefined,
      {},
      { schema_version: 1 },
      { schema_version: 99, before_delta: {}, after_delta: {} },
      { schema_version: 1, before_delta: { clock_minutes: 1 } },
      { schema_version: 1, after_delta: { clock_minutes: 1 } },
      { schema_version: 1, before_delta: [], after_delta: {} },
      { schema_version: 1, before_delta: {}, after_delta: 'x' },
      { schema_version: 1, before_delta: null, after_delta: {} },
      [],
      'x',
      null,
    ];
    for (const raw of cases) {
      assert.equal(readSceneSnapshot({ scene_state: raw as MessageMeta['scene_state'] }), null, JSON.stringify(raw));
    }
  });

  // ── resolveSceneBase against a hand-built tree ─────────────────────────────

  const unitTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-scene-base-'));
  const unitDb = openDb(unitTmp, path.resolve('apps/server/migrations'));
  const now = '2026-09-06T12:00:00.000Z';
  unitDb.exec(`
    INSERT INTO characters (id, name, tagline, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, tags_json, created_at, updated_at)
    VALUES ('c1','캐','','','','','','','','','[]','${now}','${now}');
    INSERT INTO conversations (id, character_id, title, mode, profile_name, scene_json, prompt_version, created_at, updated_at)
    VALUES ('conv1','c1','','story','rp-balanced','{"clock_minutes":1}','pv','${now}','${now}');
  `);
  const ins = (id: string, parent: string | null, role: 'user' | 'assistant', meta: object) => {
    unitDb.prepare(
      `INSERT INTO messages (id, conversation_id, parent_id, role, content, status, meta_json, bookmarked, created_at)
       VALUES (?,?,?,?,?,?,?,0,?)`,
    ).run(id, 'conv1', parent, role, 'x', 'complete', JSON.stringify(meta), now);
  };
  const snap = (before: Scene, after: Scene) => ({
    block_kind: 'header', beat_seq: 0, generation_id: 'g',
    scene_state: buildSceneSnapshot(before, after),
  });
  const convScene: Scene = { clock_minutes: 1 };

  await t('first turn with no ancestor falls back to the conversation row', () => {
    const r = resolveSceneBase(unitDb, { conversationScene: convScene, parentId: null });
    assert.equal(r.source, 'conversation');
    assert.equal(r.scene.clock_minutes, 1);
    assert.equal(r.hops, 0);
  });

  ins('u1', null, 'user', {});
  ins('t1s', 'u1', 'assistant', snap({ clock_minutes: 1 }, { clock_minutes: 11, scene_version: 1, last_beat: { focus_id: 'a', extra_ids: [], unresolved: [] } }));
  ins('t1e', 't1s', 'assistant', { block_kind: 'ui', beat_seq: 1, generation_id: 'g1' });
  ins('u2', 't1e', 'user', {});
  ins('t2as', 'u2', 'assistant', snap({ clock_minutes: 11, scene_version: 1 }, { clock_minutes: 21, scene_version: 2 }));
  ins('t2ae', 't2as', 'assistant', { block_kind: 'ui', beat_seq: 1, generation_id: 'g2a' });
  ins('t2bs', 'u2', 'assistant', snap({ clock_minutes: 11, scene_version: 1 }, { clock_minutes: 99, scene_version: 9 }));
  ins('t2be', 't2bs', 'assistant', { block_kind: 'ui', beat_seq: 1, generation_id: 'g2b' });
  ins('u3', 't2ae', 'user', {});

  await t('a normal turn reads after_delta of the previous start on this branch', () => {
    const r = resolveSceneBase(unitDb, { conversationScene: convScene, parentId: 'u2' });
    assert.equal(r.source, 'prev_after');
    assert.equal(r.scene.clock_minutes, 11);
    assert.equal(r.scene.scene_version, 1);
    assert.equal(r.scene.last_beat?.focus_id, 'a');
    assert.ok(r.hops >= 2);
  });

  await t('a regenerate reads before_delta of the target start, not the conversation', () => {
    const r = resolveSceneBase(unitDb, {
      conversationScene: { clock_minutes: 99 },
      parentId: 'u2',
      regenTurnStartId: 't2as',
    });
    assert.equal(r.source, 'regen_before');
    assert.equal(r.scene.clock_minutes, 11);
    assert.equal(r.hops, 1);
  });

  await t('a sibling with a newer snapshot is ignored when it is not an ancestor', () => {
    const r = resolveSceneBase(unitDb, { conversationScene: convScene, parentId: 'u3' });
    assert.equal(r.source, 'prev_after');
    assert.equal(r.scene.clock_minutes, 21, 't2a after_delta, not t2b clock 99');
    assert.equal(r.scene.scene_version, 2);
  });

  await t('a missing snapshot on the nearest start falls back rather than skipping it', () => {
    ins('legacy-s', 'u3', 'assistant', { block_kind: 'header', beat_seq: 0, generation_id: 'gL' });
    ins('legacy-e', 'legacy-s', 'assistant', { block_kind: 'ui', beat_seq: 1, generation_id: 'gL' });
    ins('u4', 'legacy-e', 'user', {});
    const r = resolveSceneBase(unitDb, { conversationScene: { clock_minutes: 7 }, parentId: 'u4' });
    assert.equal(r.source, 'conversation');
    assert.equal(r.scene.clock_minutes, 7);
  });

  await t('malformed and unknown-version snapshots fall back', () => {
    const cases: object[] = [
      { block_kind: 'header', beat_seq: 0, scene_state: { schema_version: 1 } },
      { block_kind: 'header', beat_seq: 0, scene_state: { schema_version: 9, before_delta: {}, after_delta: {} } },
      { block_kind: 'header', beat_seq: 0, scene_state: { schema_version: 1, before_delta: {}, after_delta: null } },
      { block_kind: 'header', beat_seq: 0, scene_state: [] },
      { block_kind: 'header', beat_seq: 0, scene_state: 'x' },
    ];
    for (const [i, meta] of cases.entries()) {
      const id = `bad-${i}`;
      ins(id, null, 'assistant', meta);
      const r = resolveSceneBase(unitDb, {
        conversationScene: { clock_minutes: 3 },
        parentId: null,
        regenTurnStartId: id,
      });
      assert.equal(r.source, 'conversation', JSON.stringify(meta));
    }
  });

  await t('a cycle in the ancestor walk falls back instead of looping', () => {
    ins('cyc-a', null, 'assistant', { block_kind: 'line', beat_seq: 2, generation_id: 'gc' });
    ins('cyc-b', 'cyc-a', 'assistant', { block_kind: 'line', beat_seq: 3, generation_id: 'gc' });
    unitDb.prepare('UPDATE messages SET parent_id = ? WHERE id = ?').run('cyc-b', 'cyc-a');
    const r = resolveSceneBase(unitDb, { conversationScene: convScene, parentId: 'cyc-a' });
    assert.equal(r.source, 'conversation');
  });

  unitDb.close();
  fs.rmSync(unitTmp, { recursive: true, force: true });

  // ── HTTP: beat / dialog / hunter / 1:1 ─────────────────────────────────────

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-scene-snap-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));
  db.prepare(
    `INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes) VALUES (?,?,?,?,?,?,?,?)`,
  ).run('rp-balanced', null, 0.8, 0.95, 400, '[]', 'system', null);

  let advance = 10;
  let completeCalls = 0;
  let streamCalls = 0;
  let deltaFail = false;
  let deltaStale = false;
  const model = {
    complete: async (p: GenParams): Promise<GenResult> => {
      completeCalls++;
      const prompt = String(p.messages?.[0]?.content ?? '');
      if (prompt.includes('장면 진행 판정기')) {
        if (deltaFail) throw new Error('delta down');
        const v = deltaStale ? versionOf(prompt) - 1 : versionOf(prompt);
        return ok(JSON.stringify({ base_version: v, advance_minutes: advance }));
      }
      if (prompt.includes('입력 초안만 쓴다')) return ok('<choices>["가","나","다"]</choices>');
      if (prompt.includes('너는 장면 서술자다') || prompt.includes('군중') || prompt.startsWith('당신은 카메라')) {
        return ok('서술이 이어진다.');
      }
      return ok('"교칙이야."');
    },
    stream: async (p: GenParams, onToken: (d: string) => void): Promise<GenResult> => {
      streamCalls++;
      const prompt = String(p.messages?.[0]?.content ?? '');
      const text = prompt.includes('대본으로 쓴다')
        ? DIALOG_SCRIPT
        : prompt.includes('💬')
          ? HUNTER_SCRIPT
          : `"……짝꿍?"\n${THOUGHT_MARKER} 왜 안 피하지.`;
      for (const c of text.match(/.{1,24}/gs) ?? [text]) {
        onToken(c);
        await new Promise((r) => setImmediate(r));
      }
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
  type Msg = { id: string; role: string; content: string; meta: Record<string, unknown> };
  const messagesOf = async (convId: string): Promise<Msg[]> =>
    ((await api('GET', `/api/conversations/${convId}`)).json as { messages: Msg[] }).messages;
  const send = async (convId: string, content: string) => {
    const res = await fetch(`${origin}/api/conversations/${convId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }),
    });
    assert.equal(res.status, 200, await res.text());
  };
  const regen = async (convId: string, messageId: string) => {
    const res = await fetch(`${origin}/api/conversations/${convId}/regenerate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messageId }),
    });
    return { status: res.status, body: await res.text() };
  };
  const lastTurn = (msgs: Msg[]) => {
    let cut = -1;
    msgs.forEach((m, i) => { if (m.role === 'user') cut = i; });
    return msgs.slice(cut + 1).filter((m) => m.role === 'assistant');
  };
  const startOf = (turn: Msg[]) => {
    const row = turn.find((m) => m.meta.beat_seq === 0);
    assert.ok(row, 'turn has a beat_seq 0 start');
    return row!;
  };
  const sceneOf = (convId: string): Scene => {
    const row = db.prepare('SELECT scene_json FROM conversations WHERE id = ?').get(convId) as { scene_json: string };
    return JSON.parse(row.scene_json) as Scene;
  };
  const snapOf = (msg: Msg) => readSceneSnapshot(msg.meta as MessageMeta);
  const char = async (name: string, tags: string[]) => {
    const res = await api('POST', '/api/characters', { name, personality: `${name} 성격`, first_message: '', tags });
    assert.equal(res.status, 201, res.text);
    return res.json as { id: string };
  };

  const nari = await char('나리', ['party:duty=이야기', 'party:place=교실']);
  const sera = await char('세라', ['party:duty=교칙', 'party:place=교실']);
  const hayeon = await char('하연', ['party:duty=수업', 'party:place=교실']);
  const storyRes = await api('POST', '/api/stories', {
    name: '히어로 아카데미', tagline: 'S반', setting: '교실', minor_cast: [], scene_catalog: CATALOG,
  });
  const story = (storyRes.json as { id: string }).id;
  for (const [id, order] of [[hayeon.id, 0], [nari.id, 1], [sera.id, 2]] as const) {
    await api('POST', `/api/stories/${story}/characters`, { characterId: id, sortOrder: order });
  }
  const newConv = async (fmt?: 'dialog' | 'hunter') => {
    const res = await api('POST', '/api/conversations', { characterId: hayeon.id, storyId: story, mode: 'story' });
    const id = (res.json as { id: string }).id;
    if (fmt) await api('PATCH', `/api/conversations/${id}`, { scene: { format: fmt } });
    return id;
  };

  const twoTurns = async (conv: string) => {
    await send(conv, '첫 턴');
    await send(conv, '둘째 턴');
  };

  // ── normal progress ────────────────────────────────────────────────────────

  await t('the first beat turn plans against the conversation scene and stamps both halves', async () => {
    const conv = await newConv();
    const initial = sceneOf(conv);
    assert.equal(initial.clock_minutes, DEFAULT_STORY_CLOCK_MINUTES);
    await send(conv, '첫 턴');
    const turn = lastTurn(await messagesOf(conv));
    const snap1 = snapOf(startOf(turn));
    assert.ok(snap1);
    assert.equal(snap1!.before_delta.clock_minutes, DEFAULT_STORY_CLOCK_MINUTES);
    assert.equal(snap1!.after_delta.clock_minutes, DEFAULT_STORY_CLOCK_MINUTES + 10);
    assert.equal(snap1!.after_delta.scene_version, 1);
    assert.ok(snap1!.after_delta.last_beat, 'finishBeat last_beat is in after_delta');
    assert.equal(sceneOf(conv).clock_minutes, DEFAULT_STORY_CLOCK_MINUTES + 10);
    for (const m of turn.slice(1)) {
      assert.equal(m.meta.scene_state, undefined, `${m.meta.block_kind} must not carry the snapshot`);
    }
  });

  await t('a follow-up turn starts from the previous after_delta, not a stale conversation row', async () => {
    const conv = await newConv();
    await twoTurns(conv);
    const msgs = await messagesOf(conv);
    const turns: Msg[][] = [];
    let buf: Msg[] = [];
    for (const m of msgs) {
      if (m.role === 'user') {
        if (buf.length) turns.push(buf);
        buf = [];
      } else buf.push(m);
    }
    if (buf.length) turns.push(buf);
    assert.equal(turns.length, 2);
    const s1 = snapOf(startOf(turns[0]!))!;
    const s2 = snapOf(startOf(turns[1]!))!;
    assert.equal(s2.before_delta.clock_minutes, s1.after_delta.clock_minutes);
    assert.equal(s2.before_delta.scene_version, s1.after_delta.scene_version);
    assert.deepEqual(s2.before_delta.last_beat, s1.after_delta.last_beat);
    assert.equal(s2.after_delta.clock_minutes, DEFAULT_STORY_CLOCK_MINUTES + 20);
    assert.equal(s2.after_delta.scene_version, 2);
    assert.equal(sceneOf(conv).clock_minutes, 598);
    assert.equal(sceneOf(conv).scene_version, 2);
  });

  await t('a stored snapshot is not mutated by a later turn', async () => {
    const conv = await newConv();
    await send(conv, '첫 턴');
    const firstId = startOf(lastTurn(await messagesOf(conv))).id;
    const before = db.prepare('SELECT meta_json FROM messages WHERE id = ?').get(firstId) as { meta_json: string };
    await send(conv, '둘째 턴');
    const after = db.prepare('SELECT meta_json FROM messages WHERE id = ?').get(firstId) as { meta_json: string };
    assert.equal(after.meta_json, before.meta_json);
  });

  // ── regenerate: the measured 598 → 628 bug ─────────────────────────────────

  await t('repeating regenerate of the same logical turn does not accumulate the delta', async () => {
    const conv = await newConv();
    await twoTurns(conv);
    assert.equal(sceneOf(conv).clock_minutes, 598);
    assert.equal(sceneOf(conv).scene_version, 2);
    const originalStart = startOf(lastTurn(await messagesOf(conv)));
    const originalBefore = snapOf(originalStart)!.before_delta;

    for (let i = 1; i <= 3; i++) {
      const turn = lastTurn(await messagesOf(conv));
      const res = await regen(conv, turn[turn.length - 1]!.id);
      assert.equal(res.status, 200, res.body);
      const scene = sceneOf(conv);
      assert.equal(scene.clock_minutes, 598, `regen ${i} clock`);
      assert.equal(scene.scene_version, 2, `regen ${i} version`);
      const sib = snapOf(startOf(lastTurn(await messagesOf(conv))))!;
      assert.equal(sib.before_delta.clock_minutes, originalBefore.clock_minutes);
      assert.equal(sib.before_delta.scene_version, originalBefore.scene_version);
      assert.equal(sib.after_delta.clock_minutes, 598);
    }
    const starts = db.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND json_extract(meta_json,'$.beat_seq') = 0`,
    ).get(conv) as { n: number };
    assert.equal(starts.n, 5, 'turn 1 + original turn 2 + 3 regenerations');
    const onPath = lastTurn(await messagesOf(conv));
    assert.equal(onPath.filter((m) => m.meta.beat_seq === 0).length, 1);
  });

  await t('a regen whose delta differs from the original replaces, it does not add', async () => {
    const conv = await newConv();
    advance = 10;
    await twoTurns(conv);
    const original = lastTurn(await messagesOf(conv));
    const before = snapOf(startOf(original))!.before_delta;
    advance = 20;
    const res = await regen(conv, original[original.length - 1]!.id);
    assert.equal(res.status, 200, res.body);
    advance = 10;
    const scene = sceneOf(conv);
    assert.equal(scene.clock_minutes, before.clock_minutes! + 20);
    assert.notEqual(scene.clock_minutes, before.clock_minutes! + 10 + 20);
    assert.equal(scene.clock_minutes, 608);
    const abandoned = db.prepare('SELECT id FROM messages WHERE id = ?').get(original[0]!.id);
    assert.ok(abandoned, 'original sibling is kept');
    const onPath = new Set((await messagesOf(conv)).map((m) => m.id));
    assert.equal(onPath.has(original[0]!.id), false);
  });

  await t('swiping back to an abandoned sibling continues from that sibling, not the conversation cache', async () => {
    const conv = await newConv();
    advance = 10;
    await twoTurns(conv);
    const originalTurn2 = lastTurn(await messagesOf(conv));
    advance = 20;
    assert.equal((await regen(conv, originalTurn2[originalTurn2.length - 1]!.id)).status, 200);
    assert.equal(sceneOf(conv).clock_minutes, 608, 'conversation cache now holds the +20 sibling');
    const sel = await api('POST', `/api/messages/${originalTurn2[0]!.id}/select`);
    assert.equal(sel.status, 200, sel.text);
    advance = 10;
    await send(conv, '셋째 턴 from abandoned');
    const scene = sceneOf(conv);
    assert.equal(scene.clock_minutes, 608, '598+10 from the abandoned sibling, not 608+10 from the cache');
    assert.equal(scene.scene_version, 3);
    const path = getPath(db, db.prepare('SELECT * FROM conversations WHERE id = ?').get(conv) as ConversationRow);
    const starts = path.filter((m) => parseJson<MessageMeta>(m.meta_json, {}).beat_seq === 0);
    assert.equal(starts.length, 3, 'turn 1 + abandoned turn 2 + turn 3');
  });

  await t('getPath after repeated regen returns only the new active turn', async () => {
    const conv = await newConv();
    await twoTurns(conv);
    for (let i = 0; i < 2; i++) {
      const turn = lastTurn(await messagesOf(conv));
      assert.equal((await regen(conv, turn[0]!.id)).status, 200);
    }
    const convRow = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conv) as ConversationRow;
    const path = getPath(db, convRow);
    const kinds = path.filter((m) => m.role === 'assistant').map((m) => parseJson<MessageMeta>(m.meta_json, {}).block_kind);
    const seq0 = path.filter((m) => parseJson<MessageMeta>(m.meta_json, {}).beat_seq === 0);
    assert.equal(seq0.length, 2, 'turn 1 + latest turn 2');
    assert.ok(kinds.includes('header'));
  });

  // ── dialog + hunter ────────────────────────────────────────────────────────

  for (const fmt of ['dialog', 'hunter'] as const) {
    await t(`${fmt} stamps a snapshot and regenerate does not accumulate`, async () => {
      const conv = await newConv(fmt);
      await twoTurns(conv);
      const afterTwo = sceneOf(conv);
      assert.equal(afterTwo.clock_minutes, 598, `${fmt} two-turn clock`);
      assert.equal(afterTwo.scene_version, 2);
      const start = startOf(lastTurn(await messagesOf(conv)));
      assert.ok(snapOf(start), `${fmt} start has scene_state`);
      for (let i = 0; i < 2; i++) {
        const turn = lastTurn(await messagesOf(conv));
        assert.equal((await regen(conv, turn[turn.length - 1]!.id)).status, 200);
        assert.equal(sceneOf(conv).clock_minutes, 598, `${fmt} regen ${i + 1}`);
        assert.equal(sceneOf(conv).scene_version, 2);
      }
    });
  }

  // ── 1:1 is untouched ───────────────────────────────────────────────────────

  await t('a 1:1 turn does not grow a scene snapshot and still regenerates as one row', async () => {
    const solo = await char('서리', []);
    const res = await api('POST', '/api/conversations', { characterId: solo.id });
    const conv = (res.json as { id: string }).id;
    await send(conv, '안녕');
    const assistant = (await messagesOf(conv)).filter((m) => m.role === 'assistant');
    assert.equal(assistant.length, 1);
    assert.equal(assistant[0]!.meta.block_kind, undefined);
    assert.equal(assistant[0]!.meta.scene_state, undefined);
    assert.equal((await regen(conv, assistant[0]!.id)).status, 200);
    const after = (await messagesOf(conv)).filter((m) => m.role === 'assistant');
    assert.equal(after.length, 1);
    assert.equal(after[0]!.meta.scene_state, undefined);
  });

  // ── legacy + existing failure paths ────────────────────────────────────────

  await t('a legacy multi-row turn without a snapshot still generates (conversation fallback)', async () => {
    const conv = await newConv();
    await send(conv, '첫 턴');
    const startId = startOf(lastTurn(await messagesOf(conv))).id;
    const row = db.prepare('SELECT meta_json FROM messages WHERE id = ?').get(startId) as { meta_json: string };
    const meta = JSON.parse(row.meta_json) as Record<string, unknown>;
    delete meta.scene_state;
    db.prepare('UPDATE messages SET meta_json = ? WHERE id = ?').run(JSON.stringify(meta), startId);
    await send(conv, '둘째 턴 — fallback');
    assert.equal(sceneOf(conv).clock_minutes, DEFAULT_STORY_CLOCK_MINUTES + 20);
    assert.ok(snapOf(startOf(lastTurn(await messagesOf(conv)))));
  });

  await t('delta proposal failure leaves the scene untouched and the turn still completes', async () => {
    const conv = await newConv();
    deltaFail = true;
    await send(conv, 'delta down');
    deltaFail = false;
    assert.equal(sceneOf(conv).clock_minutes, DEFAULT_STORY_CLOCK_MINUTES);
    const snap1 = snapOf(startOf(lastTurn(await messagesOf(conv))));
    assert.ok(snap1);
    assert.equal(snap1!.before_delta.clock_minutes, snap1!.after_delta.clock_minutes);
  });

  await t('a stale base_version discards the patch the same way as before', async () => {
    const conv = await newConv();
    await send(conv, '첫 턴');
    deltaStale = true;
    await send(conv, 'stale');
    deltaStale = false;
    assert.equal(sceneOf(conv).clock_minutes, DEFAULT_STORY_CLOCK_MINUTES + 10);
    assert.equal(sceneOf(conv).scene_version, 1);
  });

  await t('concurrent generation is still 409', async () => {
    const conv = await newConv();
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    let holding = false;
    const orig = model.complete;
    model.complete = async (p: GenParams) => {
      const prompt = String(p.messages?.[0]?.content ?? '');
      // register() happens after the delta call, so holding there never 409s.
      // Pass N is the first complete() after the generation is on activeList.
      if (prompt.includes('너는 장면 서술자다') || prompt.includes('군중') || prompt.startsWith('당신은 카메라')) {
        holding = true;
        await held;
      }
      return orig(p);
    };
    const first = fetch(`${origin}/api/conversations/${conv}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'hold' }),
    });
    for (let i = 0; i < 50 && !holding; i++) await new Promise((r) => setImmediate(r));
    const second = await api('POST', `/api/conversations/${conv}/messages`, { content: 'nope' });
    assert.equal(second.status, 409);
    release();
    assert.equal((await first).status, 200);
    model.complete = orig;
  });

  await t('an unresolved regenerate target is still 409', async () => {
    const conv = await newConv();
    await send(conv, '첫 턴');
    const orphanId = 'orphan-block';
    db.prepare(
      `INSERT INTO messages (id, conversation_id, parent_id, role, content, status, meta_json, bookmarked, created_at)
       VALUES (?,?,?,?,?,?,?,0,?)`,
    ).run(orphanId, conv, null, 'assistant', 'x', 'complete',
      JSON.stringify({ block_kind: 'ui', beat_seq: 4, generation_id: 'g-orphan' }), new Date().toISOString());
    const res = await regen(conv, orphanId);
    assert.equal(res.status, 409);
  });

  await t('model call count per beat turn does not grow a fifth call for the snapshot', async () => {
    completeCalls = 0;
    streamCalls = 0;
    const conv = await newConv();
    await send(conv, 'count');
    // delta + Pass N + Pass C (+ extras none) completes; Pass F streams.
    assert.equal(streamCalls, 1);
    assert.ok(completeCalls >= 2 && completeCalls <= 4, `completeCalls=${completeCalls}`);
  });

  const sampleStart = db.prepare(
    `SELECT length(meta_json) AS n FROM messages WHERE json_extract(meta_json,'$.scene_state') IS NOT NULL LIMIT 1`,
  ).get() as { n: number } | undefined;
  const sampleBare = db.prepare(
    `SELECT length(meta_json) AS n FROM messages WHERE json_extract(meta_json,'$.block_kind') = 'narration' LIMIT 1`,
  ).get() as { n: number } | undefined;
  console.log(`perf header_meta_bytes=${sampleStart?.n ?? 'n/a'} narration_meta_bytes=${sampleBare?.n ?? 'n/a'} extra_writes_per_turn=1 (finish stamp)`);

  await app.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
