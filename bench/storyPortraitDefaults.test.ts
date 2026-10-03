import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.js';
import { getPath } from '../apps/server/src/db/tree.js';
import { parseSceneCatalog, catalogFromStory } from '../apps/server/src/prompt/sceneCatalog.js';
import { initialBeatScene } from '../apps/server/src/prompt/initScene.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { chatRoutes } from '../apps/server/src/routes/chat.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { ConversationRow, Scene } from '../apps/server/src/types.js';
import type { CastMember } from '../apps/server/src/prompt/cast.js';

let passed=0;
async function t(name:string,fn:()=>void|Promise<void>){await fn();console.log(`ok ${++passed} ${name}`)}
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'rpchat-portrait-default-'));
const db=openMigratedDb(tmp,path.resolve('apps/server/migrations'));
const result=(text:string)=>({text,usage:null,finishReason:'stop' as const,ttftMs:1,totalMs:1});
let modelCalls=0;
const model={complete:async()=>{modelCalls++;return result('null')},stream:async(_p:any,cb:(text:string)=>void)=>{modelCalls++;const s='문이 열렸다.\n나리 | 어서 와.\n세라 | 반가워.';cb(s);return result(s)}};
const ctx={db,model,queue:new GenerationQueue(1),resolvedModel:()=>'mock',effectiveDataDir:tmp}as unknown as Ctx;
const app=Fastify();app.register(characterRoutes(ctx));app.register(storyRoutes(ctx));app.register(conversationRoutes(ctx));app.register(chatRoutes(ctx));
async function api(method:'GET'|'POST'|'PUT',url:string,payload?:object,expected=200){const r=await app.inject({method,url,payload});assert.equal(r.statusCode,expected,`${method} ${url}: ${r.body}`);return r.json()}
const catalog={places:[{id:'교실'}],weathers:['맑음'],outfits:['교복'],emotions:{평온:1,웃음:2},default_emotion:'평온'};
const cast:CastMember[]=[{id:'a',name:'나리',aliases:[],duties:[],place:'교실',role:'main'},{id:'b',name:'세라',aliases:[],duties:[],place:'교실',role:'secondary'}];
function current(id:string){return db.prepare('SELECT * FROM conversations WHERE id=?').get(id)as ConversationRow}
function scene(id:string){return JSON.parse(current(id).scene_json)as Scene}
async function main(){
 await t('reproduction: explicitly authored initial emotion survives parser and starts the roster',()=>{
  const parsed=parseSceneCatalog(JSON.stringify(catalog))as any;assert.equal(parsed.default_emotion,'평온');
  const s=initialBeatScene({catalog:catalogFromStory(JSON.stringify(catalog)),cast});assert.equal(s.roster?.a?.emotion,'평온');assert.equal(s.roster?.b?.emotion,'평온');
 });
 await t('absent default keeps existing scene bytes and never chooses first emotion',()=>{
  const {default_emotion,...old}=catalog;
  const s=initialBeatScene({catalog:catalogFromStory(JSON.stringify(old)),cast});
  assert.deepEqual(s.roster,{a:{outfit:'교복'},b:{outfit:'교복'}});
  const bad=initialBeatScene({catalog:catalogFromStory(JSON.stringify({...old,default_emotion:'없는 표정'})),cast});assert.equal(JSON.stringify(bad),JSON.stringify(s));
 });
 await t('explicit roster overlay remains authoritative including missing emotion',()=>{
  const overlay={roster:{a:{outfit:'교복',emotion:'웃음'},b:{outfit:'교복'}}};
  const s=initialBeatScene({catalog:catalogFromStory(JSON.stringify(catalog)),cast,overlay});assert.deepEqual(s.roster,overlay.roster);
 });
 await t('default without an outfit and solo rooms do not invent image state',()=>{
  const c=catalogFromStory(JSON.stringify({...catalog,outfits:[]}));
  assert.equal(initialBeatScene({catalog:c,cast}).roster,undefined);
  assert.deepEqual(initialBeatScene({catalog:catalogFromStory(JSON.stringify(catalog)),cast:cast.slice(0,1)}),{});
 });
 db.prepare(`INSERT INTO model_profiles(name,temperature,top_p,max_tokens,stop_json,system_mode)VALUES('rp-balanced',0.8,0.95,400,'[]','system')`).run();
 const nari=await api('POST','/api/characters',{name:'나리',first_message:'',tags:['party:place=교실']},201);
 const sera=await api('POST','/api/characters',{name:'세라',first_message:'',tags:['party:place=교실']},201);
 let story:any;
 await t('story POST/GET preserves authored default in stored catalog',async()=>{
  story=await api('POST','/api/stories',{name:'표정 시작',scene_catalog:catalog},201);
  assert.equal(story.scene_catalog.default_emotion,'평온');
  assert.equal((await api('GET',`/api/stories/${story.id}`)).scene_catalog.default_emotion,'평온');
 });
 for(const[sortOrder,c]of[nari,sera].entries())await api('POST',`/api/stories/${story.id}/characters`,{characterId:c.id,sortOrder},201);
 const legacy=await api('POST','/api/conversations',{characterId:nari.id,storyId:story.id,mode:'story',scene:{format:'dialog',roster:{[nari.id]:{outfit:'교복'},[sera.id]:{outfit:'교복'}}}},201);
 const legacyBefore=current(legacy.id).scene_json;
 await t('unknown or malformed default is rejected before DB write',async()=>{
  const stored=(db.prepare('SELECT scene_catalog FROM stories WHERE id=?').get(story.id)as any).scene_catalog;
  for(const value of ['없는 표정','',42,null]){
   await api('PUT',`/api/stories/${story.id}`,{name:'표정 시작',scene_catalog:{...catalog,default_emotion:value}},400);
   assert.equal((db.prepare('SELECT scene_catalog FROM stories WHERE id=?').get(story.id)as any).scene_catalog,stored);
  }
 });
 await t('omission preserves authored catalog, explicit deletion clears only default',async()=>{
  const stored=(db.prepare('SELECT scene_catalog FROM stories WHERE id=?').get(story.id)as any).scene_catalog;
  await api('PUT',`/api/stories/${story.id}`,{name:'표정 시작 (수정)'});assert.equal((db.prepare('SELECT scene_catalog FROM stories WHERE id=?').get(story.id)as any).scene_catalog,stored);
  const{default_emotion,...without}=catalog;const s=await api('PUT',`/api/stories/${story.id}`,{name:'표정 시작',scene_catalog:without});assert.equal(s.scene_catalog.default_emotion,undefined);assert.deepEqual(s.scene_catalog.emotions,catalog.emotions);
  await api('PUT',`/api/stories/${story.id}`,{name:'표정 시작',scene_catalog:catalog});assert.equal(current(legacy.id).scene_json,legacyBefore);
 });
 const room=await api('POST','/api/conversations',{characterId:nari.id,storyId:story.id,mode:'story',scene:{format:'dialog'}},201);
 await t('new room starts declared emotion; existing room and creation make no model call',()=>{
  assert.equal(scene(room.id).roster?.[nari.id]?.emotion,'평온');assert.equal(scene(room.id).roster?.[sera.id]?.emotion,'평온');assert.equal(current(legacy.id).scene_json,legacyBefore);assert.equal(modelCalls,0);
 });
 await t('actual dialog SSE and reconnect retain selected path from authored initial state',async()=>{
  const r=await app.inject({method:'POST',url:`/api/conversations/${room.id}/messages`,payload:{content:'나리, 세라에게도 인사할게'}});assert.equal(r.statusCode,200);assert.match(r.body,/"type":"done"/);
  const lines=getPath(db,current(room.id)).filter(m=>JSON.parse(m.meta_json).block_kind==='line');assert.equal(lines.length,2);
  const got=await api('GET',`/api/conversations/${room.id}`);
  for(const line of lines){const m=JSON.parse(line.meta_json);assert.equal(m.image_url,`/media/assets/${m.speaker_character_id}/${encodeURIComponent('교복')}/1.webp`);assert.equal(got.messages.find((x:any)=>x.id===line.id).meta.image_url,m.image_url);}
 });
}
main().then(()=>console.log(`PASS=${passed}`)).catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await app.close();db.close();fs.rmSync(tmp,{recursive:true,force:true})});
