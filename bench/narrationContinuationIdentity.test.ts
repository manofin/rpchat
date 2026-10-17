/** npm run test:benches -- narrationContinuationIdentity
 * Synthetic fixed IDs, temporary SQLite, real continuation route, mock model only.
 * Request provenance/bytes are contracts; this does not score narrative quality.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { openMigratedDb, one, run } from '../apps/server/src/db/index.js';
import { getPath, parseMessageMeta, setHead } from '../apps/server/src/db/tree.js';
import { buildSceneSnapshot } from '../apps/server/src/db/sceneBase.js';
import { buildContinuation, continuationRoutes } from '../apps/server/src/routes/continuation.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { config } from '../apps/server/src/config.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { ConversationRow, MessageMeta, Scene } from '../apps/server/src/types.js';
import type { GenParams } from '../apps/server/src/model/adapter.js';

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-n-continuation-'));
  const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
  const calls: GenParams[] = [];
  const previousContext = config.model.contextTokens;
  config.model.contextTokens = 16384;
  const ctx = { db, queue: new GenerationQueue(1), resolvedModel: () => 'mock', log: { warn() {}, error() {} }, model: {
    stream: async (p: GenParams, token: (s: string) => void) => {
      calls.push(p);token('창문이 조용히 흔들렸다.');
      return { text: '창문이 조용히 흔들렸다.', finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 };
    },
  } } as unknown as Ctx;
  const app = Fastify();app.register(continuationRoutes(ctx));
  const stamp = '2026-01-01T00:00:00Z';
  run(db, "INSERT INTO model_profiles(name,max_tokens) VALUES ('rp-balanced',500)");
  for (const [id, name] of [['a', 'Mira Vale'], ['b', '가람']]) {
    run(db, 'INSERT INTO characters(id,name,created_at,updated_at) VALUES (?,?,?,?)', id, name, stamp, stamp);
  }
  run(db, "INSERT INTO personas(id,name,created_at,updated_at) VALUES ('player','플레이어 하나',?,?)", stamp, stamp);
  run(db, "INSERT INTO stories(id,name,scene_catalog,created_at,updated_at) VALUES ('story','합성 장면',?, ?, ?)", JSON.stringify({places:[{id:'room',name:'교실'}]}),stamp,stamp);
  for (const [i,id] of ['a','b'].entries()) run(db, "INSERT INTO story_characters(story_id,character_id,sort_order) VALUES ('story',?,?)",id,i);
  const conv = (id: string) => one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id=?',id)!;
  const fixture = (id: string, mode: 'solo'|'line'|'dialog'|'narration' = 'narration', enabled = true) => {
    const scene: Scene = { format: mode==='dialog'?'dialog':'beat', present_ids:['a','b'], location:'room', observation_filter: enabled, scene_version:1 };
    run(db, `INSERT INTO conversations(id,character_id,persona_id,mode,story_id,story_participant_ids_snapshot,scene_json,prompt_version,created_at,updated_at)
      VALUES (?,'a','player',?,?,?,?, 'fixture',?,?)`,id,mode==='solo'?'chat':'story',mode==='solo'?null:'story',mode==='solo'?null:'["a","b"]',JSON.stringify(scene),stamp,stamp);
    let parent: string | null = null;
    const add = (key: string, role: 'user'|'assistant', content: string, meta: MessageMeta = {}) => {
      const rowId = `${id}-${key}`;
      run(db, 'INSERT INTO messages(id,conversation_id,parent_id,role,content,status,meta_json,created_at) VALUES (?,?,?,?,?,\'complete\',?,?)',rowId,id,parent,role,content,
        JSON.stringify({ generation_id: id, observation:{visibility:'public'}, ...meta }),stamp);
      parent=rowId;setHead(db,id,rowId);return rowId;
    };
    add('old-user','user','OLD_USER_PROMISE');
    add('old-narration','assistant','OLD_NARRATION',{block_kind:'narration'});
    add('line','assistant','"NPC_REPLY"',{block_kind:'line',speaker_character_id:'a',speaker_name:'Mira Vale'});
    add('legacy','assistant','LEGACY_UNKNOWN');
    add('user','user','PLAYER_WRIST_INPUT');
    const target = add('target','assistant','TARGET_ALREADY_SHOWN',mode==='solo'?{}:{
      block_kind:mode==='narration'?'narration':'line',
      ...(mode==='narration'?{}:{speaker_character_id:'a',speaker_name:'Mira Vale'}),
      beat_seq:0,scene_state:buildSceneSnapshot(scene,scene),
    });
    return {id,target,scene,add};
  };
  const build = (id:string) => buildContinuation(ctx,conv(id),getPath(db,conv(id)));
  const prompt = (id:string) => build(id).messages.map(m=>m.content).join('\n');
  const sha = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  let checks=0;
  const test=async(name:string,fn:()=>void|Promise<void>)=>{await fn();console.log(`ok ${++checks} ${name}`);};
  try {
    const bytes: Record<string,string> = {};
    for(const mode of ['solo','line','dialog'] as const) {
      const f=fixture(`bytes-${mode}`,mode,false);const b=build(f.id);
      bytes[mode]=sha({messages:b.messages,maxTokens:b.maxTokens,temperature:b.temperature,topP:b.topP,stop:b.stop});
    }
    const artifact=process.env.RPCHAT_BENCH_ARTIFACT_DIR;
    if(artifact) {fs.mkdirSync(artifact,{recursive:true});fs.writeFileSync(path.join(artifact,'unchanged-request-bytes.json'),JSON.stringify(bytes,null,2)+'\n');}
    await test('solo, F and dialog continuation request bytes match the unchanged baseline (originally captured at 775a41d)',()=>{
      assert.deepEqual(bytes, {
        solo:'9e17ea886b2bf72175326fc120718c36c267f9c08d2d23ecb97af0878489aadd',
        line:'c8ac7a8102c021c9d544ca849c877a3882b105421cd7aa2e68c9683c6e1dd43a',
        dialog:'4732758608fd3fa950be8834b5b6603332e3517d381119f5e1aa65a564e7f538',
      });
    });
    await test('narration continuation preserves persona and stored user/NPC/narrator sources',()=>{
      const f=fixture('identity');const p=prompt(f.id);
      assert.ok(p.includes("'플레이어 하나'은 사용자다."));
      assert.ok(p.includes('## 현재 사용자 발화\n[사용자: 플레이어 하나] PLAYER_WRIST_INPUT'));
      assert.ok(p.includes('[사용자] OLD_USER_PROMISE'));
      assert.ok(p.includes('[Mira Vale] "NPC_REPLY"'));
      assert.ok(p.includes('[서술자] OLD_NARRATION'));
      assert.ok(p.includes('[화자 미상] LEGACY_UNKNOWN'));
      assert.ok(p.includes('[서술자] TARGET_ALREADY_SHOWN'));
      const userSection=p.split('## 현재 사용자 발화\n')[1].split('\n\n')[0];
      assert.ok(!userSection.includes('TARGET_ALREADY_SHOWN') && !userSection.includes('직전 응답'));
    });
    await test('private nonrecipient bodies and observer speaker identity are filtered before attribution',()=>{
      const f=fixture('private');
      const update=(key:string,audience:object,name='HIDDEN_SPEAKER')=>run(db,'UPDATE messages SET content=?,meta_json=? WHERE id=?','SECRET_'+key,JSON.stringify({generation_id:f.id,block_kind:'line',speaker_name:name,observation:audience}),`${f.id}-${key}`);
      update('line',{visibility:'private',recipient_ids:['a'],observer_ids:[]});
      update('legacy',{visibility:'private',recipient_ids:['a'],observer_ids:['gm']});
      const p=prompt(f.id);
      for(const secret of ['SECRET_line','SECRET_legacy','HIDDEN_SPEAKER']) assert.ok(!p.includes(secret),secret);
      assert.ok(p.includes('[화자 미상] [비공개 대화가 있었다.]'));
    });
    await test('missing persona falls back to 나; legacy author remains unknown',()=>{
      const f=fixture('legacy', 'narration',false);run(db,'UPDATE conversations SET persona_id=NULL WHERE id=?',f.id);
      assert.ok(prompt(f.id).includes('[사용자: 나] PLAYER_WRIST_INPUT'));
      assert.ok(prompt(f.id).includes('[화자 미상] LEGACY_UNKNOWN'));
      run(db,'UPDATE conversations SET scene_json=? WHERE id=?',JSON.stringify({format:'beat'}),f.id);
      assert.ok(!prompt(f.id).includes('## 현재 장면 (서버 상태)\nnull'));
    });
    await test('a hidden current input does not promote an older user utterance to current',()=>{
      const f=fixture('hidden-current');
      run(db,'UPDATE messages SET meta_json=? WHERE id=?',JSON.stringify({generation_id:f.id,observation:{visibility:'private',recipient_ids:['a'],observer_ids:['gm']}}),`${f.id}-user`);
      const p=prompt(f.id);const current=p.split('## 현재 사용자 발화\n')[1].split('\n\n')[0];
      assert.ok(!p.includes('PLAYER_WRIST_INPUT'));
      assert.ok(!current.includes('OLD_USER_PROMISE'));
      assert.ok(p.includes('[사용자] OLD_USER_PROMISE'));
      assert.ok(p.includes('[화자 미상] [비공개 대화가 있었다.]'));
    });
    await test('non-prose blocks and model control tags cannot become narration history',()=>{
      const f=fixture('hidden-blocks');
      run(db,'UPDATE messages SET content=?,meta_json=? WHERE id=?','THOUGHT_SHOULD_NOT_BE_CONTEXT',JSON.stringify({generation_id:f.id,block_kind:'thought',observation:{visibility:'public'}}),`${f.id}-legacy`);
      run(db,'UPDATE messages SET content=? WHERE id=?','OLD_NARRATION<think>CONTROL_SECRET</think>',`${f.id}-old-narration`);
      const p=prompt(f.id);
      assert.ok(!p.includes('THOUGHT_SHOULD_NOT_BE_CONTEXT'));
      assert.ok(!p.includes('CONTROL_SECRET'));
      assert.ok(p.includes('[서술자] OLD_NARRATION'));
    });
    await test('duplicate display names do not infer a speaker for legacy or malformed metadata',()=>{
      const f=fixture('duplicate-names', 'narration',false);
      run(db,"UPDATE characters SET name='같은 이름' WHERE id IN ('a','b')");
      run(db,'UPDATE messages SET content=?,meta_json=? WHERE id=?','UNKNOWN_SOURCE','{broken',`${f.id}-legacy`);
      run(db,'UPDATE messages SET meta_json=? WHERE id=?',JSON.stringify({generation_id:f.id,block_kind:'line',speaker_character_id:'b',observation:{visibility:'public'}}),`${f.id}-line`);
      const p=prompt(f.id);
      assert.ok(p.includes('[같은 이름] "NPC_REPLY"'));
      assert.ok(p.includes('[화자 미상] UNKNOWN_SOURCE'));
      run(db,"UPDATE characters SET name='Mira Vale' WHERE id='a'");
      run(db,"UPDATE characters SET name='가람' WHERE id='b'");
    });
    await test('failed historical rows do not become authorized narrator observations',()=>{
      const f=fixture('failed-history');
      run(db,"UPDATE messages SET status='error',content='FAILED_PRIVATE_CANARY' WHERE id=?",`${f.id}-line`);
      assert.ok(!prompt(f.id).includes('FAILED_PRIVATE_CANARY'));
      assert.ok(prompt(f.id).includes('[서술자] TARGET_ALREADY_SHOWN'));
    });
    await test('budget pressure drops whole history and retains the continuation target',()=>{
      const f=fixture('budget');run(db,'UPDATE messages SET content=? WHERE id=?','OLD_TOO_LARGE_'+'가'.repeat(30000),`${f.id}-old-user`);
      const b=build(f.id);const p=b.messages[0].content;
      assert.ok(b.budget.dropped_messages>0);
      assert.ok(b.budget.est_total<=b.budget.available);
      assert.ok(!p.includes('OLD_TOO_LARGE_'));assert.ok(p.includes('TARGET_ALREADY_SHOWN'));
      run(db,'UPDATE messages SET content=? WHERE id=?','CURRENT_TOO_LARGE_'+'가'.repeat(30000),`${f.id}-user`);
      const reduced=build(f.id);
      assert.ok(reduced.budget.est_total<=reduced.budget.available);
      assert.ok(!reduced.messages[0].content.includes('CURRENT_TOO_LARGE_'));
      assert.ok(reduced.messages[0].content.includes('TARGET_ALREADY_SHOWN'));
    });
    await test('oversized mandatory narration is rejected before model calls or message writes',async()=>{
      const f=fixture('overflow');run(db,'UPDATE messages SET content=? WHERE id=?','가'.repeat(30000),f.target);
      const count=calls.length;const before=db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY id').all(f.id);
      const r=await app.inject({method:'POST',url:`/api/conversations/${f.id}/continue`,payload:{messageId:f.target}});
      assert.equal(r.statusCode,422,r.body);assert.equal(calls.length,count);
      assert.deepEqual(db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY id').all(f.id),before);
      assert.equal(conv(f.id).head_message_id,f.target);
    });
    await test('real /continue route uses the same labeled request and does not add user rows',async()=>{
      const f=fixture('route');const before=conv(f.id).scene_json;
      const expected=build(f.id).messages;
      const count=db.prepare("SELECT count(*) n FROM messages WHERE conversation_id=? AND role='user'").get(f.id);
      const r=await app.inject({method:'POST',url:`/api/conversations/${f.id}/continue`,payload:{messageId:f.target}});
      assert.equal(r.statusCode,200,r.body);assert.match(r.body,/"type":"done"/);
      assert.deepEqual(calls.at(-1)!.messages,expected);
      assert.equal(conv(f.id).scene_json,before);
      assert.deepEqual(db.prepare("SELECT count(*) n FROM messages WHERE conversation_id=? AND role='user'").get(f.id),count);
      assert.equal(parseMessageMeta(getPath(db,conv(f.id)).at(-1)!.meta_json).block_kind,'narration');
    });
  } finally {config.model.contextTokens=previousContext;await app.close();db.close();fs.rmSync(tmp,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
