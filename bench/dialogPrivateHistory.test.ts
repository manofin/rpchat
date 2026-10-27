import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { openMigratedDb, one, run } from '../apps/server/src/db/index.js';
import { getPath, insertMessage, setHead } from '../apps/server/src/db/tree.js';
import { buildDialogPrompt, dialogHistory } from '../apps/server/src/prompt/dialogPrompt.js';
import { ModelClient } from '../apps/server/src/model/adapter.js';
import type { ConversationRow, MessageRow } from '../apps/server/src/types.js';

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dialog-private-history-'));
const db=openMigratedDb(tmp,path.resolve('apps/server/migrations'));
const PRIVATE_USER='PRIVATE_USER_HISTORY_CANARY';
const PRIVATE_ACTOR='PRIVATE_ACTOR_HISTORY_CANARY';
const PUBLIC_USER='PUBLIC_USER_HISTORY_CONTROL';
let checks=0;
function check(name:string, fn:()=>void){fn();console.log(`ok ${++checks} ${name}`);}
const server=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;
  captured=JSON.parse(raw);
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.end('data: '+JSON.stringify({choices:[{delta:{content:'공개 응답'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
});
let captured:any=null;
async function main() {
try {
  run(db,'INSERT INTO characters(id,name,created_at,updated_at) VALUES(?,?,?,?)','a','나리','2026','2026');
  run(db,'INSERT INTO conversations(id,character_id,profile_name,prompt_version,title,scene_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    'room','a','default','test','합성 기존 기록','{"format":"dialog"}','2026','2026');
  let parent:string|null=null;
  function add(role:'user'|'assistant',content:string,observation:any,extra:any={}){
    const m=insertMessage(db,'room',parent,role,content,'complete');parent=m.id;
    run(db,'UPDATE messages SET meta_json=? WHERE id=?',JSON.stringify({block_kind:role==='assistant'?'line':undefined,speaker_name:role==='assistant'?'나리':undefined,observation,...extra}),m.id);
    setHead(db,'room',m.id);return m.id;
  }
  const publicId=add('user',PUBLIC_USER,{visibility:'public'});
  const privateId=add('user',PRIVATE_USER,{visibility:'private',recipient_ids:['user','a'],observer_ids:[]});
  add('assistant',PRIVATE_ACTOR,{visibility:'private',recipient_ids:['user','a'],observer_ids:[]});
  const publicAnswer=add('assistant','공개: 시계는 정오를 가리킨다.',{visibility:'public'});
  add('user','다음 공개 장면으로 진행한다.',{visibility:'public'});
  const conv=one<ConversationRow>(db,'SELECT * FROM conversations WHERE id=?','room')!;
  const rows=getPath(db,conv);const original=JSON.stringify(rows);
  check('public history excludes a historical private user message',()=>{
    const selected=dialogHistory(db,rows);assert.ok(!selected.some(m=>m.id===privateId));assert.ok(selected.some(m=>m.id===publicId));
  });
  check('private actor history remains excluded and public answer remains readable',()=>{
    const selected=dialogHistory(db,rows);assert.ok(!selected.some(m=>m.content.includes(PRIVATE_ACTOR)));assert.ok(selected.some(m=>m.id===publicAnswer));
  });
  check('explicit private-history selection retains authorized original rows',()=>{
    const selected=dialogHistory(db,rows,{includePrivate:true});assert.ok(selected.some(m=>m.content===PRIVATE_USER));assert.ok(selected.some(m=>m.content.includes(PRIVATE_ACTOR)));
  });
  check('projection does not delete or rewrite stored private rows',()=>{
    assert.equal(JSON.stringify(getPath(db,conv)),original);assert.equal(one<MessageRow>(db,'SELECT * FROM messages WHERE id=?',privateId)?.content,PRIVATE_USER);
  });
  const row=(id:string,role:'user'|'assistant',content:string,meta:any={})=>({...rows[0],id,role,content,meta_json:JSON.stringify(meta)});
  check('private OOC user preserves the existing suppression of its assistant reply',()=>{
    const selected=dialogHistory(db,[row('ooc','user','(OOC) 설정 확인',{ooc:true,observation:{visibility:'private',recipient_ids:['user','a'],observer_ids:[]}}),row('reply','assistant','OOC_ONLY'),row('next','user','공개 본문')]);
    assert.deepEqual(selected.map(m=>m.id),['next']);
  });
  check('an IC private turn resets prior OOC state without exposing its input',()=>{
    const selected=dialogHistory(db,[row('ooc','user','(OOC) 설정 확인',{ooc:true}),row('private','user',PRIVATE_USER,{observation:{visibility:'private',recipient_ids:['user','a'],observer_ids:[]}}),row('public','assistant','허용된 공개 기록',{observation:{visibility:'public'}})]);
    assert.deepEqual(selected.map(m=>m.id),['public']);
  });
  check('legacy unlabelled ordinary history keeps its existing projection',()=>{
    const selected=dialogHistory(db,[row('legacy-u','user','기존 사용자 기록'),row('legacy-a','assistant','기존 응답',{speaker_name:'나리'})]);
    assert.deepEqual(selected.map(m=>m.content),['기존 사용자 기록','나리 | 기존 응답']);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const model=new ModelClient(`http://127.0.0.1:${address.port}/v1`,'',5000,tmp);
  const prompt=buildDialogPrompt(db,conv,rows,'공개 대본','다음 공개 장면으로 진행한다.',8192,'loopback-only');
  await model.complete({model:prompt.model,messages:prompt.messages,max_tokens:32});
  check('actual outgoing HTTP excludes both secrets and retains public history and current input',()=>{
    assert.ok(captured);const body=captured.messages.map((m:any)=>m.content).join('\n');
    assert.ok(!body.includes(PRIVATE_USER));assert.ok(!body.includes(PRIVATE_ACTOR));assert.ok(body.includes(PUBLIC_USER));assert.ok(body.includes('다음 공개 장면으로 진행한다.'));
  });
  console.log(`PASSED ${checks} checks`);
} finally {
  await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});
  db.close();fs.rmSync(tmp,{recursive:true,force:true});
}

}
main().catch(error=>{console.error(error);process.exitCode=1;});
