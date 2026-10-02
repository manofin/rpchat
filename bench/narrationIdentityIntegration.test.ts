import { runEndingEvalJob } from '../apps/server/src/endingJudge.js';
import { audienceOf } from '../apps/server/src/prompt/observation.js';
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
let extraOutput = '';
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
    if (extraOutput) return result(extraOutput);
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
async function api(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) {
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

  focusOutput='"PUBLIC_ACK"'; narrationOutput='PUBLIC_NARRATION'; extraOutput='"PUBLIC_EXTRA"';
  await api('PATCH', `/api/conversations/${conv.id}`, {scene:{observation_filter:true}});
  await send({content:`나리, 너에게만 ${SECRET}`,observation:{visibility:'private',recipient_ids:[a.id],observer_ids:[]}});
  const first=calls.map(x=>({pass:x.pass,text:x.text}));
  assert.ok(first.find(x=>x.pass==='f')!.text.includes(SECRET));
  for(const x of first.filter(x=>['n','e'].includes(x.pass))) assert.ok(!x.text.includes(SECRET));
  await send({content:'세라, 공개 발화야. 나는 손목이 다쳤어.',observation:{visibility:'public'}});
  const on=calls.map(x=>({pass:x.pass,text:x.text}));
  const n=on.find(x=>x.pass==='n')!.text;
  assert.ok(n.includes('## 현재 사용자 발화\n[사용자: 나] 세라, 공개 발화야. 나는 손목이 다쳤어.'));
  assert.ok(n.includes('## 과거 관찰\n[서술자] PUBLIC_NARRATION'));
  assert.ok(n.includes('[세라] "PUBLIC_EXTRA"'));
  assert.ok(!n.includes('[나리] PUBLIC_NARRATION'));
  assert.ok(n.includes("'나'은 사용자다. 위 목록의 인물과 같은 사람이 아니다."));
  for(const x of on.filter(x=>x.pass==='n' || (x.pass==='e' && !x.text.startsWith("너는 '나리'")))) assert.ok(!x.text.includes(SECRET),'non-recipient must not see private history');
  assert.ok(on.find(x=>x.pass==='e' && x.text.startsWith("너는 '나리'"))!.text.includes(SECRET),'original recipient retains private history');
  await api('PATCH', `/api/conversations/${conv.id}`, {scene:{observation_filter:false}});
  await send({content:'세라, 필터가 꺼져도 내 발화야.'});
  const off=calls.map(x=>({pass:x.pass,text:x.text}));const no=off.find(x=>x.pass==='n')!.text;
  assert.ok(no.includes('## 현재 사용자 발화\n[사용자: 나] 세라, 필터가 꺼져도 내 발화야.'));
  assert.ok(!no.includes('## 과거 관찰'));
  fs.writeFileSync(path.resolve('../integration-route-captures.json'),JSON.stringify({on,off,privateTurn:first,checks:12,networkCalls:0,liveDB:false},null,2));
  console.log('ok 1 actual ON/OFF N sections, stored narrator/dialogue authors, private recipient boundary');

}
main().then(() => console.log(`PASS=${passed}`)).catch(e => { console.error(e); process.exitCode=1; }).finally(async () => { await app.close(); db.close(); fs.rmSync(tmp,{recursive:true,force:true}); });
