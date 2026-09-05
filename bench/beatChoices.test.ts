/** npx tsx bench/beatChoices.test.ts
 * beat-post-extras-choices — Pass C: the beat's choices, generated after Pass E.
 *
 * The contract this locks is an *ordering* one, and ordering is exactly what a
 * "the response had choices" assertion cannot see. A draft written inside Pass F
 * would also produce chips; it would just produce chips that cannot answer what
 * 세라 said, because 세라 had not spoken yet. So the model calls are recorded in
 * order and the Pass C prompt is inspected for the lines that were actually
 * persisted — a regression that moves the call back before Pass E fails here even
 * though the turn still ends with three chips.
 *
 * Fake model at the I/O edge only. Temp DB, never the live DB.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { openDb } from '../apps/server/src/db/index.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import { chatRoutes } from '../apps/server/src/routes/chat.js';
import { THOUGHT_MARKER } from '../apps/server/src/prompt/passes.js';
import { parseChoicesPass, renderPassC } from '../apps/server/src/prompt/beatChoices.js';
import { passCWith } from '../apps/server/src/prompt/composeBeat.js';
import { shouldReorderTurn } from '../apps/web/src/lib/chatLayout.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { GenParams, GenResult } from '../apps/server/src/model/adapter.js';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(dir, '..');
const src = (rel: string) => fs.readFileSync(path.join(appRoot, rel), 'utf8');

const CHOICES = ['*컵을 내려놓으며* 세라 씨, 그건 좀 아니지 않아요?', '*한 발 물러서며* 알겠어요. 오늘은 여기까지 하죠.', '*정면으로 보며* 그래서, 나한테 원하는 게 뭐예요?'];
const CHOICES_OUT = `<choices>${JSON.stringify(CHOICES)}</choices>`;

// ── 1. Pass C is a pure prompt + a pure parser ──────────────────────────────

async function pureTests() {
await t('renderPassC shows the turn the reader saw: narration, line, thought — never header or ui', () => {
  const prompt = renderPassC({
    userName: '유저',
    userText: '나리, 네 이야기 말인데.',
    blocks: [
      { kind: 'header', text: '[교실 · 09:38 · 맑음]' },
      { kind: 'narration', text: '황지명이 나리 옆자리에 앉았다.' },
      { kind: 'line', speaker_name: '나리', text: '"……짝꿍?"' },
      { kind: 'thought', speaker_name: '나리', text: '왜 안 피하지.' },
      { kind: 'line', speaker_name: '세라', text: '"교칙이야."' },
      { kind: 'ui', text: '{"user_sheet":{"hp":100}}' },
    ],
  });
  assert.ok(prompt.includes('황지명이 나리 옆자리에 앉았다.'));
  assert.ok(prompt.includes('나리: "……짝꿍?"'));
  assert.ok(prompt.includes('세라: "교칙이야."'));
  assert.ok(prompt.includes('나리(속마음): 왜 안 피하지.'));
  // Server state (S1) stays out, same rule as every other pass.
  assert.equal(prompt.includes('09:38'), false);
  assert.equal(prompt.includes('user_sheet'), false);
});

await t('renderPassC carries the 1:1 <choices> contract verbatim, addressed to the persona', () => {
  const prompt = renderPassC({ userName: '지명', userText: '안녕', blocks: [] });
  const instruction = src('apps/server/src/prompt/templates.ts');
  assert.ok(instruction.includes('STORY_CHOICES_INSTRUCTION'));
  assert.ok(prompt.includes('<choices>["초안 1","초안 2","초안 3"]</choices>'));
  assert.ok(prompt.includes('지명'), 'the persona name is substituted, not left as {{user}}');
  assert.equal(prompt.includes('{{user}}'), false);
});

await t('Pass C is given no character card — it cannot be talked into speaking as anyone', () => {
  const prompt = renderPassC({
    userName: '유저', userText: '안녕',
    blocks: [{ kind: 'line', speaker_name: '나리', text: '"안녕."' }],
  });
  // The card headings every other pass prints. None of them may appear here.
  for (const heading of ['### 캐릭터', '금기(절대 하지 않는 것)', '말투:', '성격:']) {
    assert.equal(prompt.includes(heading), false, heading);
  }
  assert.ok(prompt.includes('인물의 대사·행동·서술을 새로 쓰지 않는다'));
});

await t('parseChoicesPass reads the tag, trims, and caps at 3', () => {
  assert.deepEqual(parseChoicesPass(CHOICES_OUT), CHOICES);
  assert.deepEqual(
    parseChoicesPass('<choices>["  a  ","b","c","d"]</choices>'),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(parseChoicesPass(`앞선 설명\n${CHOICES_OUT}`), CHOICES);
});

await t('parseChoicesPass fails open: empty, untagged and malformed all become null', () => {
  for (const bad of ['', '   ', '초안을 못 쓰겠습니다.', '<choices>not json</choices>', '<choices>[]</choices>', '<choices>{"a":1}</choices>']) {
    assert.equal(parseChoicesPass(bad), null, JSON.stringify(bad));
  }
});

await t('passCWith builds the prompt from the serialized beat and the persona default', () => {
  const finished = {
    blocks: [{ kind: 'line', speaker_name: '나리', text: '"짝꿍?"' }],
  } as unknown as Parameters<typeof passCWith>[1];
  const input = { user_text: '앉아도 돼?' } as unknown as Parameters<typeof passCWith>[0];
  const prompt = passCWith(input, finished);
  assert.ok(prompt.includes('나리: "짝꿍?"'));
  assert.ok(prompt.includes('앉아도 돼?'));
  assert.ok(prompt.includes("'나'"), 'no persona falls back to 나, same as every other pass');
});

}

// ── 2. the shipped generateBeat pipeline ────────────────────────────────────

const CATALOG = {
  places: [{ id: '교실', name: 'S반 교실', default_focus: 'nari' }, { id: '사무실' }],
  weathers: ['맑음'],
  arcs: ['entry'],
  emotions: { '😡': 8, '🙂': 2 },
  duties: { 교칙: { slot: '질서' } },
};

type Call = { pass: string; prompt: string };

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-beat-choices-'));
  const db = openDb(tmp, path.resolve('apps/server/migrations'));
  db.prepare(
    `INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes) VALUES (?,?,?,?,?,?,?,?)`,
  ).run('rp-balanced', null, 0.8, 0.95, 400, '[]', 'system', null);

  const calls: Call[] = [];
  /** Flipped per test to drive Pass C down its failure paths. */
  let passC: 'ok' | 'throw' | 'empty' | 'prose' | 'leak' = 'ok';

  const streamChunks = ['"', '……짝꿍?', '"\n', `${THOUGHT_MARKER} `, '왜 안 피하지.'];
  const model = {
    complete: async (p: GenParams): Promise<GenResult> => {
      const prompt = String(p.messages?.[0]?.content ?? '');
      const ok = (text: string): GenResult => ({ text, finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 });
      if (prompt.includes('장면 진행 판정기')) {
        calls.push({ pass: 'delta', prompt });
        return ok('{"base_version":0}');
      }
      // Checked before Pass N: the Pass C prompt also contains the word 서술.
      if (prompt.includes('입력 초안만 쓴다')) {
        calls.push({ pass: 'c', prompt });
        if (passC === 'throw') throw new Error('pass C exploded');
        if (passC === 'empty') return ok('');
        if (passC === 'prose') return ok('초안을 쓰기 어렵습니다. 장면이 모호합니다.');
        if (passC === 'leak') return ok(`${CHOICES_OUT}\n<choices>["누수"]</choices>`);
        return ok(CHOICES_OUT);
      }
      if (prompt.includes('너는 장면 서술자다')) {
        calls.push({ pass: 'n', prompt });
        return ok('황지명이 나리 옆자리에 앉았다. 뒤에서 루나가 킥킥 웃었다.');
      }
      calls.push({ pass: 'e', prompt });
      return ok('"교칙이야."');
    },
    stream: async (p: GenParams, onToken: (d: string) => void): Promise<GenResult> => {
      calls.push({ pass: 'f', prompt: String(p.messages?.[0]?.content ?? '') });
      for (const c of streamChunks) {
        onToken(c);
        await new Promise((r) => setImmediate(r));
      }
      return {
        text: streamChunks.join(''),
        finishReason: 'stop',
        usage: { prompt_tokens: 20, completion_tokens: 10 },
        ttftMs: 1, totalMs: 3,
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

  const char = async (name: string, tags: string[]) => {
    const res = await api('POST', '/api/characters', { name, personality: `${name} 성격`, first_message: '', tags });
    assert.equal(res.status, 201, res.text);
    return res.json as { id: string; name: string };
  };

  type Msg = { role: string; content: string; meta: Record<string, unknown> };
  const messagesOf = async (convId: string): Promise<Msg[]> => {
    const detail = await api('GET', `/api/conversations/${convId}`);
    assert.equal(detail.status, 200, detail.text);
    return (detail.json as { messages: Msg[] }).messages;
  };
  const send = async (convId: string, content: string) => {
    calls.length = 0;
    const res = await fetch(`${origin}/api/conversations/${convId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }),
    });
    assert.equal(res.status, 200, `SSE 200 expected, got ${res.status}`);
    await res.text();
  };
  const assistants = (msgs: Msg[]) => msgs.filter((m) => m.role === 'assistant');
  /** The blocks of the most recent turn only: everything after the last user row. */
  const lastTurn = (msgs: Msg[]) => {
    let cut = -1;
    msgs.forEach((m, i) => { if (m.role === 'user') cut = i; });
    return msgs.slice(cut + 1).filter((m) => m.role === 'assistant');
  };
  const lastUi = (msgs: Msg[]) => {
    const a = assistants(msgs);
    return a[a.length - 1];
  };

  // A party story: focus + duty-bearing extras, so Pass E has something to run.
  const nari = await char('나리', ['party:duty=이야기', 'party:place=교실', 'party:outfit=교복']);
  const sera = await char('세라', ['party:duty=교칙', 'party:place=교실', 'party:outfit=교복']);
  const hayeon = await char('하연', ['party:duty=수업', 'party:place=교실', 'party:outfit=교복']);

  const storyRes = await api('POST', '/api/stories', {
    name: '히어로 아카데미', tagline: 'S반', setting: '교실', minor_cast: [], scene_catalog: CATALOG,
  });
  assert.equal(storyRes.status, 201, storyRes.text);
  const story = (storyRes.json as { id: string }).id;
  for (const [id, order] of [[hayeon.id, 0], [nari.id, 1], [sera.id, 2]] as const) {
    const add = await api('POST', `/api/stories/${story}/characters`, { characterId: id, sortOrder: order });
    assert.equal(add.status, 201, add.text);
  }

  const startConv = async (characterId: string, storyId: string) => {
    const res = await api('POST', '/api/conversations', { characterId, storyId, mode: 'story' });
    assert.equal(res.status, 201, res.text);
    return (res.json as { id: string }).id;
  };

  const convId = await startConv(hayeon.id, story);
  await send(convId, '첫 턴이오');   // greeting turn; the assertions below use turn 2

  await t('a beat still ends on its ui block, and that block now carries the choices', async () => {
    passC = 'ok';
    await send(convId, '나리, 네 이야기 말인데.');
    const msgs = await messagesOf(convId);
    const a = assistants(msgs);
    assert.equal(a[a.length - 1].meta.block_kind, 'ui', JSON.stringify(a.map((m) => m.meta.block_kind)));
    assert.deepEqual(lastUi(msgs).meta.choices, CHOICES);
    // and nothing else in the turn grew chips
    const withChoices = lastTurn(msgs).filter((m) => Array.isArray(m.meta.choices));
    assert.equal(withChoices.length, 1, JSON.stringify(withChoices.map((m) => m.meta.block_kind)));
  });

  await t('Pass C runs after every Pass E — narration → focus → extras → choices', async () => {
    const order = calls.map((c) => c.pass);
    assert.deepEqual(order.filter((p) => p === 'c').length, 1, JSON.stringify(order));
    assert.equal(order[order.length - 1], 'c', `choices must be the last model call: ${JSON.stringify(order)}`);
    const cAt = order.indexOf('c');
    assert.ok(order.indexOf('n') >= 0 && order.indexOf('n') < cAt, JSON.stringify(order));
    assert.ok(order.indexOf('f') >= 0 && order.indexOf('f') < cAt, JSON.stringify(order));
    for (let i = 0; i < order.length; i++) {
      if (order[i] === 'e') assert.ok(i < cAt, `a Pass E ran after Pass C: ${JSON.stringify(order)}`);
    }
    assert.ok(order.indexOf('f') < order.lastIndexOf('e') || !order.includes('e'), JSON.stringify(order));
  });

  await t('the Pass C prompt contains the focus line and every extra line that was persisted', async () => {
    const cCall = calls.find((c) => c.pass === 'c')!;
    const msgs = await messagesOf(convId);
    const turnLines = lastTurn(msgs).filter((m) => m.meta.block_kind === 'line');
    assert.ok(turnLines.length >= 1);
    for (const line of turnLines) {
      assert.ok(
        cCall.prompt.includes(String(line.content).trim()),
        `Pass C never saw ${String(line.meta.speaker_name)}: ${String(line.content)}`,
      );
      assert.ok(cCall.prompt.includes(String(line.meta.speaker_name)));
    }
    // the user's own turn is in there too, so a draft can answer it
    assert.ok(cCall.prompt.includes('나리, 네 이야기 말인데.'));
  });

  await t('a turn with no approved extras still gets choices', async () => {
    const solo = await api('POST', '/api/stories', {
      name: '독백', tagline: '', setting: '교실', minor_cast: [], scene_catalog: CATALOG,
    });
    assert.equal(solo.status, 201, solo.text);
    const soloStory = (solo.json as { id: string }).id;
    // A party cast with no duty anywhere: enough members to take the beat path,
    // nobody `approveExtras` can hand a Pass E to.
    const lone = await char('혼자', ['party:place=교실']);
    const mute1 = await char('말없음', ['party:place=교실']);
    const mute2 = await char('조용함', ['party:place=교실']);
    for (const [id, order] of [[lone.id, 0], [mute1.id, 1], [mute2.id, 2]] as const) {
      const add = await api('POST', `/api/stories/${soloStory}/characters`, { characterId: id, sortOrder: order });
      assert.equal(add.status, 201, add.text);
    }

    const soloConv = await startConv(lone.id, soloStory);
    passC = 'ok';
    await send(soloConv, '첫 턴이오');
    await send(soloConv, '혼자 있네요.');
    const order = calls.map((c) => c.pass);
    assert.equal(order.includes('e'), false, `expected no Pass E: ${JSON.stringify(order)}`);
    assert.equal(order[order.length - 1], 'c', JSON.stringify(order));
    assert.deepEqual(lastUi(await messagesOf(soloConv)).meta.choices, CHOICES);
  });

  await t('Pass C throwing costs the chips, not the turn', async () => {
    passC = 'throw';
    await send(convId, '세라 씨, 교칙 얘기 좀 해요.');
    const msgs = await messagesOf(convId);
    const a = assistants(msgs);
    const last = a[a.length - 1];
    assert.equal(last.meta.block_kind, 'ui', 'the turn still closes on ui');
    assert.equal(last.meta.choices, undefined, 'no chips');
    // the blocks the turn had already written are all still there
    const kinds = lastTurn(msgs).map((m) => m.meta.block_kind);
    assert.ok(kinds.includes('line'), JSON.stringify(kinds));
    assert.ok(kinds.includes('narration'), JSON.stringify(kinds));
    const log = db.prepare(
      `SELECT budget_json FROM generation_log WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(convId) as { budget_json: string };
    const beatLog = JSON.parse(log.budget_json).beat_log;
    assert.equal(beatLog.choices_ok, false, 'the fail-open is counted, not hidden');
    assert.equal(beatLog.choices_count, 0);
    assert.equal(typeof beatLog.pass_ms.c, 'number');
  });

  await t('empty and unparseable Pass C output both degrade to a turn with no chips', async () => {
    for (const mode of ['empty', 'prose'] as const) {
      passC = mode;
      await send(convId, `${mode} 턴이오`);
      const last = lastUi(await messagesOf(convId));
      assert.equal(last.meta.block_kind, 'ui', mode);
      assert.equal(last.meta.choices, undefined, mode);
      const log = db.prepare(
        `SELECT budget_json FROM generation_log WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      ).get(convId) as { budget_json: string };
      assert.equal(JSON.parse(log.budget_json).beat_log.choices_ok, false, mode);
    }
  });

  await t('no <choices> text ever reaches a persisted block body', async () => {
    passC = 'leak';
    await send(convId, '태그가 새는지 보자');
    const msgs = await messagesOf(convId);
    for (const m of msgs) {
      assert.equal(/<\/?choices>/.test(m.content), false, `${String(m.meta.block_kind)}: ${m.content.slice(0, 80)}`);
      assert.equal(m.content.includes('누수'), false, m.content.slice(0, 80));
    }
    // the chips themselves are the only place that payload lands
    const chips = lastUi(msgs).meta.choices as string[] | undefined;
    if (chips) for (const c of chips) assert.equal(/<\/?choices>/.test(c), false, c);
  });

  await app.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}


// ── 3. the fences: what this slice must not have moved ──────────────────────

async function fenceTests() {
await t('dialog and hunter keep their own choices path — Pass C is beat-only', () => {
  const chat = src('apps/server/src/routes/chat.ts');
  const beatAt = chat.indexOf('async function generateBeat');
  const dialogAt = chat.indexOf('async function generateDialog');
  assert.ok(beatAt > 0 && dialogAt > beatAt);
  const beat = chat.slice(beatAt, dialogAt);
  const afterBeat = chat.slice(dialogAt);
  assert.ok(beat.includes('passCWith('), 'beat generates its own choices');
  assert.ok(beat.includes('parseChoicesPass('));
  assert.equal(afterBeat.includes('passCWith('), false, 'dialog/hunter must not gain a second choices call');
  assert.equal(afterBeat.includes('parseChoicesPass('), false);
  // dialog and hunter still parse choices out of their own single script call
  assert.ok(src('apps/server/src/prompt/composeDialog.ts').includes('extractChoices('));
  assert.ok(src('apps/server/src/prompt/composeHunter.ts').includes('extractChoices('));
  assert.equal(src('apps/server/src/prompt/composeDialog.ts').includes('renderPassC'), false);
  assert.equal(src('apps/server/src/prompt/composeHunter.ts').includes('renderPassC'), false);
  // Pass C reuses 1:1 prompt text, so it lives outside passes.ts — which stays the
  // import-free string builder passPrompts.test.ts fences. (That bench owns the
  // rest of the fence; this only pins *why* Pass C is not in there.)
  const passes = src('apps/server/src/prompt/passes.ts');
  assert.deepEqual((passes.match(/^import .*$/gm) ?? []).filter((l) => !l.startsWith('import type')), []);
  assert.equal(passes.includes('renderPassC'), false, 'the renderer is in beatChoices.ts');
  assert.ok(src('apps/server/src/prompt/beatChoices.ts').includes('STORY_CHOICES_INSTRUCTION'));
});

await t('a stop during Pass C costs the chips, not the finished beat', () => {
  const chat = src('apps/server/src/routes/chat.ts');
  const beat = chat.slice(chat.indexOf('async function generateBeat'), chat.indexOf('async function generateDialog'));
  const cAt = beat.indexOf('passCWith(');
  const cCatch = beat.slice(cAt, beat.indexOf('passMs.c ='));
  // Pass N and Pass E rethrow on abort because their turn is still being written.
  // Pass C must not: by then every block is persisted, and the shared catch would
  // rewind the focus row to Pass F's raw buffer and mark the beat 'interrupted'.
  assert.ok(cCatch.includes('catch (err)'));
  assert.equal(/if \(controller\.signal\.aborted\) throw err;/.test(cCatch), false);
  assert.ok(cCatch.includes('req.log.warn('));
  // the passes that do rethrow still do
  const passN = beat.slice(beat.indexOf('const nDeadline'), beat.indexOf('passMs.n ='));
  assert.ok(/if \(controller\.signal\.aborted\) throw err;/.test(passN));
});

await t('an absent scene.format is still beat, and still the path Pass C runs in', () => {
  const types = src('apps/server/src/types.ts');
  assert.ok(types.includes("Absent means `'beat'`"));
  assert.ok(types.includes("format?: 'beat' | 'dialog' | 'hunter';"));
  const chat = src('apps/server/src/routes/chat.ts');
  const router = chat.slice(chat.indexOf('const fmt ='), chat.indexOf('async function generateBeat'));
  assert.ok(/if \(fmt === 'dialog'\)/.test(router));
  assert.ok(/if \(fmt === 'hunter'\)/.test(router));
  // no `fmt === 'beat'` guard: beat is the fallthrough, which is what makes absent mean beat
  assert.equal(/fmt === 'beat'/.test(router), false);
  assert.ok(/return generateBeat\(/.test(router));
});

await t('the web renders these chips with no change: flat path, last assistant, non-line block', () => {
  // beat is not reordered, so every message goes through the plain map and keeps
  // its own chips — the turn-host path is dialog/hunter only.
  assert.equal(shouldReorderTurn('beat'), false);
  assert.equal(shouldReorderTurn(undefined), false);
  const page = src('apps/web/src/pages/ChatPage.tsx');
  const branch = page.slice(page.indexOf("const kind = m.meta.block_kind;"), page.indexOf("if (!isUser && kind === 'line' && props.sceneFormat === 'hunter')"));
  assert.ok(branch.includes("kind !== 'line'"), 'the ui block goes through this branch');
  assert.ok(branch.includes('props.isLastAssistant && m.meta.choices'), 'and it already renders chips');
  assert.ok(branch.includes('<ChoiceChips'));
  // the web is a reader here: it neither generates nor writes a format
  assert.equal(/passCWith|parseChoicesPass|renderPassC/.test(page), false);
});

}

async function run() {
  await pureTests();
  await main();
  await fenceTests();
  console.log(`\n${passed} passed`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
