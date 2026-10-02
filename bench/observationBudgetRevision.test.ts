import { estimateMessageTokens } from '../apps/server/src/prompt/tokens.js';
import { config } from '../apps/server/src/config.js';
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


  focusOutput='"SAFE_F"'; narrationOutput='SAFE_N';
  await api('PATCH', `/api/conversations/${conv.id}`, {scene:{observation_filter:true}});
  const initial=await send({content:'나리, 시작해.'});
  const snap=initial.detail.messages.find((m:any)=>m.meta?.scene_state).meta.scene_state;
  let head=initial.detail.messages.at(-1).id;
  for(let i=0;i<100;i++) {
    const u=insertMessage(db,conv.id,head,'user',`OLD_USER_${i} `+'가나다라'.repeat(500),'complete',{observation:{visibility:'public'}});
    const h=insertMessage(db,conv.id,u.id,'assistant','HEADER','complete',{generation_id:`long-${i}`,beat_seq:0,block_kind:'header',scene_state:snap});
    const m=insertMessage(db,conv.id,h.id,'assistant',`"OLD_SPEECH_${i} `+'마바사아'.repeat(500)+'"','complete',{generation_id:`long-${i}`,block_kind:'line',speaker_character_id:a.id,observation:{visibility:'public'}});
    head=m.id;
  }
  setHead(db,conv.id,head);
  await send({content:'나리, 지금 답해.'});
  await send({content:'나리, 계속 답해.'});
  const sizes=calls.map(x=>({pass:x.pass,tokens:estimateMessageTokens(x.text),completion:x.p.max_tokens}));
  console.log('FINAL_LONG_ROOM_PROMPT_SIZES='+JSON.stringify(sizes));
  for(const x of sizes) assert.ok(x.tokens+x.completion+64<=config.model.contextTokens,`over context: ${JSON.stringify(x)}`);
  assert.ok(calls.some(x=>x.pass==='f')); assert.equal(calls.filter(x=>x.pass==='e').length,2); console.log('ok 1 long-room final adapter prompts fit context without inject/profile');

}
main().then(() => console.log(`PASS=${passed}`)).catch(e => { console.error(e); process.exitCode=1; }).finally(async () => { await app.close(); db.close(); fs.rmSync(tmp,{recursive:true,force:true}); });
