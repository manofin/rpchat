/** npm run test:benches -- turnDeadlineRecovery
 * Real routes, temporary SQLite and mock adapters/timers only. No model/network/live DB.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { TurnDeadline } from '../apps/server/src/model/turnDeadline.js';
import { config } from '../apps/server/src/config.js';
import { insertMessage, setHead } from '../apps/server/src/db/tree.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { chatRoutes } from '../apps/server/src/routes/chat.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { GenParams } from '../apps/server/src/model/adapter.js';

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-deadline-recovery-'));
  const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
  db.prepare("INSERT INTO model_profiles(name,temperature,top_p,max_tokens,stop_json,system_mode) VALUES ('rp-balanced',0.8,0.95,500,'[]','system')").run();
  const queue = new GenerationQueue(1);
  const result = (text: string) => ({text, finishReason:'stop', usage:null, ttftMs:1, totalMs:1});
  let hang: {release?: () => void; lateToken?: () => void; reject?: boolean} | null = null;
  const warnings: unknown[] = [];
  const model = {
    complete: async (p: GenParams) => {
      const text = p.messages.map(m=>m.content).join('\n');
      return result(text.includes('장면 진행 판정기') ? 'null'
        : text.includes('입력 초안만 쓴다') ? '<choices>["기다린다"]</choices>'
        : text.startsWith('너는 장면 서술자다') ? '바람이 창문을 흔든다.' : '"알겠어."');
    },
    stream: async (_p: GenParams, token: (text:string)=>void) => {
      const held = hang;
      if (held) {
        held.lateToken = () => token('LATE_OLD_TOKEN');
        await new Promise<void>(resolve=>{held.release=resolve;});
        if (held.reject) throw new Error('late old adapter failure');
      }
      token('나리 | 알겠어.');
      return result('나리 | 알겠어.');
    },
  };
  const ctx = {db,queue,model,resolvedModel:()=> 'mock',log:{warn:(x:unknown)=>warnings.push(x),error(){},info(){},debug(){}}} as unknown as Ctx;
  const app = Fastify();
  for (const routes of [characterRoutes,storyRoutes,conversationRoutes,chatRoutes]) app.register(routes(ctx));
  const post = (url:string,payload:object) => app.inject({method:'POST',url,payload});
  const api = async(url:string,payload:object) => {const r=await post(url,payload);assert.ok(r.statusCode<400,r.body);return r.json();};
  const actor=await api('/api/characters',{name:'나리',first_message:'',tags:['party:place=교실']});
  const other=await api('/api/characters',{name:'세라',first_message:'',tags:['party:place=교실']});
  const story=await api('/api/stories',{name:'deadline fixture',setting:'교실',scene_catalog:{places:[{id:'교실'}]}});
  for (const [i,c] of [actor,other].entries()) await api(`/api/stories/${story.id}/characters`,{characterId:c.id,sortOrder:i});
  const snapshot = (id:string) => ({
    conversation:db.prepare('SELECT head_message_id, scene_json FROM conversations WHERE id=?').get(id),
    messages:db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY id').all(id),
  });
  const head = (id:string) => (snapshot(id).conversation as {head_message_id:string}).head_message_id;
  const logCount = (id:string) => (db.prepare('SELECT count(*) AS n FROM generation_log WHERE conversation_id=?').get(id) as {n:number}).n;
  const spin = async(predicate:()=>boolean) => {
    for(let i=0;i<100&&!predicate();i++) await new Promise(r=>setImmediate(r));
    assert.ok(predicate(),'async route reached expected phase');
  };
  const room = async(format:'beat'|'dialog') => {
    const c=await api('/api/conversations',{characterId:actor.id,storyId:story.id,mode:'story',scene:{format,location:'교실',present_ids:[actor.id,other.id]}});
    const r=await post(`/api/conversations/${c.id}/messages`,{content:'나리, 인사해.'});
    assert.match(r.body,/"type":"done"/); assert.doesNotMatch(r.body,/"type":"error"/);
    return c.id as string;
  };
  let checks=0;
  const test=async(name:string,fn:()=>void|Promise<void>)=>{await fn();console.log(`ok ${++checks} ${name}`);};
  try {
    for(const format of ['beat','dialog'] as const) {
      await test(`${format}: queued deadline reclaims input/head and returns typed error plus telemetry`,async()=>{
        const id=await room(format), before=snapshot(id), logs=logCount(id);
        let release!:()=>void;
        const held=queue.run(()=>new Promise<void>(r=>{release=r;}));
        const pending=post(`/api/conversations/${id}/messages`,{content:'나리, 큐 대기.'});
        try {
          await spin(()=>queue.queued>0);
          queue.activeList.find(g=>g.conversationId===id)!.turnDeadline!.tripDeadline();
          const r=await pending;
          assert.equal(r.statusCode,504,r.body);
          assert.equal(r.json().code,'turn_deadline_exceeded');
          assert.deepEqual(snapshot(id),before);
          assert.equal(logCount(id),logs+1);
          const log=db.prepare('SELECT * FROM generation_log WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1').get(id) as any;
          assert.equal(JSON.parse(log.budget_json).turn_deadline.termination,'turn_deadline_exceeded');
          assert.equal(queue.activeList.some(g=>g.conversationId===id),false);
        } finally {release();await held;await pending;}
      });
      for(const lateReject of [false,true]) await test(`${format}: expired request ends before adapter; late ${lateReject?'error':'tokens/result'} cannot erase next turn`,async()=>{
        const id=await room(format), before=snapshot(id);
        const old=hang={reject:lateReject};
        let settled=false;
        mock.timers.enable({apis:['setTimeout']});
        const pending=post(`/api/conversations/${id}/messages`,{content:'나리, 첫 턴.'}).then(r=>{settled=true;return r;});
        try {
          await spin(()=>Boolean(old.release));
          const active=queue.activeList.find(g=>g.conversationId===id)!;
          active.turnDeadline!.tripDeadline();
          await spin(()=>settled);
          const r=await pending;
          assert.match(r.body,/"code":"turn_deadline_exceeded"/);
          assert.deepEqual(snapshot(id),before);
          assert.ok(queue.activeList.some(g=>g.id===active.id),'adapter still holds queue');
          const refused=await post(`/api/conversations/${id}/messages`,{content:'나리, 아직 대기.'});
          assert.equal(refused.statusCode,409);
          mock.timers.tick(5000);
          assert.equal(queue.activeList.some(g=>g.id===active.id),false);
          assert.ok(warnings.some(w=>JSON.stringify(w).includes('generation_force_queue_release')));
          hang=null;
          const next=await post(`/api/conversations/${id}/messages`,{content:'나리, 새 턴.'});
          assert.match(next.body,/"type":"done"/);assert.doesNotMatch(next.body,/"type":"error"/);
          const completed=snapshot(id), completedLogs=logCount(id);
          old.lateToken!();old.release!();
          for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r));
          assert.deepEqual(snapshot(id),completed,'old cleanup/tokens cannot mutate the completed turn');
          assert.equal(logCount(id),completedLogs,'old route must not terminate/log twice');
        } finally {hang=null;old.release?.();await pending;mock.timers.reset();}
      });
      await test(`${format}: regeneration deadline preserves old answer/head without partial rows`,async()=>{
        const id=await room(format), before=snapshot(id);
        const old=hang={};
        const pending=post(`/api/conversations/${id}/regenerate`,{messageId:head(id)});
        try {
          await spin(()=>Boolean(old.release));
          queue.activeList.find(g=>g.conversationId===id)!.turnDeadline!.tripDeadline();
          old.release!();
          const r=await pending;
          assert.match(r.body,/"code":"turn_deadline_exceeded"/);
          assert.deepEqual(snapshot(id),before);
        } finally {hang=null;old.release?.();await pending;}
      });
      await test(`${format}: adapter settling before grace frees queue immediately`,async()=>{
        const id=await room(format), before=snapshot(id);
        const old=hang={};let settled=false;
        const pending=post(`/api/conversations/${id}/messages`,{content:'나리, 짧은 중단.'}).then(r=>{settled=true;return r;});
        try {
          await spin(()=>Boolean(old.release));
          queue.activeList.find(g=>g.conversationId===id)!.turnDeadline!.tripDeadline();
          await spin(()=>settled);
          assert.deepEqual(snapshot(id),before);
          old.release!();await spin(()=>!queue.activeList.some(g=>g.conversationId===id));
        } finally {hang=null;old.release?.();await pending;}
      });
      await test(`${format}: required model timeout ends request before an abort-ignoring adapter`,async()=>{
        const id=await room(format), before=snapshot(id), previous=config.model.timeoutMs;
        const old=hang={};let settled=false;
        config.model.timeoutMs=1000;
        mock.timers.enable({apis:['setTimeout']});
        const pending=post(`/api/conversations/${id}/messages`,{content:'나리, 모델 제한.'}).then(r=>{settled=true;return r;});
        try {
          await spin(()=>Boolean(old.release));
          mock.timers.tick(1000);await spin(()=>settled);
          assert.match((await pending).body,/"code":"model_timeout"/);
          assert.deepEqual(snapshot(id),before);
          assert.ok(queue.activeList.some(g=>g.conversationId===id));
          old.lateToken!();old.release!();
          await spin(()=>!queue.activeList.some(g=>g.conversationId===id));
          assert.deepEqual(snapshot(id),before,'expired result cannot commit');
        } finally {hang=null;old.release?.();await pending;mock.timers.reset();config.model.timeoutMs=previous;}
      });
      await test(`${format}: cleanup refuses foreign descendants instead of cascading deletion`,async()=>{
        const id=await room(format), old=hang={};
        const pending=post(`/api/conversations/${id}/messages`,{content:'나리, 소유 범위.'});
        try {
          await spin(()=>Boolean(old.release));
          const active=queue.activeList.find(g=>g.conversationId===id)!;
          const foreign=insertMessage(db,id,head(id),'user','foreign descendant','complete');
          setHead(db,id,foreign.id);
          active.turnDeadline!.tripDeadline();await pending;
          assert.equal(head(id),foreign.id,'never restore over another writer');
          assert.ok(db.prepare('SELECT id FROM messages WHERE id=?').get(foreign.id));
          old.release!();await spin(()=>!queue.activeList.some(g=>g.id===active.id));
          assert.equal(head(id),foreign.id);
        } finally {hang=null;old.release?.();await pending;}
      });
    }
    await test('commit rejects a changed head even when scene version matches',()=>{
      const t=new TurnDeadline({deadlineMs:120000,controller:new AbortController()});
      try {assert.equal(t.tryEnterCommit({sceneVersionAtStart:3,currentSceneVersion:3,expectedHead:'own',currentHead:'other'}),false);}
      finally {t.dispose();}
    });
    await test('commit boundary checks elapsed budget even before timer dispatch',()=>{
      let now=0;
      const t=new TurnDeadline({deadlineMs:100,controller:new AbortController(),now:()=>now});
      try {t.start();now=101;assert.equal(t.remainingMs(),0);assert.equal(t.tryEnterCommit({sceneVersionAtStart:0,currentSceneVersion:0}),false);assert.equal(t.termination,'turn_deadline_exceeded');}
      finally {t.dispose();}
    });
    await test('wall clock jumps do not change monotonic remaining budget',()=>{
      mock.timers.enable({apis:['Date'],now:1000000});
      const t=new TurnDeadline({deadlineMs:120000,controller:new AbortController()});
      try {mock.timers.setTime(999999999);assert.ok(t.remainingMs()>119000);mock.timers.setTime(0);assert.ok(t.remainingMs()>119000);}
      finally {t.dispose();mock.timers.reset();}
    });
  } finally {await app.close();db.close();fs.rmSync(tmp,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
