/**
 * npx tsx bench/sceneCommitOnSuccess.test.ts
 * scene-commit-on-success (ADR-F9c §2, S2) — the conversation row is the last
 * *committed* turn, not the last turn that computed a delta.
 *
 * Before this slice the applied scene was written to `conversations.scene_json`
 * *before* generation, and no failure path put it back. The clock is stalled today
 * so the residue is invisible, but `advance_minutes` would have made it "time moves
 * every time a turn is interrupted". The write was justified in a comment as letting
 * "the passes and any concurrent reader see the same world" — the passes turned out
 * to read nothing back (they get the scene through `planInput` in memory), so the
 * only real consumer was a concurrent reader and the next turn's legacy fallback.
 *
 * What is asserted here is therefore mostly *absence*: after a failed or interrupted
 * turn the row is byte-identical to what it was before the turn started.
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
  // ── harness ────────────────────────────────────────────────────────────────

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

  ins('u1', null, 'user', {});
  ins('t1s', 'u1', 'assistant', snap({ clock_minutes: 1 }, { clock_minutes: 11, scene_version: 1, last_beat: { focus_id: 'a', extra_ids: [], unresolved: [] } }));
  ins('t1e', 't1s', 'assistant', { block_kind: 'ui', beat_seq: 1, generation_id: 'g1' });
  ins('u2', 't1e', 'user', {});
  ins('t2as', 'u2', 'assistant', snap({ clock_minutes: 11, scene_version: 1 }, { clock_minutes: 21, scene_version: 2 }));
  ins('t2ae', 't2as', 'assistant', { block_kind: 'ui', beat_seq: 1, generation_id: 'g2a' });
  ins('t2bs', 'u2', 'assistant', snap({ clock_minutes: 11, scene_version: 1 }, { clock_minutes: 99, scene_version: 9 }));
  ins('t2be', 't2bs', 'assistant', { block_kind: 'ui', beat_seq: 1, generation_id: 'g2b' });
  ins('u3', 't2ae', 'user', {});

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
  let deltaGarbage = false;
  let passFail = false;
  let passCFail = false;
  let midStream: null | (() => Promise<void>) = null;
  /** Conversation scene writes, and the order of the two final writes. */
  let sceneWrites = 0;
  const writeLog: string[] = [];
  const model = {
    complete: async (p: GenParams): Promise<GenResult> => {
      completeCalls++;
      const prompt = String(p.messages?.[0]?.content ?? '');
      if (prompt.includes('장면 진행 판정기')) {
        if (deltaFail) throw new Error('delta down');
        if (deltaGarbage) return ok('이건 JSON 이 아닙니다.');
        const v = deltaStale ? versionOf(prompt) - 1 : versionOf(prompt);
        return ok(JSON.stringify({ base_version: v, advance_minutes: advance }));
      }
      if (prompt.includes('입력 초안만 쓴다')) {
        if (passCFail) throw new Error('pass C down');
        return ok('<choices>["가","나","다"]</choices>');
      }
      if (prompt.includes('너는 장면 서술자다') || prompt.includes('군중') || prompt.startsWith('당신은 카메라')) {
        return ok('서술이 이어진다.');
      }
      return ok('"교칙이야."');
    },
    stream: async (p: GenParams, onToken: (d: string) => void): Promise<GenResult> => {
      streamCalls++;
      if (passFail) throw new Error('streamed pass down');
      const prompt = String(p.messages?.[0]?.content ?? '');
      const text = prompt.includes('대본으로 쓴다')
        ? DIALOG_SCRIPT
        : prompt.includes('💬')
          ? HUNTER_SCRIPT
          : `"……짝꿍?"\n${THOUGHT_MARKER} 왜 안 피하지.`;
      for (const c of text.match(/.{1,24}/gs) ?? [text]) {
        onToken(c);
        await new Promise((r) => setImmediate(r));
        if (midStream) await midStream();
      }
      return { text, finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 3 };
    },
    listModels: async () => ['test-model'],
  };

  // The only two writes this slice cares about go through db.prepare(), so counting
  // there is cheaper and less brittle than reading the row after every step.
  const origPrepare = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    const stmt = origPrepare(sql) as { run: (...a: unknown[]) => unknown };
    if (/UPDATE conversations SET scene_json/.test(sql)) {
      const run = stmt.run.bind(stmt);
      stmt.run = (...a: unknown[]) => { sceneWrites++; writeLog.push('scene'); return run(...a); };
    } else if (/UPDATE messages SET/.test(sql)) {
      const run = stmt.run.bind(stmt);
      stmt.run = (...a: unknown[]) => {
        if (a.some((v) => typeof v === 'string' && v.includes('"scene_state"'))) writeLog.push('stamp');
        return run(...a);
      };
    }
    return stmt;
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

  // ── success: three paths ───────────────────────────────────────────────────

  for (const fmt of [undefined, 'dialog', 'hunter'] as const) {
    const label = fmt ?? 'beat';
    await t(`${label}: a successful turn commits the scene once, and only at the end`, async () => {
      advance = 10;
      const conv = await newConv(fmt);
      await send(conv, '첫 턴');
      const before = sceneOf(conv);
      const beforeJson = JSON.stringify(before);

      const calls0 = completeCalls + streamCalls;
      sceneWrites = 0;
      await send(conv, '둘째 턴');

      const after = sceneOf(conv);
      assert.notEqual(JSON.stringify(after), beforeJson, 'the successful turn did commit');
      assert.equal(sceneWrites, 1, `exactly one conversation scene write (${label})`);

      const snap = snapOf(startOf(lastTurn(await messagesOf(conv))));
      assert.ok(snap, `${label} stamped a snapshot`);
      assert.deepEqual(snap!.before_delta, before, 'before_delta is the pre-generation committed scene');
      assert.deepEqual(snap!.after_delta, after, 'after_delta equals the committed conversation scene');
      assert.ok('last_beat' in (snap!.after_delta as Record<string, unknown>)
        || 'turn_no' in (snap!.after_delta as Record<string, unknown>),
        'after_delta carries the server-owned finish fields');
      assert.ok(completeCalls + streamCalls > calls0, 'model was called');
    });
  }

  await t('the snapshot is written before the conversation row', async () => {
    // Order is a recovery property, not cosmetics: the snapshot is authoritative and
    // the row is a cache, so a crash between them must lose the cache, never the record.
    advance = 10;
    const conv = await newConv();
    await send(conv, '첫 턴');
    writeLog.length = 0;
    await send(conv, '둘째 턴');
    const stamp = writeLog.findIndex((s) => s === 'stamp');
    const commit = writeLog.findIndex((s) => s === 'scene');
    assert.ok(stamp >= 0 && commit >= 0, JSON.stringify(writeLog));
    assert.ok(stamp < commit, `stamp must precede the conversation write: ${JSON.stringify(writeLog)}`);
  });

  // ── failure and interruption ───────────────────────────────────────────────

  await t('a pass failure after a valid delta leaves the conversation scene untouched', async () => {
    advance = 10;
    const conv = await newConv();
    await send(conv, '첫 턴');
    const before = JSON.stringify(sceneOf(conv));

    sceneWrites = 0;
    passFail = true;
    const res = await fetch(`${origin}/api/conversations/${conv}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: '실패할 턴' }),
    });
    await res.text();
    passFail = false;

    assert.equal(JSON.stringify(sceneOf(conv)), before, 'scene is byte-identical to before the turn');
    assert.equal(sceneWrites, 0, 'no conversation scene write at all on the failure path');
    const turn = lastTurn(await messagesOf(conv));
    const start = turn.find((m) => m.meta.beat_seq === 0);
    if (start) assert.equal(snapOf(start), null, 'an unfinished turn carries no completed snapshot');
  });

  await t('a delta call failure and a parse failure both leave the scene untouched', async () => {
    for (const mode of ['fail', 'garbage'] as const) {
      advance = 10;
      const conv = await newConv();
      await send(conv, '첫 턴');
      const before = JSON.stringify(sceneOf(conv));
      sceneWrites = 0;
      if (mode === 'fail') deltaFail = true; else deltaGarbage = true;
      await send(conv, '둘째 턴');
      deltaFail = false; deltaGarbage = false;
      // The turn still completes (A-6 fail-open), so the scene is committed — but with
      // no delta applied, so the clock half of it is unchanged.
      assert.equal(sceneWrites, 1, `${mode}: the turn still succeeds and commits once`);
      assert.equal(sceneOf(conv).clock_minutes, JSON.parse(before).clock_minutes,
        `${mode}: no time moved`);
    }
  });

  await t('a stale base_version discards the patch and commits no time', async () => {
    advance = 10;
    const conv = await newConv();
    await send(conv, '첫 턴');
    const before = sceneOf(conv);
    deltaStale = true;
    await send(conv, '둘째 턴');
    deltaStale = false;
    assert.equal(sceneOf(conv).clock_minutes, before.clock_minutes);
    assert.equal(sceneOf(conv).scene_version, before.scene_version);
  });

  // ── Pass C fail-open keeps the turn, and therefore the commit ──────────────

  await t('Pass C failing costs the chips, not the scene commit', async () => {
    advance = 10;
    const conv = await newConv();
    await send(conv, '첫 턴');
    const before = sceneOf(conv);
    sceneWrites = 0;
    passCFail = true;
    await send(conv, '둘째 턴');
    passCFail = false;

    const turn = lastTurn(await messagesOf(conv));
    assert.equal(sceneWrites, 1, 'the turn succeeded, so the scene committed');
    assert.notEqual(sceneOf(conv).clock_minutes, before.clock_minutes, 'time moved with the turn');
    assert.ok(snapOf(startOf(turn)), 'and it is stamped');
    const withChips = turn.filter((m) => Array.isArray(m.meta.choices));
    assert.equal(withChips.length, 0, 'only the chips were lost');
  });

  // ── regenerate ─────────────────────────────────────────────────────────────

  await t('repeated regenerate still does not accumulate (598 -> 598 contract)', async () => {
    advance = 10;
    const conv = await newConv();
    await twoTurns(conv);
    const base = DEFAULT_STORY_CLOCK_MINUTES + 10 * 2;
    assert.equal(sceneOf(conv).clock_minutes, base);
    for (let i = 0; i < 3; i++) {
      const turn = lastTurn(await messagesOf(conv));
      assert.equal((await regen(conv, turn[turn.length - 1]!.id)).status, 200);
      assert.equal(sceneOf(conv).clock_minutes, base, `regen ${i + 1} did not accumulate`);
    }
  });

  await t('a failed regenerate leaves the previously committed scene in place', async () => {
    advance = 10;
    const conv = await newConv();
    await twoTurns(conv);
    const committed = JSON.stringify(sceneOf(conv));
    const turn = lastTurn(await messagesOf(conv));

    sceneWrites = 0;
    passFail = true;
    await regen(conv, turn[turn.length - 1]!.id);
    passFail = false;

    assert.equal(JSON.stringify(sceneOf(conv)), committed, 'the last good turn still owns the scene');
    assert.equal(sceneWrites, 0);
  });

  // ── legacy conversations ───────────────────────────────────────────────────

  await t('a legacy turn with no snapshot transitions on success and holds on failure', async () => {
    advance = 10;
    const conv = await newConv();
    await send(conv, '첫 턴');
    // Strip the snapshot to look like a conversation written before that slice.
    const start = startOf(lastTurn(await messagesOf(conv)));
    const meta = parseJson<MessageMeta>(
      (db.prepare('SELECT meta_json FROM messages WHERE id = ?').get(start.id) as { meta_json: string }).meta_json, {},
    );
    delete (meta as { scene_state?: unknown }).scene_state;
    db.prepare('UPDATE messages SET meta_json = ? WHERE id = ?').run(JSON.stringify(meta), start.id);
    const legacyScene = JSON.stringify(sceneOf(conv));

    // failure first: the conversation row must not move
    sceneWrites = 0;
    passFail = true;
    await send(conv, '실패');
    passFail = false;
    assert.equal(JSON.stringify(sceneOf(conv)), legacyScene, 'legacy + failure = unchanged');
    assert.equal(sceneWrites, 0);

    // then success: it picks up the snapshot contract from here on
    await send(conv, '성공');
    const newStart = startOf(lastTurn(await messagesOf(conv)));
    const snap = snapOf(newStart);
    assert.ok(snap, 'natural transition: the next completed turn is stamped');
    assert.deepEqual(snap!.before_delta, JSON.parse(legacyScene), 'it started from the conversation row');
    assert.deepEqual(snap!.after_delta, sceneOf(conv));
  });

  // ── the one observable product change ──────────────────────────────────────

  await t('a concurrent reader sees the previous committed scene until the turn lands', async () => {
    advance = 10;
    const conv = await newConv();
    await send(conv, '첫 턴');
    const before = JSON.stringify(sceneOf(conv));

    const seen: string[] = [];
    midStream = async () => {
      const r = (await api('GET', `/api/conversations/${conv}`)).json as { conversation: { scene: Scene } };
      seen.push(JSON.stringify(r.conversation.scene));
    };
    await send(conv, '둘째 턴');
    midStream = null;

    assert.ok(seen.length > 0, 'the probe ran mid-generation');
    for (const s of seen) assert.equal(s, before, 'mid-turn readers get the last committed world');
    assert.notEqual(JSON.stringify(sceneOf(conv)), before, 'and the new one only after it lands');
  });

  // ── 1:1 is untouched ───────────────────────────────────────────────────────

  await t('a 1:1 conversation neither writes a delta nor grows a snapshot', async () => {
    const solo = await char('서리', []);
    const res = await api('POST', '/api/conversations', { characterId: solo.id });
    const conv = (res.json as { id: string }).id;
    const before = JSON.stringify(sceneOf(conv));
    sceneWrites = 0;
    await send(conv, '안녕');
    assert.equal(JSON.stringify(sceneOf(conv)), before, '1:1 never touches the scene row');
    assert.equal(sceneWrites, 0);
    const assistant = (await messagesOf(conv)).filter((m) => m.role === 'assistant');
    assert.equal(assistant.length, 1);
    assert.equal(snapOf(assistant[0]!), null);
  });

  await app.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
