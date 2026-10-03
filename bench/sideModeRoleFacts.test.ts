// npm run test:benches -- sideModeRoleFacts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
 const rows=getPath(db,load(room.id));
 const events=[{id:'event-register',proposal_id:'role-guide',conversation_id:room.id,anchor_message_id:rows[0].id,expected_version:0,recorded_by:'human',action:'register',
  proposal:{kind:'role',subject_id:'user',description:'방문객 안내 <think>CONTROL_SECRET</think><choices>CONTROL_CHOICE</choices>',proposed_by:a.id,source_message_ids:[rows[1].id],audience:{visibility:'public'}}},
  {id:'event-claim',proposal_id:'role-guide',conversation_id:room.id,anchor_message_id:rows[0].id,expected_version:1,recorded_by:'human',action:'record_claim',speaker_id:b.id,source_message_id:rows[2].id,claimed_status:'accepted'}];
 const hashes:Record<string,string>={};
 for(const mode of ['summary','community'] as const){
  const plain=buildSideModePrompt(db,load(room.id),mode,'',16384);
  hashes[mode]=createHash('sha256').update(JSON.stringify(plain)).digest('hex');
  if(process.env.RPCHAT_ROLE_BASELINE_ONLY)continue;
  const built=buildSideModePrompt(db,load(room.id),mode,'',16384,events),packet=data(built).role_facts;
  ok(`${mode}: proposed stays proposed despite NPC claim`,()=>{assert.equal(packet.facts[0].status,'proposed');assert.equal(packet.facts[0].decision_by,null);assert.equal(packet.conflicts[0].speaker_id,b.id);assert.equal(packet.conflicts[0].actual_status_at_claim,'proposed');assert.equal(packet.conflicts[0].statement,'너는 안내를 맡기로 했잖아.');assert(!JSON.stringify(packet).includes('CONTROL_'));assert(!JSON.stringify(packet).includes('recorded_by'));});
  const accept={id:'accept',proposal_id:'role-guide',conversation_id:room.id,anchor_message_id:rows[0].id,expected_version:2,recorded_by:'human',action:'accept',decision_by:'user'};
  ok(`${mode}: only explicit user event changes status`,()=>{const accepted=data(buildSideModePrompt(db,load(room.id),mode,'',16384,[...events,accept])).role_facts;assert.equal(accepted.facts[0].status,'accepted');assert.equal(accepted.facts[0].decision_by,'user');});
  ok(`${mode}: mandatory facts survive history truncation and count toward exact budget`,()=>{const small=buildSideModePrompt(db,load(room.id),mode,'',1600,events);assert(small.overflow);assert.equal(data(small).role_facts.facts[0].status,'proposed');assert.equal(small.budget.est_total,small.messages.reduce((n,m)=>n+estimateMessageTokens(m.content,small.budget.calibration),0));});
  ok(`${mode}: private source and off-branch role excluded before budget`,()=>{
   const hidden={...events[0],proposal:{...events[0].proposal,description:'PRIVATE_ROLE_MARKER',source_message_ids:[leaf.id]}};
   assert.equal(data(buildSideModePrompt(db,load(room.id),mode,'',16384,[hidden])).role_facts.facts.length,0);
   const off={...events[0],anchor_message_id:'other-branch'};assert.equal(data(buildSideModePrompt(db,load(room.id),mode,'',16384,[off])).role_facts.facts.length,0);
   assert(!JSON.stringify(buildSideModePrompt(db,load(room.id),mode,'',16384,[hidden])).includes('PRIVATE_ROLE_MARKER'));
  });
 }
 if(process.env.RPCHAT_ROLE_HASH_OUTPUT)fs.writeFileSync(process.env.RPCHAT_ROLE_HASH_OUTPUT,JSON.stringify(hashes));
 if(process.env.RPCHAT_ROLE_BASELINE_HASHES)assert.deepEqual(hashes,JSON.parse(fs.readFileSync(process.env.RPCHAT_ROLE_BASELINE_HASHES,'utf8')));
 ok('readers preserve DB and make no model call',()=>{assert(before.equals(db.serialize()));assert.equal(modelCalls,0);});
}finally{await app.close();db.close();fs.rmSync(dir,{recursive:true,force:true});}}
main().catch(err=>{console.error(err);process.exitCode=1;});
