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



  const originalContext=config.model.contextTokens;
  config.model.contextTokens=2048;
  try {
    focusOutput='"SAFE_F"'; narrationOutput='SAFE_N';
    await api('PATCH', `/api/conversations/${conv.id}`, {scene:{observation_filter:true}});
    await send({content:'나리, 시작해.'});
    const initial=await send({content:'나리, 다음.'});
    const snap=initial.detail.messages.findLast((m:any)=>m.meta?.scene_state).meta.scene_state;
    let head=initial.detail.messages.at(-1).id;
    for(let i=0;i<100;i++) {
      const u=insertMessage(db,conv.id,head,'user',`OPTIONAL_${i} `+'가나다라'.repeat(60),'complete',{observation:{visibility:'public'}});
      const h=insertMessage(db,conv.id,u.id,'assistant','HEADER','complete',{generation_id:`pressure-${i}`,beat_seq:0,block_kind:'header',scene_state:snap});
      head=h.id;
    }
    db.prepare('INSERT INTO model_profiles (name,instruction_enabled,instruction_text) VALUES (?,0,?)').run('heading-contract','');
    await api('PATCH', `/api/conversations/${conv.id}`, {profileName:'heading-contract'});
    const heading='## 앞서 이미 서술된 것';
    const failures:string[]=[];
    for(const field of ['user','profile','inject']) {
      const required=`${heading}\n${field.toUpperCase()}_REQUIRED_SENTINEL_7319`;
      db.prepare('UPDATE model_profiles SET instruction_enabled=?,instruction_text=? WHERE name=?').run(field==='profile'?1:0,field==='profile'?required:'','heading-contract');
      setHead(db,conv.id,head);
      const content=field==='user'?`나리, 확인해.\n${required}`:'나리, 확인해.';
      await send({content,inject_instruction:field==='inject'?required:'ATTACH_PRESSURE'});
      const ic=calls.filter(x=>['n','f','e'].includes(x.pass));
      assert.ok(ic.some(x=>x.pass==='f')); assert.equal(ic.filter(x=>x.pass==='e').length,2);
      const missing=ic.filter(x=>!x.text.includes(required)).map(x=>x.pass);
      console.log('MANDATORY_HEADING_CASE='+JSON.stringify({field,missing,requests:ic.map(x=>({pass:x.pass,tokens:estimateMessageTokens(x.text),completion:x.p.max_tokens,kept:x.text.includes(required)}))}));
      if(missing.length) failures.push(field);
      for(const x of ic) assert.ok(estimateMessageTokens(x.text)+x.p.max_tokens+64<=config.model.contextTokens);
    }
    assert.deepEqual(failures,[],'mandatory user/profile/inject heading+sentinel was deleted');
    console.log('ok 1 actual N/F/E preserve heading+sentinel in each mandatory input under pressure');
    // All mandatory components fit individually but their combined F prompt does not.
    const required=`${heading}\nOVERSIZED_REQUIRED_SENTINEL_7319\n`+'가'.repeat(1600);
    db.prepare('UPDATE model_profiles SET instruction_enabled=1,instruction_text=? WHERE name=?').run(`${heading}\nPROFILE_OVERSIZED_SENTINEL\n`+'나'.repeat(1000),'heading-contract');
    setHead(db,conv.id,head); calls.length=0;
    const r=await app.inject({method:'POST',url:`/api/conversations/${conv.id}/messages`,payload:{content:`나리, 확인해.\n${required}`,inject_instruction:`${heading}\nINJECT_OVERSIZED_SENTINEL`}});
    assert.ok(r.body.includes('"type":"error"')||r.statusCode===422,r.body);
    assert.equal(calls.some(x=>x.pass==='f'),false,'oversized mandatory F input must not reach model');
    assert.ok(!r.body.includes('"type":"done"'));
    console.log('ok 2 mandatory overflow fails explicitly after structured optional context is removed');
  } finally { config.model.contextTokens=originalContext; }

}
main().then(() => console.log(`PASS=${passed}`)).catch(e => { console.error(e); process.exitCode=1; }).finally(async () => { await app.close(); db.close(); fs.rmSync(tmp,{recursive:true,force:true}); });
