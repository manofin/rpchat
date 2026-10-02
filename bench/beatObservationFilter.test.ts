/** Fixed synthetic counterexamples on the shipped beat route. Temp DB, mock adapter only.
 * This protects explicit thought syntax, not whisper recipients or arbitrary action semantics.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { chatRoutes } from '../apps/server/src/routes/chat.js';
import { THOUGHT_MARKER } from '../apps/server/src/prompt/passes.js';
import { passCWith, planBeat, planPassE, type BeatPlanInput } from '../apps/server/src/prompt/composeBeat.js';
import { catalogFromStory } from '../apps/server/src/prompt/sceneCatalog.js';
import { insertMessage, setHead } from '../apps/server/src/db/tree.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { GenParams } from '../apps/server/src/model/adapter.js';

const SECRET = '청록오소리7319';
const PUBLIC = 'PUBLIC_DOOR_IS_CLOSED';
const LINE = '"PUBLIC_USE_LEFT_HAND"';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-observation-'));
const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
type Call = { pass: string; p: GenParams; text: string };
const calls: Call[] = [];
let focusOutput = `${LINE}\n${THOUGHT_MARKER} ${SECRET}`;
let narrationOutput = `${PUBLIC}.<think>${SECRET}</think>`;
const result = (text: string) => ({ text, usage: null, finishReason: 'stop', ttftMs: 1, totalMs: 1 });
const textOf = (p: GenParams) => p.messages.map(m => m.content).join('\n');
const model = {
  complete: async (p: GenParams) => {
    const text = textOf(p);
    const pass = text.includes('장면 진행 판정기') ? 'delta' : text.includes('입력 초안만 쓴다') ? 'c' : text.includes('너는 장면 서술자다') ? 'n' : 'e';
    calls.push({ pass, p, text });
    if (pass === 'delta') return result('null');
    if (pass === 'n') return result(narrationOutput);
    if (pass === 'c') return result(`<choices>["${text.includes(SECRET) ? SECRET : 'PUBLIC_REPLY'}"]</choices>`);
    return result(text.includes(SECRET) ? `"SECRET_REINTRODUCTION_${SECRET}"` : '"PUBLIC_ACK"');
  },
  stream: async (p: GenParams, cb: (s: string) => void) => {
    calls.push({ pass: 'f', p, text: textOf(p) }); cb(focusOutput); return result(focusOutput);
  },
};
const ctx = { db, model, queue: new GenerationQueue(1), resolvedModel: () => 'mock',
  log: { error() {}, info() {}, warn() {}, debug() {} } } as unknown as Ctx;
const app = Fastify();
for (const route of [characterRoutes, storyRoutes, conversationRoutes, chatRoutes]) app.register(route(ctx));
let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) { await fn(); console.log(`ok ${++passed} ${name}`); }
async function api(method: 'GET' | 'POST', url: string, payload?: object) {
  const r = await app.inject({ method, url, payload }); assert.ok(r.statusCode < 400, `${r.statusCode} ${r.body}`);
  if (String(r.headers['content-type']).includes('text/event-stream')) { assert.ok(r.body.includes('"type":"done"'), r.body); return r.body; }
  return r.json();
}
async function main() {
  const a = await api('POST', '/api/characters', { name: '나리', first_message: '', personality: '신중하다.', tags: ['party:place=교실'] });
  const b = await api('POST', '/api/characters', { name: '세라', first_message: '', personality: '자기가 관찰한 내용으로만 말한다.', tags: ['party:place=교실'] });
  const c = await api('POST', '/api/characters', { name: '하연', first_message: '', tags: ['party:place=교실'] });
  const s = await api('POST', '/api/stories', { name: 'fixture', setting: '교실', scene_catalog: { places: [{ id: '교실' }] } });
  for (const [i, actor] of [a,b,c].entries()) await api('POST', `/api/stories/${s.id}/characters`, { characterId: actor.id, sortOrder: i });
  const conv = await api('POST', '/api/conversations', { characterId: a.id, storyId: s.id, mode: 'story', scene: { format: 'beat' } });
  const send = async (body: object, route = 'messages') => {
    calls.length = 0; const sse = await api('POST', `/api/conversations/${conv.id}/${route}`, body);
    return { sse: String(sse), detail: await api('GET', `/api/conversations/${conv.id}`) };
  };
  const assertBoundary = () => {
    const extras = calls.filter(x => x.pass === 'e'); assert.equal(extras.length, 2, 'two real extra adapter requests');
    for (const e of extras) { assert.ok(e.text.includes(PUBLIC)); assert.ok(e.text.includes('PUBLIC_USE_LEFT_HAND')); assert.ok(!e.text.includes(SECRET), 'private thought reached actual Pass E'); }
    assert.ok(!calls.find(x => x.pass === 'f')!.text.includes(SECRET), 'private narration reached actual Pass F');
    const choices = calls.find(x => x.pass === 'c')!; assert.ok(choices); assert.ok(!choices.text.includes(SECRET), 'hidden thought reached actual Pass C');
    assert.ok(choices.text.includes('PUBLIC_ACK')); assert.ok(choices.text.includes('PUBLIC_USE_LEFT_HAND'));
    assert.deepEqual(calls.map(x => x.pass), ['delta','n','f','e','e','c']);
  };
  let target: string;
  await t('actual N→F/E/C requests exclude private thought and prevent mock reintroduction', async () => {
    const sent = await send({ content: '나리, 문을 살펴봐.' });
    console.log('FIRST_TURN_ADAPTER_REQUESTS='+JSON.stringify(calls.map(({pass,p})=>({pass,max_tokens:p.max_tokens,messages:p.messages}))));
    assertBoundary();
    assert.ok(!sent.sse.includes(SECRET)); assert.ok(!JSON.stringify(sent.detail.messages).includes(SECRET));
    const lines = sent.detail.messages.filter((m: any) => m.meta?.block_kind === 'line'); target = lines[0].id;
    assert.ok(lines.some((m: any) => m.content.includes('PUBLIC_ACK')));
    assert.ok(sent.detail.messages.some((m: any) => m.meta?.choices?.includes('PUBLIC_REPLY')));
  });
  await t('regenerate rebuilds the same boundary without abandoned-turn narration', async () => {
    narrationOutput = 'CURRENT_REGENERATE_NARRATION.';
    calls.length = 0; await send({ messageId: target! }, 'regenerate');
    for (const e of calls.filter(x => x.pass === 'e')) { assert.ok(!e.text.includes(SECRET)); assert.ok(e.text.includes('CURRENT_REGENERATE_NARRATION')); }
    assert.ok(!calls.find(x => x.pass === 'n')!.text.includes(PUBLIC), 'replaced turn is not an ancestor');
    assert.ok(!calls.find(x => x.pass === 'c')!.text.includes(SECRET));
  });
  await t('branch edits use the selected parent and drop sibling observations', async () => {
    const detail = await api('GET', `/api/conversations/${conv.id}`);
    const firstUser = detail.messages.find((m: any) => m.role === 'user');
    narrationOutput = 'CURRENT_BRANCH_NARRATION.';
    await send({ messageId: firstUser.id, content: '나리, 다시 문을 살펴봐.' }, 'branch');
    const n = calls.find(x => x.pass === 'n')!; assert.ok(!n.text.includes('CURRENT_REGENERATE_NARRATION'));
    for (const e of calls.filter(x => x.pass === 'e')) { assert.ok(!e.text.includes(SECRET)); assert.ok(e.text.includes('CURRENT_BRANCH_NARRATION')); }
    assert.ok(!calls.find(x => x.pass === 'c')!.text.includes(SECRET));
  });
  await t('actual narration labels/tags and private-only output never return through extras or choices', async () => {
    for (const text of [`PUBLIC_VARIANT<think>${SECRET}</think>`, `PUBLIC_VARIANT\n**속마음： ${SECRET}`, `<analysis>${SECRET}</analysis>PUBLIC_VARIANT`, `<think>${SECRET}`]) {
      narrationOutput = text;
      const sent = await send({content:'나리, 문을 확인해.'});
      for (const call of calls.filter(x=>['f','e','c'].includes(x.pass))) assert.ok(!call.text.includes(SECRET));
      assert.ok(!sent.sse.includes(SECRET));
      const currentUser = sent.detail.messages.findLastIndex((m:any)=>m.role==='user');
      assert.ok(!JSON.stringify(sent.detail.messages.slice(currentUser+1)).includes(SECRET));
      if(text.includes('PUBLIC_VARIANT')) for(const e of calls.filter(x=>x.pass==='e')) assert.ok(e.text.includes('PUBLIC_VARIANT'));
    }
  });
  await t('intentional spoken disclosure remains available; no secret-string blacklist', async () => {
    focusOutput = `"PUBLIC_DISCLOSURE_${SECRET}"`; narrationOutput = 'PUBLIC_DISCLOSURE_SCENE.';
    await send({ content: '나리, 암호를 모두에게 말해.' });
    for (const e of calls.filter(x => x.pass === 'e')) assert.ok(e.text.includes(`PUBLIC_DISCLOSURE_${SECRET}`));
    assert.ok(calls.find(x => x.pass === 'c')!.text.includes(`PUBLIC_DISCLOSURE_${SECRET}`));
  });
  await t('legacy active narration is filtered at read time; sibling and original bytes stay isolated', async () => {
    const head = db.prepare('SELECT head_message_id FROM conversations WHERE id = ?').get(conv.id) as any;
    const active = insertMessage(db, conv.id, head.head_message_id, 'assistant', 'LEGACY_PUBLIC_ACTIVE', 'complete', { block_kind: 'narration' });
    // Bypass today's write sanitizer to reproduce an actually contaminated historical row.
    db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(`LEGACY_PUBLIC_ACTIVE<think>${SECRET}</think>`, active.id);
    assert.ok((db.prepare('SELECT content FROM messages WHERE id = ?').get(active.id) as any).content.includes(SECRET));
    insertMessage(db, conv.id, head.head_message_id, 'assistant', 'LEGACY_PUBLIC_SIBLING', 'complete', { block_kind: 'narration' });
    setHead(db, conv.id, active.id);
    const before = db.prepare('SELECT content, meta_json FROM messages WHERE id = ?').get(active.id);
    focusOutput = LINE; narrationOutput = 'CURRENT_LEGACY_SCENE.';
    await send({ content: '나리, 계속 문을 살펴봐.' });
    const n = calls.find(x => x.pass === 'n')!;
    assert.ok(n.text.includes('LEGACY_PUBLIC_ACTIVE')); assert.ok(!n.text.includes(SECRET));
    assert.ok(!n.text.includes('LEGACY_PUBLIC_SIBLING'));
    assert.deepEqual(db.prepare('SELECT content, meta_json FROM messages WHERE id = ?').get(active.id), before, 'no historical redaction');
  });
  const fixture: BeatPlanInput = {
    scene: { location: '교실', present_ids: [a.id,b.id,c.id] }, catalog: catalogFromStory(JSON.stringify({places:[{id:'교실'}]})), current_version: 0,
    user_text: '나리, 문을 살펴봐.', user_name: '나', main_character_id: a.id, story_room: true,
    cast: [a,b,c].map(actor => ({id:actor.id,name:actor.name,aliases:[],duties:[],place:'교실',role:'secondary'})),
  };
  const plan = planBeat(fixture);
  assert.equal(plan.approved_extras.length,2);
  await t('assembly boundary handles thought-only, malformed/repeated markers and tags', () => {
    for (const focusText of [`${THOUGHT_MARKER} ${SECRET}`, `${LINE}\n${THOUGHT_MARKER} ${SECRET}\n${THOUGHT_MARKER} SECOND_PRIVATE`, `${LINE}\n${THOUGHT_MARKER}`, `${LINE}<analysis>${SECRET}</analysis>`, `${LINE}<think>${SECRET}`, `${LINE}\nthinking: ${SECRET}`, '']) {
      for (const e of planPassE(fixture,plan,'PUBLIC_NARRATION',focusText)) {
        assert.ok(!e.prompt.includes(SECRET)); assert.ok(!e.prompt.includes('SECOND_PRIVATE'));
        if (focusText.startsWith(LINE)) assert.ok(e.prompt.includes('PUBLIC_USE_LEFT_HAND'));
      }
    }
  });
  await t('choice assembly ignores typed thought and undeclared fields; marked line suffix cannot bypass', () => {
    const blocks: any[] = [
      { kind: 'thought', text: SECRET, speaker_name: SECRET },
      { kind: 'line', text: `${LINE}\n${THOUGHT_MARKER} ${SECRET}`, speaker_name: '나리', private_thought: SECRET, visible_action: SECRET },
      { kind: 'line', text: 'PUBLIC_ACK', speaker_name: '세라' },
      { kind: 'ui', text: SECRET }, { kind: 'unknown', text: SECRET },
    ];
    const p = passCWith(fixture,{blocks} as any);
    assert.ok(!p.includes(SECRET)); assert.ok(p.includes('PUBLIC_USE_LEFT_HAND')); assert.ok(p.includes('PUBLIC_ACK'));
  });
  await t('explicit remaining gap: unclassified action prose has no audience policy', () => {
    const unclassified = `민서가 비공개로 암호 ${SECRET}를 입력한다.`;
    for (const e of planPassE(fixture,plan,'',unclassified)) assert.ok(e.prompt.includes(unclassified), 'legacy action text remains unchanged; this is not recipient filtering');
  });
}
main().then(() => console.log(`PASS=${passed}`)).catch(e => { console.error(e); process.exitCode=1; }).finally(async () => { await app.close(); db.close(); fs.rmSync(tmp,{recursive:true,force:true}); });
