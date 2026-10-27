import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.js';
import { insertMessage, setHead, getPath } from '../apps/server/src/db/tree.js';
import { memoryRoutes } from '../apps/server/src/routes/memory.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { provenanceReader } from '../apps/server/src/memory/provenance.js';
import { buildPrompt } from '../apps/server/src/prompt/builder.js';
import { fixtureProvenance } from './helpers/derivedProvenanceFixture.js';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rollup-audit-'));
const db=openMigratedDb(dir,path.resolve('apps/server/migrations'));
const results:any[]=[];
async function main(){
try {
 db.exec("INSERT INTO characters(id,name,created_at,updated_at) VALUES('a','A','2026','2026')");
 for(const kind of ['broaden','narrow']) {
  const app=Fastify();const id='room-'+kind;
  db.prepare("INSERT INTO conversations(id,character_id,profile_name,prompt_version,scene_json,created_at,updated_at) VALUES(?,'a','default','test','{}','2026','2026')").run(id);
  const old={visibility:'private',recipient_ids:['user','a'],observer_ids:[]};
  const after=kind==='broaden'?{visibility:'public'}:{visibility:'private',recipient_ids:['user'],observer_ids:[]};
  const m=insertMessage(db,id,null,'user','PRIVATE_SOURCE','complete',{observation:old} as any);setHead(db,id,m.id);
  const sid='scene-'+kind;
  db.prepare("INSERT INTO summaries(id,conversation_id,content,status,tier,covers_until_message_id,created_at) VALUES(?,?,'PRIVATE_SCENE','approved','scene',?,'2026')").run(sid,id,m.id);
  fixtureProvenance(db,'summary',sid,[m.id]);
  let calls=0;
  await app.register(memoryRoutes({db,queue:new GenerationQueue(1),log:app.log,resolvedModel:()=> 'fake-only',model:{complete:async()=>{
   calls++;db.prepare('UPDATE messages SET meta_json=? WHERE id=?').run(JSON.stringify({observation:after}),m.id);
   return {text:'{"episode":"DERIVED_ROLLUP_CANARY"}'};
  }}} as any));
  const r=await app.inject({method:'POST',url:`/api/conversations/${id}/rollup-episode?force=1`,payload:{}});
  const episodes=db.prepare("SELECT * FROM summaries WHERE conversation_id=? AND tier='episode'").all(id) as any[];
  const access=episodes[0]?provenanceReader(db).canUse(episodes[0],'summary'):null;
  if(episodes[0])db.prepare("UPDATE summaries SET status='approved' WHERE id=?").run(episodes[0].id);
  const c=db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as any;
  const prompt=buildPrompt(db,c,getPath(db,c),8192,'fake-only').messages;
  const record={kind,sourceId:m.id,sceneId:sid,before:old,after,calls,expected:{http:kind==='broaden'?200:409,episodeCount:kind==='broaden'?1:0},actual:{http:r.statusCode,episodeCount:episodes.length,publicEligible:access,publicPromptHasDerivedCanary:JSON.stringify(prompt).includes('DERIVED_ROLLUP_CANARY'),response:r.json(),scene:db.prepare('SELECT rolled_up_into FROM summaries WHERE id=?').get(sid)}};
  results.push(record);
  // F1: widening an ancestor must not widen the derived audience; narrowing blocks the commit.
  assert.equal(record.actual.publicPromptHasDerivedCanary,false);assert.notEqual(access,true);
  if(kind==='narrow'){
   assert.equal(r.statusCode,409);assert.equal(episodes.length,0);
   assert.equal((record.actual.scene as any).rolled_up_into,null);
  }else{
   assert.equal(r.statusCode,200);assert.equal(episodes.length,1);
   assert.equal((record.actual.scene as any).rolled_up_into,episodes[0].id);
   const approved=db.prepare('SELECT * FROM summaries WHERE id=?').get(episodes[0].id) as any;
   assert.equal(provenanceReader(db).canUse(approved,'summary'),false);
   assert.equal(provenanceReader(db).canUse(approved,'summary',old as any),true);
  }
  assert.equal(calls,1);
  await app.close();console.log('ok '+results.length+' '+kind+' privacy preserved');
 }
 fs.writeFileSync(path.join(process.env.RPCHAT_BENCH_ARTIFACT_DIR!,'reproduction.json'),JSON.stringify(results,null,2));
}finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}}
main().catch(e=>{console.error(e);process.exitCode=1;});
