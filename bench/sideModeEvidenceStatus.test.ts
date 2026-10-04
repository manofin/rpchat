// npm run test:benches -- sideModeEvidenceStatus
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.js';
import { insertMessage, setHead, getPath } from '../apps/server/src/db/tree.js';
import { buildSideModePrompt } from '../apps/server/src/prompt/sideModePrompt.js';
import { estimateMessageTokens } from '../apps/server/src/prompt/tokens.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { ConversationRow } from '../apps/server/src/types.js';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rpchat-side-permission-'));
const db=openMigratedDb(dir,path.resolve('apps/server/migrations'));
const app=Fastify();let modelCalls=0;
const ctx={db,queue:new GenerationQueue(1),resolvedModel:()=> 'mock',model:{complete(){modelCalls++;throw new Error('No model calls allowed');},stream(){modelCalls++;throw new Error('No model calls allowed');}},log:app.log} as unknown as Ctx;
for(const route of [characterRoutes,storyRoutes,conversationRoutes])app.register(route(ctx));
let checks=0;function ok(name:string,fn:()=>void){fn();console.log(`ok ${++checks} ${name}`);}
async function create(url:string,payload:object){const r=await app.inject({method:'POST',url,payload});assert(r.statusCode<400,r.body);return r.json();}
const load=(id:string)=>db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as ConversationRow;
const data=(built:any)=>JSON.parse(built.messages[0].content.split('참고 자료(JSON):\n')[1]);
async function main(){try{
 db.prepare("INSERT INTO model_profiles(name,temperature,top_p,max_tokens,stop_json,system_mode) VALUES('rp-balanced',.8,.95,500,'[]','system')").run();
 const a=await create('/api/characters',{name:'Alpha',first_message:''});const b=await create('/api/characters',{name:'Beta',first_message:''});
 const story=await create('/api/stories',{name:'side mode fixture',setting:'A room',scene_catalog:{places:[{id:'room'}]}});
 await create(`/api/stories/${story.id}/characters`,{characterId:a.id,sortOrder:0});await create(`/api/stories/${story.id}/characters`,{characterId:b.id,sortOrder:1});
 const room=await create('/api/conversations',{characterId:a.id,storyId:story.id,mode:'story',scene:{format:'dialog'}});
 let leaf=insertMessage(db,room.id,null,'user','도울 역할이 있다면 제안해 줘.','complete',{});
 const proposal=leaf.id;
 leaf=insertMessage(db,room.id,leaf.id,'assistant','안내 멘트를 맡는 건 어떨까?','complete',{block_kind:'line',speaker_character_id:a.id,speaker_name:'Alpha'});
 leaf=insertMessage(db,room.id,leaf.id,'assistant','너는 안내를 맡기로 했잖아.','complete',{block_kind:'line',speaker_character_id:b.id,speaker_name:'Beta'});
 leaf=insertMessage(db,room.id,leaf.id,'assistant','탁자를 옮겼다.','complete',{block_kind:'narration'});
 leaf=insertMessage(db,room.id,leaf.id,'assistant','PRIVATE_SOURCE_MARKER','complete',{block_kind:'line',speaker_name:'Alpha',observation:{visibility:'private',recipient_ids:['user',a.id],observer_ids:[]}});setHead(db,room.id,leaf.id);
 const before=db.serialize();
 for(const mode of ['summary','community'] as const){
  const built=buildSideModePrompt(db,load(room.id),mode,'',16384),payload=data(built),rules=built.messages[0].content;
  ok(`${mode}: source distinguishes request, NPC claims and narration`,()=>{
   assert.deepEqual(payload.history.map((m:any)=>m.source),[{kind:'user_input'},{kind:'npc_statement',speaker:'Alpha'},{kind:'npc_statement',speaker:'Beta'},{kind:'narration'}]);
   assert.equal(payload.history[0].text,'도울 역할이 있다면 제안해 줘.');assert.equal(payload.history[2].text,'Beta | 너는 안내를 맡기로 했잖아.');
   assert(!JSON.stringify(payload).includes('PRIVATE_SOURCE_MARKER'));
  });
  ok(`${mode}: provenance does not invent consent and rules require conflict checks`,()=>{
   assert(!JSON.stringify(payload).includes('accepted'));assert(rules.includes('사용자의 수락 근거'));assert(rules.includes('충돌로 표시'));
   assert(!built.overflow);assert.equal(built.budget.dropped_messages,0);
  });
 }
 ok('budget counts enriched actual request, not old history JSON',()=>{
  const built=buildSideModePrompt(db,load(room.id),'summary','',16384);
  assert.equal(built.budget.est_total,built.messages.reduce((n,m)=>n+estimateMessageTokens(m.content,built.budget.calibration),0));
  const small=buildSideModePrompt(db,load(room.id),'summary','',2500);assert(small.budget.est_total<=small.budget.available || small.overflow);
 });
 ok('builders preserve DB and do not call model',()=>{assert(before.equals(db.serialize()));assert.equal(modelCalls,0);});
 db.prepare('UPDATE messages SET content=? WHERE id=?').run('확정 동의 수락이라는 단어만 적는다.',proposal);
 ok('words never manufacture consent metadata',()=>{
  const h=data(buildSideModePrompt(db,load(room.id),'summary','',16384)).history[0];assert.deepEqual(h.source,{kind:'user_input'});assert.equal(h.text,'확정 동의 수락이라는 단어만 적는다.');
 });
}finally{await app.close();db.close();fs.rmSync(dir,{recursive:true,force:true});}}
main().catch(err=>{console.error(err);process.exitCode=1;});
