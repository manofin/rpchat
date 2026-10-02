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

  focusOutput = '"FOCUS_SAFE_REPLY"'; narrationOutput = 'NEW_PUBLIC_NARRATION';
  const patch = (body:object) => api('PATCH', `/api/conversations/${conv.id}`, body);
  await patch({scene:{observation_filter:true}});
  await t('API refuses opt-in outside the implemented party path', async () => {
    const single = await api('POST', '/api/conversations', {characterId:a.id});
    const r = await app.inject({method:'PATCH',url:`/api/conversations/${single.id}`,payload:{scene:{observation_filter:true}}});
    assert.equal(r.statusCode,400);
  });
  await t('server rejects unknown recipients before insert or model call', async () => {
    const before = (db.prepare('SELECT count(*) n FROM messages').get() as any).n;
    calls.length = 0;
    const r = await app.inject({method:'POST',url:`/api/conversations/${conv.id}/messages`,payload:{content:SECRET,observation:{visibility:'private',recipient_ids:['unknown']}}});
    assert.equal(r.statusCode,400); assert.equal(calls.length,0);
    assert.equal((db.prepare('SELECT count(*) n FROM messages').get() as any).n,before);
  });
  let privateTurn: any;
  await t('actual whisper requests: recipient receives body; NPC extras and GM exclude it', async () => {
    privateTurn = await send({content:`나리, ${SECRET}`, observation:{visibility:'private',recipient_ids:[a.id],observer_ids:[b.id]}});
    const user = privateTurn.detail.messages.findLast((m:any)=>m.role==='user');
    assert.ok(user.meta.observation.recipient_ids.includes('user'));
    assert.ok(calls.find(x=>x.pass==='f')!.text.includes(SECRET));
    for (const x of calls.filter(x=>['delta','n','e'].includes(x.pass))) assert.ok(!x.text.includes(SECRET),x.pass);
    assert.ok(calls.filter(x=>x.pass==='e').some(x=>x.text.includes('[비공개 대화가 있었다.]')));
    console.log('WHISPER_ADAPTER_REQUESTS='+JSON.stringify(calls.map(x=>({pass:x.pass,messages:x.p.messages}))));
  });
  await t('private C exposure is persisted with server-owned recipients', async () => {
    const host = privateTurn.detail.messages.findLast((m:any)=>m.meta.choices?.length);
    assert.ok(host); assert.deepEqual(host.meta.choices_context,{private_context:true,recipient_ids:[a.id]});
    const reload = await api('GET', `/api/conversations/${conv.id}`);
    assert.deepEqual(reload.messages.find((m:any)=>m.id===host.id).meta.choices_context,host.meta.choices_context);
  });
  await t('saved private-context choice can be confirmed public or to the same recipients', async () => {
    const host = privateTurn.detail.messages.findLast((m:any)=>m.meta.choices?.length);
    for (const visibility of ['public','private']) {
      const sent = await send({content:visibility==='public'?'USER_CONFIRMED_PUBLIC':host.meta.choices[0],choice:{message_id:host.id,index:0,visibility}});
      const user = sent.detail.messages.findLast((m:any)=>m.role==='user');
      assert.deepEqual(user.meta.observation,visibility==='public'?{visibility:'public'}:{visibility:'private',recipient_ids:['user',a.id],observer_ids:[]});
    }
  });
  await t('invalid source, index and recipient override fail before writing or model calls', async () => {
    const host = privateTurn.detail.messages.findLast((m:any)=>m.meta.choices?.length);
    for (const payload of [
      {choice:{message_id:'missing',index:0,visibility:'private'}},
      {choice:{message_id:host.id,index:99,visibility:'private'}},
      {choice:{message_id:host.id,index:0,visibility:'private'},observation:{visibility:'private',recipient_ids:[b.id]}},
    ]) {
      const before = (db.prepare('SELECT count(*) n FROM messages').get() as any).n;
      calls.length=0;
      const res=await app.inject({method:'POST',url:`/api/conversations/${conv.id}/messages`,payload:{content:'CHOICE',...payload}});
      assert.equal(res.statusCode,400,res.body);assert.equal(calls.length,0);
      assert.equal((db.prepare('SELECT count(*) n FROM messages').get() as any).n,before);
    }
  });
  await t('missing original recipients and off-branch choices fail before generation', async () => {
    const host = privateTurn.detail.messages.findLast((m:any)=>m.meta.choices?.length);
    const original = db.prepare('SELECT meta_json FROM messages WHERE id=?').get(host.id) as any;
    for (const context of [{private_context:true,recipient_ids:[]},{private_context:true,recipient_ids:['deleted-npc']},undefined]) {
      db.prepare('UPDATE messages SET meta_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(original.meta_json),choices_context:context}),host.id);
      calls.length=0; const before=(db.prepare('SELECT count(*) n FROM messages').get() as any).n;
      const res=await app.inject({method:'POST',url:`/api/conversations/${conv.id}/messages`,payload:{content:'SAVED',choice:{message_id:host.id,index:0,visibility:'private'}}});
      assert.equal(res.statusCode,400); assert.equal(calls.length,0);assert.equal((db.prepare('SELECT count(*) n FROM messages').get() as any).n,before);
    }
    db.prepare('UPDATE messages SET meta_json=? WHERE id=?').run(original.meta_json,host.id);
    const head=(db.prepare('SELECT head_message_id FROM conversations WHERE id=?').get(conv.id) as any).head_message_id;
    setHead(db,conv.id,null); calls.length=0;
    const res=await app.inject({method:'POST',url:`/api/conversations/${conv.id}/messages`,payload:{content:'SAVED',choice:{message_id:host.id,index:0,visibility:'public'}}});
    assert.equal(res.statusCode,400);assert.equal(calls.length,0);setHead(db,conv.id,head);
  });
  await t('background GM judge excludes private body by default', async () => {
    db.prepare('UPDATE conversations SET story_endings_snapshot=? WHERE id=?').run(JSON.stringify([{id:'e',title:'fixture',conditions:{min_turns:1,narrative_hint:'PUBLIC_HINT'}}]),conv.id);
    let actual='';
    await runEndingEvalJob({db,modelName:'mock',complete:async p=>{actual=textOf(p);return result('{}');},log:()=>{}},conv.id);
    assert.ok(actual.includes('PUBLIC_HINT')); assert.ok(!actual.includes(SECRET));
    db.prepare('UPDATE conversations SET story_endings_snapshot=? WHERE id=?').run('[]',conv.id);
  });
  await t('model secret/free visible_action cannot be promoted through extras or later narration', async () => {
    focusOutput = `"${SECRET}" visible_action: ${SECRET}`;
    const sent = await send({content:`나리, ${SECRET}`,observation:{visibility:'private',recipient_ids:[a.id]}});
    for(const x of calls.filter(x=>['n','delta','e'].includes(x.pass))) assert.ok(!x.text.includes(SECRET));
    const line = sent.detail.messages.findLast((m:any)=>m.meta?.speaker_character_id===a.id);
    assert.equal(line.meta.observation.visibility,'private');
    focusOutput='"SAFE"';
    await send({content:'세라, 계속해.'});
    for(const x of calls.filter(x=>['delta','n','f'].includes(x.pass))) assert.ok(!x.text.includes(SECRET));
  });
  await t('public model speech does not promote free visible_action/private fields', async () => {
    const freeCode = 'FREE_MODEL_PRIVATE_5189';
    focusOutput=`"PUBLIC_QUOTED_SPEECH"\nvisible_action: ${freeCode}\nprivate: ${freeCode}`;
    await send({content:'하연, 모두에게 인사해.'});
    for(const x of calls.filter(x=>x.pass==='e')) { assert.ok(!x.text.includes(freeCode)); assert.ok(x.text.includes('PUBLIC_QUOTED_SPEECH')); }
    focusOutput='"SAFE"';
    await send({content:'세라, 다음.'});
    for(const x of calls.filter(x=>['n','f','e'].includes(x.pass))) assert.ok(!x.text.includes(freeCode));
  });
  const legacy = 'UNCLASSIFIED_SECRET_9485';
  await t('ON contaminated historical row is fail-closed, OFF keeps legacy context', async () => {
    const detail = await api('GET', `/api/conversations/${conv.id}`);
    const committed = detail.messages.findLast((m:any)=>m.meta?.block_kind==='narration');
    db.prepare('UPDATE messages SET content=?,meta_json=? WHERE id=?').run(legacy,JSON.stringify({...committed.meta,observation:undefined}),committed.id);
    assert.ok((db.prepare('SELECT content FROM messages WHERE id=?').get(committed.id) as any).content.includes(legacy));
    const head=(db.prepare('SELECT head_message_id FROM conversations WHERE id=?').get(conv.id) as any).head_message_id;
    const row=insertMessage(db,conv.id,head,'assistant',legacy,'complete',{block_kind:'narration'});
    db.prepare('UPDATE messages SET meta_json=? WHERE id=?').run(JSON.stringify({block_kind:'narration'}),row.id);
    assert.equal((db.prepare('SELECT content FROM messages WHERE id=?').get(row.id) as any).content,legacy);
    setHead(db,conv.id,row.id);
    await send({content:'세라, 다음.'});
    for(const x of calls.filter(x=>['n','f','e'].includes(x.pass))) assert.ok(!x.text.includes(legacy));
    await patch({scene:{observation_filter:false}});
    await send({content:'세라, 다음.'});
    assert.ok(calls.find(x=>x.pass==='n')!.text.includes(legacy));
    assert.equal(audienceOf(db.prepare('SELECT * FROM messages WHERE id=?').get(row.id) as any),undefined);
  });
  await t('explicit bulk confirmation classifies only successful active rows once', async () => {
    const rows=await api('GET',`/api/conversations/${conv.id}`);
    const line=rows.messages.findLast((m:any)=>m.meta?.block_kind==='narration' && m.content==='NEW_PUBLIC_NARRATION');
    db.prepare('UPDATE messages SET meta_json=? WHERE id=?').run(JSON.stringify({...line.meta, observation:undefined}),line.id);
    await patch({scene:{observation_filter:true}, classify_legacy_public:true});
    assert.equal(audienceOf(db.prepare('SELECT * FROM messages WHERE id=?').get(line.id) as any)?.visibility,'public');
    await patch({scene:{observation_filter:false}});
    const r=await app.inject({method:'PATCH',url:`/api/conversations/${conv.id}`,payload:{scene:{observation_filter:true},classify_legacy_public:true}});
    assert.equal(r.statusCode,400);
    await patch({scene:{observation_filter:true}});
  });
  await t('unsuccessful-turn observations never enter subsequent prompts', async () => {
    const head=(db.prepare('SELECT head_message_id FROM conversations WHERE id=?').get(conv.id) as any).head_message_id;
    const u=insertMessage(db,conv.id,head,'user','FAILED_USER_9731','complete',{observation:{visibility:'public'}});
    const row=insertMessage(db,conv.id,u.id,'assistant','FAILED_ASSISTANT_9731','complete',{block_kind:'narration',generation_id:'failed-generation',beat_seq:0,observation:{visibility:'public'}});
    setHead(db,conv.id,row.id);
    await send({content:'세라, 다음.'});
    for(const x of calls) { assert.ok(!x.text.includes('FAILED_USER_9731')); assert.ok(!x.text.includes('FAILED_ASSISTANT_9731')); }
  });
  await t('room opt-in and one-time classification survive branch selection; dialog refuses unsupported boundary', async () => {
    const r=await api('POST', `/api/messages/${privateTurn.detail.messages.at(-1).id}/select`);
    assert.equal(r.conversation.scene.observation_filter,true);
    assert.equal(r.conversation.scene.observation_legacy_classified,true);
    const invalid=await app.inject({method:'PATCH',url:`/api/conversations/${conv.id}`,payload:{scene:{format:'dialog'}}});
    assert.equal(invalid.statusCode,400);
  });
  await t('regenerate and branch do not restore abandoned private turn knowledge', async () => {
    focusOutput = `"ABANDONED_PRIVATE_4932"`;
    const sent=await send({content:`나리, ${SECRET}`,observation:{visibility:'private',recipient_ids:[a.id]}});
    const target=sent.detail.messages.findLast((m:any)=>m.meta?.speaker_character_id===a.id);
    focusOutput='"REPLACEMENT"';
    await send({messageId:target.id},'regenerate');
    for(const x of calls) assert.ok(!x.text.includes('ABANDONED_PRIVATE_4932'));
    const user=sent.detail.messages.findLast((m:any)=>m.role==='user');
    await send({messageId:user.id,content:'세라, 다른 분기.',observation:{visibility:'public'}},'branch');
    for(const x of calls) assert.ok(!x.text.includes('ABANDONED_PRIVATE_4932'));
  });

}
main().then(() => console.log(`PASS=${passed}`)).catch(e => { console.error(e); process.exitCode=1; }).finally(async () => { await app.close(); db.close(); fs.rmSync(tmp,{recursive:true,force:true}); });
