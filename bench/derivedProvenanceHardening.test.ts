import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { openMigratedDb } from '../apps/server/src/db/index.js';
import { insertMessage,setHead,getPath } from '../apps/server/src/db/tree.js';
import { provenanceReader,encodeProvenance } from '../apps/server/src/memory/provenance.js';
import { selectContext } from '../apps/server/src/prompt/contextSelection.js';
import { fixtureProvenance } from './helpers/derivedProvenanceFixture.js';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'survivor-witness-'));const db=openMigratedDb(dir,path.resolve('apps/server/migrations'));
const results:any[]=[];const privateA={visibility:'private',recipient_ids:['a','user'],observer_ids:[]};
try{
 db.exec("INSERT INTO characters(id,name,created_at,updated_at) VALUES('a','A','2026','2026')");
 for(const id of ['M02','M04','M05','M06','M08','M10','M11','M13','M14','M15','M16','M20']){
  try {
   db.prepare("INSERT INTO conversations(id,character_id,profile_name,prompt_version,scene_json,created_at,updated_at) VALUES(?,'a','default','test','{}','2026','2026')").run(id);
   const m=insertMessage(db,id,null,'user','SOURCE_'+id,'complete',{observation:{visibility:'public'}});setHead(db,id,m.id);
   db.prepare("INSERT INTO memories(id,conversation_id,character_id,content,source,status,scope,evidence_message_ids_json,created_at,updated_at) VALUES(?,?,'a',?,'model','pinned','conversation','[]','2026','2026')").run(id,id,'DERIVED_'+id);
   fixtureProvenance(db,'memory',id,[m.id]);
   const mem=()=>db.prepare('SELECT * FROM memories WHERE id=?').get(id) as any;
   const p=JSON.parse(mem().input_provenance_json);
   if(id==='M02')db.prepare("UPDATE messages SET status='interrupted' WHERE id=?").run(m.id);
   if(id==='M04')db.prepare('UPDATE messages SET meta_json=? WHERE id=?').run(JSON.stringify({observation:{visibility:'broken'}}),m.id);
   if(id==='M05'){db.prepare("UPDATE messages SET meta_json='{}' WHERE id=?").run(m.id);db.prepare('UPDATE conversations SET scene_json=? WHERE id=?').run(JSON.stringify({format:'beat',observation_filter:true}),id);}
   if(id==='M06')p.inputs[0].conversation_id='wrong-room';
   if(id==='M08')p.inputs[0].provenance_sha256='0'.repeat(64);
   if(id==='M13')p.basis='user-declared';
   // These valid-schema receipts deliberately isolate redundant defenses.
   // M14/M15 are not claimed to be producible by the current normal writer.
   if(id==='M14')p.ceiling=privateA;
   if(id==='M15')p.inputs[0].audience=privateA;
   if(id==='M16')db.prepare('UPDATE messages SET meta_json=? WHERE id=?').run(JSON.stringify({observation:privateA}),m.id);
   if(['M10','M11'].includes(id)){
    const sid=id+'-summary';db.prepare("INSERT INTO summaries(id,conversation_id,content,status,tier,created_at) VALUES(?,?,'SUMMARY','approved','whole','2026')").run(sid,id);fixtureProvenance(db,'summary',sid,[m.id]);
    const summary=db.prepare('SELECT * FROM summaries WHERE id=?').get(sid) as any;
    const source=provenanceReader(db).summarySource(summary,'SUMMARY')!;
    if(id==='M10')source.conversation_id='wrong-room';
    db.prepare('UPDATE memories SET input_provenance_json=? WHERE id=?').run(encodeProvenance(mem().content,[source]),id);
    if(id==='M11')db.prepare('UPDATE summaries SET input_provenance_json=? WHERE id=?').run(JSON.stringify(JSON.parse(summary.input_provenance_json),null,2),sid);
   } else db.prepare('UPDATE memories SET input_provenance_json=? WHERE id=?').run(JSON.stringify(p),id);
   if(id==='M20'){
    const c=db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as any,h=getPath(db,c);
    assert.ok(JSON.stringify(selectContext(db,c,h,{memory:4000,lore:500},1).memoryParts).includes('DERIVED_M20'));
    assert.equal(JSON.stringify(selectContext(db,c,h,{memory:4000,lore:500},1,{excludeMemoryIds:new Set([id])}).memoryParts).includes('DERIVED_M20'),false);
   }else assert.equal(provenanceReader(db).canUse(mem(),'memory'),false,id+' should be withheld from public');
   results.push({id,status:'pass'});console.log('ok '+results.length+' '+id);
  }catch(e:any){results.push({id,status:'fail',actual:e.actual,expected:e.expected,message:e.message});console.log('WITNESS FAIL '+id);}
 }
 fs.writeFileSync(path.join(process.env.RPCHAT_BENCH_ARTIFACT_DIR!,'witness-results.json'),JSON.stringify(results,null,2));
 assert.equal(results.filter(r=>r.status==='fail').length,0);
}finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
