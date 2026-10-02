/** npm run test:benches -- responseContinuation — actual routes, temporary DB, fake model only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openMigratedDb, one, run } from '../apps/server/src/db/index.js';
import { insertMessage, setHead, getPath, parseMessageMeta, resolveTurnStart } from '../apps/server/src/db/tree.js';
import { buildSceneSnapshot, resolveSceneBase } from '../apps/server/src/db/sceneBase.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { chatRoutes } from '../apps/server/src/routes/chat.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { GenParams } from '../apps/server/src/model/adapter.js';
import type { ConversationRow, MessageRow, Scene } from '../apps/server/src/types.js';

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-continuation-'));
  const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
  run(db, "INSERT INTO model_profiles(name,model,temperature,top_p,max_tokens,stop_json,system_mode) VALUES ('rp-balanced',NULL,0.8,0.95,800,'[]','system')");
  const calls: GenParams[] = [];
  let modelName = 'mock';
  let output = '"새 문장이 이어졌다."';
  let behavior: 'normal' | 'fail' | 'abort' = 'normal';
  const queue = new GenerationQueue(1);
  let during: (()=>Promise<void>) | undefined;
  const ctx = { db, queue, resolvedModel:()=>modelName, log:{warn(){},error(){},info(){},debug(){}}, model:{
    complete: async()=> {throw new Error('continuation must not call scene/ending/choices');},
    stream: async(p:GenParams, cb:(s:string)=>void)=> {
      calls.push(p); if (during) await during();
      if (behavior === 'fail') throw new Error('private internal failure');
      cb('<thi'); cb('nk>hidden reasoning</think>'); cb(output);
      if (behavior === 'abort') { queue.abort(queue.activeList[0].id); throw new Error('aborted'); }
      return {text:output,finishReason:'length',usage:null,ttftMs:1,totalMs:2};
    },
  }} as unknown as Ctx;
  const app = Fastify();
  for (const route of [characterRoutes,storyRoutes,conversationRoutes,chatRoutes]) app.register(route(ctx));
  await app.ready();
  let checks=0;
  const test = async(name:string,fn:()=>void|Promise<void>)=> {await fn(); console.log(`ok ${++checks} ${name}`);};
  const api = async(method:any,url:string,payload?:any)=> {const r=await app.inject({method,url,payload});assert.ok(r.statusCode<400,r.body);return r.json();};
  const a=await api('POST','/api/characters',{name:'나리',first_message:'',personality:'신중하다',tags:['party:place=교실']});
  const b=await api('POST','/api/characters',{name:'세라',first_message:'',tags:['party:place=교실']});
  const story=await api('POST','/api/stories',{name:'이어쓰기 검증',setting:'교실',scene_catalog:{places:[{id:'교실'}]}});
  for(const [i,c] of [a,b].entries()) await api('POST',`/api/stories/${story.id}/characters`,{characterId:c.id,sortOrder:i});
  const conv=(id:string)=>one<ConversationRow>(db,'SELECT * FROM conversations WHERE id=?',id)!;
  const row=(id:string)=>one<MessageRow>(db,'SELECT * FROM messages WHERE id=?',id)!;
  async function fixture(format?:'beat'|'dialog',privateTurn=false){
    const c=await api('POST','/api/conversations',{characterId:a.id,...(format?{storyId:story.id,mode:'story',scene:{format}}:{})});
    const scene:Scene={...(format?{format,present_ids:[a.id,b.id],location:'교실',turn_no:3,scene_version:3}:{}),time:'오후',clock_minutes:120,...(privateTurn?{observation_filter:true,observation_legacy_classified:true}:{})};
    run(db,'UPDATE conversations SET scene_json=? WHERE id=?',JSON.stringify(scene),c.id);
    const observation=privateTurn?{visibility:'private' as const,recipient_ids:['user',a.id],observer_ids:[]}:{visibility:'public' as const};
    const user=insertMessage(db,c.id,null,'user','나리, 부탁해.','complete',{observation});
    const base=insertMessage(db,c.id,user.id,'assistant',privateTurn?'"SECRET_ORCHID_825"':'"BASE_REPLY"','complete',format?{
      generation_id:'base-'+c.id,beat_seq:0,block_kind:'line',speaker_character_id:a.id,speaker_name:'나리',observation,scene_state:buildSceneSnapshot(scene,scene),
    }:{generation_id:'base-'+c.id});
    setHead(db,c.id,base.id);
    return {id:c.id,base,user,scene};
  }
  const send=(id:string,messageId=conv(id).head_message_id)=>app.inject({method:'POST',url:`/api/conversations/${id}/continue`,payload:{messageId}});
  const mainState=(id:string)=> {const c=conv(id);return {scene:c.scene_json,ended:c.ended_at,reason:c.ending_reason,memories:db.prepare('SELECT * FROM memories').all(),summaries:db.prepare('SELECT * FROM summaries').all()};};
  try {
    await test('ordinary appends canonical streamed rows; preserves old bytes, scene and memories; reload matches',async()=>{
      const f=await fixture();const before=mainState(f.id);const old={...row(f.base.id)};
      calls.length=0;const r=await send(f.id);assert.equal(r.statusCode,200,r.body);assert.match(r.body,/"type":"done"/);assert.ok(!r.body.includes('hidden reasoning'));
      assert.equal(calls.length,1);assert.ok(calls[0].messages.some(m=>m.content.includes('BASE_REPLY')));assert.equal(calls[0].max_tokens,800);
      assert.deepEqual(row(f.base.id),old);assert.deepEqual(mainState(f.id),before);
      const history=getPath(db,conv(f.id));assert.equal(history.length,3);assert.equal(history.at(-1)!.parent_id,f.base.id);
      assert.equal(parseMessageMeta(history.at(-1)!.meta_json).finish_reason,'length');
      const reload=await api('GET',`/api/conversations/${f.id}`);assert.equal(reload.messages.at(-1).content,output);
      assert.deepEqual(resolveTurnStart(db,history.at(-1)!),{kind:'single',parentId:f.user.id},'regenerate repeats original turn, not a turn without a user');
    });
    await test('party dialog canonicalizes allowed speakers and keeps existing turn and scene',async()=>{
      const f=await fixture('dialog');const before=mainState(f.id);output='바람이 잠깐 잦아들었다.\n나리 | 다음 이야기를 들려줄게.\n세라 | 알겠어.\n없는화자 | 불허';
      const r=await send(f.id);assert.equal(r.statusCode,200,r.body);assert.match(r.body,/"type":"done"/);assert.deepEqual(mainState(f.id),before);
      const history=getPath(db,conv(f.id));assert.ok(history.length>3);assert.ok(!history.some(m=>parseMessageMeta(m.meta_json).speaker_name === '없는화자'));
      for(const m of history.slice(2)){assert.equal(parseMessageMeta(m.meta_json).generation_id,'base-'+f.id);assert.ok(parseMessageMeta(m.meta_json).beat_seq!>0);}
      assert.deepEqual(resolveTurnStart(db,history.at(-1)!),{kind:'multi',startId:f.base.id,parentId:f.user.id});
      assert.equal(calls.at(-1)!.max_tokens,900);
    });
    await test('beat whisper keeps server recipients; nonrecipient continuation excludes old secret before budgeting',async()=>{
      output='"PRIVATE_FOLLOWUP"';const f=await fixture('beat',true);const before=mainState(f.id);
      let r=await send(f.id);assert.match(r.body,/"type":"done"/);assert.ok(calls.at(-1)!.messages.some(m=>m.content.includes('SECRET_ORCHID_825')));
      assert.deepEqual(parseMessageMeta(row(conv(f.id).head_message_id!).meta_json).observation,{visibility:'private',recipient_ids:[a.id,'user'],observer_ids:[]});
      assert.deepEqual(mainState(f.id),before);
      const c=conv(f.id);const publicRow=insertMessage(db,f.id,c.head_message_id,'assistant','"PUBLIC_SEPARATE"','complete',{
        generation_id:'public-'+f.id,beat_seq:0,block_kind:'line',speaker_character_id:b.id,speaker_name:'세라',observation:{visibility:'public'},scene_state:buildSceneSnapshot(f.scene,f.scene),
      });setHead(db,f.id,publicRow.id);output='"PUBLIC_NEXT"';r=await send(f.id);assert.match(r.body,/"type":"done"/);
      assert.ok(calls.at(-1)!.messages.every(m=>!m.content.includes('SECRET_ORCHID_825')));
      assert.deepEqual(parseMessageMeta(row(conv(f.id).head_message_id!).meta_json).observation,{visibility:'public'});
    });
    await test('stale head, ended, active job, missing model and invalid payload refuse without writes or model calls',async()=>{
      const f=await fixture();const before=db.prepare('SELECT * FROM messages WHERE conversation_id=?').all(f.id);const count=calls.length;
      assert.equal((await send(f.id,f.user.id)).statusCode,409);
      assert.equal((await app.inject({method:'POST',url:`/api/conversations/${f.id}/continue`,payload:{messageId:f.base.id,extra:1}})).statusCode,400);
      run(db,"UPDATE conversations SET ended_at='now' WHERE id=?",f.id);assert.equal((await send(f.id)).statusCode,409);run(db,'UPDATE conversations SET ended_at=NULL WHERE id=?',f.id);
      queue.register({id:'busy',conversationId:f.id,messageId:'',startedAt:'now',controller:new AbortController()});assert.equal((await send(f.id)).statusCode,409);queue.unregister('busy');
      modelName='';assert.equal((await send(f.id)).statusCode,503);modelName='mock';
      assert.equal(calls.length,count);assert.deepEqual(db.prepare('SELECT * FROM messages WHERE conversation_id=?').all(f.id),before);
    });
    await test('stream polling sees active row; abort preserves original and scene, unregisters job',async()=>{
      const f=await fixture('beat');const before=mainState(f.id);behavior='abort';output='"미완성 응답"';
      during=async()=>{assert.equal(queue.activeList.length,1);const reload=await api('GET',`/api/conversations/${f.id}`);assert.equal(reload.messages.at(-1).status,'streaming');assert.equal(reload.activeGeneration.messageId,conv(f.id).head_message_id);};
      const r=await send(f.id);during=undefined;behavior='normal';assert.match(r.body,/"type":"error"/);assert.equal(queue.activeList.length,0);assert.deepEqual(mainState(f.id),before);assert.equal(row(f.base.id).status,'complete');assert.equal(row(conv(f.id).head_message_id!).status,'interrupted');
    });
    await test('model failure restores head if no text and never exposes internal error details',async()=>{
      const f=await fixture();behavior='fail';const before=mainState(f.id);const r=await send(f.id);behavior='normal';assert.ok(!r.body.includes('private internal failure'));assert.equal(conv(f.id).head_message_id,f.base.id);assert.deepEqual(mainState(f.id),before);assert.equal(queue.activeList.length,0);
    });
    await test('oversized mandatory continuation refuses before row/model; pending scene edit survives continuation',async()=>{
      const f=await fixture('beat');run(db,'UPDATE messages SET content=? WHERE id=?','가'.repeat(120000),f.base.id);const count=calls.length;const n=db.prepare('SELECT count(*) n FROM messages').get();assert.equal((await send(f.id)).statusCode,422);assert.equal(calls.length,count);assert.deepEqual(db.prepare('SELECT count(*) n FROM messages').get(),n);
      run(db,'UPDATE messages SET content=? WHERE id=?','"응답"',f.base.id);
      const edited={...f.scene,place:'수정한 장소',pending_edit:{head_message_id:f.base.id}};run(db,'UPDATE conversations SET scene_json=? WHERE id=?',JSON.stringify(edited),f.id);
      output='"계속"';const r=await send(f.id);assert.match(r.body,/"type":"done"/);assert.equal(conv(f.id).scene_json,JSON.stringify(edited));
      assert.equal(resolveSceneBase(db,{conversationScene:edited,parentId:conv(f.id).head_message_id}).scene.place,'수정한 장소');
    });
  } finally { await app.close();db.close();fs.rmSync(tmp,{recursive:true,force:true}); }
}
main().catch(err=>{console.error(err);process.exitCode=1;});
