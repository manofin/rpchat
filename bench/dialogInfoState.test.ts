import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';
import Fastify from 'fastify';
import { savedDialogStateRows } from '../apps/web/src/lib/dialogInfo.js';
import { MessageEvents } from '../apps/web/src/components/EventRenderer.js';
import { renderInfoBlock } from '../apps/server/src/prompt/renderDialog.js';
import { openMigratedDb } from '../apps/server/src/db/index.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { chatRoutes } from '../apps/server/src/routes/chat.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { Message } from '../apps/web/src/types.js';

const sheet={hp:7,money:0,gear:['붕대'],inventory:['빌린 빨간 수첩'],traits:['오른손 기록']};
const expected=[{label:'체력',value:'7'},{label:'소지금',value:'0'},{label:'장비',value:'붕대'},{label:'소지품',value:'빌린 빨간 수첩'},{label:'능력',value:'오른손 기록'}];
const message=(after:any={format:'dialog',user_sheet:sheet}):any=>({role:'assistant',status:'complete',eventVersion:1,events:[{type:'system',id:'info:0',presentation:'info',text:'[정보]: 방문자'}],meta:{block_kind:'info',scene_state:{schema_version:1,before_delta:{format:'dialog',user_sheet:{hp:100}},after_delta:after}}});
let passed=0;async function t(name:string,fn:()=>void|Promise<void>){await fn();console.log(`ok ${++passed} ${name}`)}
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'rpchat-info-display-'));const db=openMigratedDb(tmp,path.resolve('apps/server/migrations'));
const calls:any[]=[];const result=(text:string)=>({text,finishReason:'stop' as const,usage:null,ttftMs:1,totalMs:1});
const model={complete:async(p:any)=>{calls.push(p);return result('null')},stream:async(p:any,cb:any)=>{calls.push(p);const text='창가가 밝다.\n나리 | 확인했어.\n세라 | 여기서 기다릴게.';cb(text);return result(text)}};
const ctx={db,queue:new GenerationQueue(1),model,resolvedModel:()=>'fake',effectiveDataDir:tmp} as unknown as Ctx;const app=Fastify();for(const route of [characterRoutes,storyRoutes,conversationRoutes,chatRoutes])app.register(route(ctx));
async function api(method:any,url:string,payload?:any){const r=await app.inject({method,url,payload});assert.ok(r.statusCode<400,`${r.statusCode} ${r.body}`);return r.json()}
async function main(){
 await t('display reads the successful turn after snapshot, never the before state',()=>assert.deepEqual(savedDialogStateRows(message()),expected));
 await t('zero, null and known-empty have different display values',()=>assert.deepEqual(savedDialogStateRows(message({format:'dialog',user_sheet:{hp:0,money:null,gear:[],inventory:[]}})),[{label:'체력',value:'0'},{label:'소지금',value:'—'},{label:'장비',value:'없음'},{label:'소지품',value:'없음'}]));
 await t('invalid fields are omitted as whole fields, not partially trusted',()=>assert.deepEqual(savedDialogStateRows(message({format:'dialog',user_sheet:{hp:Infinity,money:'10',gear:{},inventory:['ok',42],traits:null}})),[]));
 await t('legacy and unknown snapshot versions have no invented fallback',()=>{for(const raw of [undefined,{},[],{schema_version:2,before_delta:{},after_delta:{format:'dialog',user_sheet:sheet}},{schema_version:1,after_delta:{format:'dialog',user_sheet:sheet}}])assert.deepEqual(savedDialogStateRows({...message(),meta:{block_kind:'info',scene_state:raw}}),[])});
 await t('only complete assistant dialog INFO rows may display the saved sheet',()=>{for(const patch of [{role:'user'},{status:'interrupted'},{status:'streaming'},{meta:{block_kind:'line',scene_state:message().meta.scene_state}}])assert.deepEqual(savedDialogStateRows({...message(),...patch}),[]);assert.deepEqual(savedDialogStateRows(message({format:'beat',user_sheet:sheet})),[])});
 await t('private actor facts and authored extras are not display sources',()=>assert.deepEqual(savedDialogStateRows(message({format:'dialog',user_sheet:sheet,dialog_context:{secret:'PRIVATE_NOT_INFO'},info:{extra:[{label:'체력',value:'999'}]}})),expected));
 await t('state projection does not mutate its message',()=>{const m=message();const before=JSON.stringify(m);savedDialogStateRows(m);assert.equal(JSON.stringify(m),before)});
 await t('historical rows retain their own snapshots across branch and state changes',()=>{const a=message({format:'dialog',user_sheet:{hp:7,inventory:['수첩']}}),b=message({format:'dialog',user_sheet:{hp:5,inventory:[]}});assert.equal(savedDialogStateRows(a)[0].value,'7');assert.equal(savedDialogStateRows(b)[0].value,'5');assert.equal(savedDialogStateRows(a)[1].value,'수첩')});
 await t('only server-stamped confirmed roles enter saved INFO',()=>{const m=message();(m.meta.scene_state as any).confirmed_roles=['방문객 안내'];assert.deepEqual(savedDialogStateRows(m).at(-1),{label:'역할',value:'방문객 안내'});(m.meta.scene_state as any).confirmed_roles=['',42];assert.equal(savedDialogStateRows(m).some(r=>r.label==='역할'),false)});
 await t('common event renderer displays escaped snapshot data',()=>{const html=renderToStaticMarkup(React.createElement(MessageEvents,{message:message({format:'dialog',user_sheet:{inventory:['<script>private()</script>']}})}));assert.ok(html.includes('저장된 사용자 상태'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'))});
 await t('model INFO remains byte-identical even when saved user sheet exists',()=>assert.equal(renderInfoBlock({scene:{format:'dialog',user_sheet:sheet},cast:[],userName:'방문자'}),'[정보]: 방문자\n[계약]: —\n[침식]: —\n[목표]: —\n[인물]: —'));
 await t('actual SSE callback reloads saved snapshots only after successful dialog completion',async()=>{
  const hook=fs.readFileSync('apps/web/src/pages/useChat.ts','utf8');
  const source=ts.createSourceFile('useChat.ts',hook,ts.ScriptTarget.Latest,true);let callback:ts.ArrowFunction|undefined;
  function visit(node:ts.Node):void{if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text==='runStream'){assert.ok(node.initializer&&ts.isCallExpression(node.initializer));const fn=node.initializer.arguments[0];assert.ok(ts.isArrowFunction(fn));callback=fn}ts.forEachChild(node,visit)}visit(source);assert.ok(callback);
  assert.ok(hook.includes("[state.generating, state.detail?.conversation.scene.format, applyEvent"), "loaded conversation format must refresh the memoized streaming callback");
  const compiled=ts.transpileModule(`const runStream=${callback.getText(source)};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  for(const [format,type,status,expectedReload]of [['dialog','done','complete',1],['beat','done','complete',0],['dialog','done','interrupted',0],['dialog','token','complete',0]]as const){
   let reloads=0;const received:any[]=[];const scope={revision:0};const abortRef:{current:AbortController|null}={current:null};const event:any={type,message:{status},text:'x'};
   const deps={state:{generating:false,detail:{conversation:{scene:{format}}}},scope,scopeRef:{current:scope},abortRef,genIdRef:{current:null},AbortController,setStreamConnected:()=>{},patchState:()=>{},applyEvent:(e:any)=>received.push(e),streamPost:async(_p:any,_b:any,cb:any)=>cb(event),reload:async()=>{assert.equal(abortRef.current,null);reloads++;return{messages:[]}}};
   const run=new Function(...Object.keys(deps),`${compiled}return runStream;`)(...Object.values(deps));assert.equal(await run('/fixture',{}),true);assert.deepEqual(received,[event]);assert.equal(reloads,expectedReload);
  }
 });
 db.prepare(`INSERT INTO model_profiles(name,temperature,top_p,max_tokens,stop_json,system_mode)VALUES('rp-balanced',.8,.95,400,'[]','system')`).run();
 const a=await api('POST','/api/characters',{name:'나리',first_message:'',tags:['party:place=전시장']}),b=await api('POST','/api/characters',{name:'세라',first_message:'',tags:['party:place=전시장']});
 const story=await api('POST','/api/stories',{name:'화면 상태',scene_catalog:{places:[{id:'전시장'}]}});for(const[sortOrder,c]of[a,b].entries())await api('POST',`/api/stories/${story.id}/characters`,{characterId:c.id,sortOrder});
 const room=await api('POST','/api/conversations',{characterId:a.id,storyId:story.id,mode:'story',scene:{format:'dialog',user_sheet:sheet}});
 await t('real HTTP dialog path stamps display state without expanding the model INFO',async()=>{const r=await app.inject({method:'POST',url:`/api/conversations/${room.id}/messages`,payload:{content:'나리, 확인할게'}});assert.equal(r.statusCode,200);assert.ok(r.body.includes('"type":"done"'));const detail=await api('GET',`/api/conversations/${room.id}`);const info=detail.messages.find((m:any)=>m.meta.block_kind==='info');assert.deepEqual(savedDialogStateRows(info),expected);assert.ok(!info.content.includes('[체력]'));assert.ok(calls.every(p=>!JSON.stringify(p.messages).includes('[소지금]:')));const html=renderToStaticMarkup(React.createElement(MessageEvents,{message:info as Message}));assert.ok(html.includes('빌린 빨간 수첩'));assert.ok(html.includes('소지금'));assert.equal(calls.length,2)});
}
main().finally(async()=>{await app.close();db.close();fs.rmSync(tmp,{recursive:true,force:true})}).catch(e=>{console.error(e);process.exitCode=1});
