// npm run test:benches -- sideModeBeatPermission
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.js';
import { insertMessage, setHead, getPath } from '../apps/server/src/db/tree.js';
import { buildSideModePrompt } from '../apps/server/src/prompt/sideModePrompt.js';
import { sanitizeGeneratedContent } from '../apps/server/src/contracts/chatEventAdapter.js';
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
 const room=await create('/api/conversations',{characterId:a.id,storyId:story.id,mode:'story',scene:{format:'beat',observation_filter:true}});
 let leaf=insertMessage(db,room.id,null,'user','PUBLIC_USER_ACTION','complete',{});
 leaf=insertMessage(db,room.id,leaf.id,'assistant','PUBLIC_NARRATION_BANDAGE','complete',{block_kind:'narration'});
 const raw='PUBLIC_F_ACTION_BANDAGE\n"PUBLIC_SPEECH"\n<think>PRIVATE_THINK</think>\n<choices>["PRIVATE_CHOICES"]</choices>\n속마음:PRIVATE_INNER';
 leaf=insertMessage(db,room.id,leaf.id,'assistant',raw,'complete',{block_kind:'line',speaker_character_id:a.id,speaker_name:'Alpha',observation_text:'"PUBLIC_SPEECH"'});db.prepare('UPDATE messages SET content=? WHERE id=?').run(raw,leaf.id);
 leaf=insertMessage(db,room.id,leaf.id,'assistant','NPC_PRIVATE_BODY','complete',{block_kind:'line',observation:{visibility:'private',recipient_ids:['user',a.id],observer_ids:[]}});
 leaf=insertMessage(db,room.id,leaf.id,'assistant','GM_PRIVATE_BODY','complete',{block_kind:'line',observation:{visibility:'private',recipient_ids:['user','gm'],observer_ids:[]}});
 leaf=insertMessage(db,room.id,leaf.id,'assistant','LEGACY_UNCLASSIFIED_ACTION','complete',{block_kind:'narration'});db.prepare('UPDATE messages SET meta_json=? WHERE id=?').run(JSON.stringify({block_kind:'narration'}),leaf.id);setHead(db,room.id,leaf.id);
 const before=db.serialize();
 for(const enabled of [false,true]){
  const conv={...load(room.id),scene_json:JSON.stringify({...JSON.parse(load(room.id).scene_json),observation_filter:enabled})};
  const summary=buildSideModePrompt(db,conv,'summary','',16384);const community=buildSideModePrompt(db,conv,'community','',16384);const gm=JSON.stringify(summary.messages),pub=JSON.stringify(community.messages);
  ok(`beat filter ${enabled}: GM preserves authorized narration and raw action`,()=>{
   for(const s of ['PUBLIC_NARRATION_BANDAGE','PUBLIC_F_ACTION_BANDAGE','PUBLIC_SPEECH','GM_PRIVATE_BODY'])assert(gm.includes(s),s);
   assert.equal(summary.budget.dropped_messages,0);
  });
  ok(`beat filter ${enabled}: public keeps public N and speech proof`,()=>{
   assert(pub.includes('PUBLIC_NARRATION_BANDAGE'));assert(pub.includes('PUBLIC_SPEECH'));assert(!pub.includes('PUBLIC_F_ACTION_BANDAGE'));assert(!pub.includes('GM_PRIVATE_BODY'));
  });
  ok(`beat filter ${enabled}: secrets, controls and classification`,()=>{
   for(const body of [gm,pub]){for(const s of ['NPC_PRIVATE_BODY','PRIVATE_THINK','PRIVATE_CHOICES','PRIVATE_INNER'])assert(!body.includes(s),s);assert.equal(body.includes('LEGACY_UNCLASSIFIED_ACTION'),!enabled);}
  });
 }
 ok('side prompts do not modify main state or data',()=>assert(before.equals(db.serialize())));
 ok('no model adapter calls',()=>assert.equal(modelCalls,0));
}finally{await app.close();db.close();fs.rmSync(dir,{recursive:true,force:true});}}
main().catch(err=>{console.error(err);process.exitCode=1;});
