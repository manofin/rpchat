// npm run test:benches -- sideModeDialogSpeech
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
 const room=await create('/api/conversations',{characterId:a.id,storyId:story.id,mode:'story',scene:{format:'dialog'}});
 let leaf=insertMessage(db,room.id,null,'user','USER_ACTION','complete',{});
 const publicRows=[];
 for(const [i,text] of ['PLAIN_SPEECH_A <think>THINK_CONTROL</think><choices>["CHOICE_CONTROL"]</choices>','PLAIN_SPEECH_B\n속마음:INNER_CONTROL','PLAIN_SPEECH_C'].entries()){
  leaf=insertMessage(db,room.id,leaf.id,'assistant',text,'complete',{block_kind:'line',speaker_character_id:i%2?a.id:b.id,speaker_name:i%2?'Alpha':'Beta'});
  // Legacy imported rows may still contain controls: inspect the real sanitizer too.
  db.prepare('UPDATE messages SET content=? WHERE id=?').run(text,leaf.id);publicRows.push({...leaf,content:text});
 }
 leaf=insertMessage(db,room.id,leaf.id,'assistant','LEGACY_DIALOG_PUBLIC','complete',{block_kind:'line',speaker_character_id:a.id,speaker_name:'Alpha'});
 db.prepare('UPDATE messages SET meta_json=? WHERE id=?').run(JSON.stringify({block_kind:'line',speaker_character_id:a.id,speaker_name:'Alpha'}),leaf.id);
 publicRows.push(leaf);
 leaf=insertMessage(db,room.id,leaf.id,'assistant','NPC_PRIVATE_TEXT','complete',{block_kind:'line',observation:{visibility:'private',recipient_ids:['user',a.id],observer_ids:[]}});
 leaf=insertMessage(db,room.id,leaf.id,'assistant','GM_PRIVATE_TEXT','complete',{block_kind:'line',observation:{visibility:'private',recipient_ids:['user','gm'],observer_ids:[]}});setHead(db,room.id,leaf.id);
 const before=db.serialize();
 const preview=await app.inject({method:'GET',url:`/api/conversations/${room.id}/prompt-preview`});assert.equal(preview.statusCode,200);assert.equal(preview.json().path,'dialog');
 const mainText=preview.json().messages.map((m:any)=>m.content).join('\n');
 for(const enabled of [false,true]){
  const conv={...load(room.id),scene_json:JSON.stringify({...JSON.parse(load(room.id).scene_json),observation_filter:enabled})};
  for(const mode of ['summary','community'] as const){
   const built=buildSideModePrompt(db,conv,mode,'',16384),body=JSON.stringify(built.messages);const history=data(built).history;
   ok(`${mode} filter ${enabled}: public plain speech equals main preview`,()=>{
    const clean=publicRows.map(r=>sanitizeGeneratedContent(r.content).trim());const inMain=clean.filter(s=>mainText.includes(s)).length;const inSide=clean.filter(s=>history.some((m:any)=>m.text.includes(s))).length;
    assert.equal(inMain,4);assert.equal(inSide,inMain);assert.equal(built.budget.dropped_messages,0);
   });
   ok(`${mode} filter ${enabled}: controls and private audience`,()=>{
    for(const s of ['THINK_CONTROL','CHOICE_CONTROL','INNER_CONTROL','NPC_PRIVATE_TEXT'])assert(!body.includes(s),s);
    assert.equal(body.includes('GM_PRIVATE_TEXT'),mode==='summary');
   });
  }
 }
 ok('preview builders preserve all DB state',()=>assert(before.equals(db.serialize())));
 ok('no model adapter calls',()=>assert.equal(modelCalls,0));
}finally{await app.close();db.close();fs.rmSync(dir,{recursive:true,force:true});}}
main().catch(err=>{console.error(err);process.exitCode=1;});
