import assert from 'node:assert/strict';
import {planRequests,userProjection,permissionVersion,coversScope,unionScopes} from '../apps/server/src/prompt/partyRequestPlan.ts';
const pub:any={visibility:'public'},priv=(...ids:string[]):any=>({visibility:'private',recipient_ids:ids});
const snap=():any=>({snapshot_id:'s',participants:['a','b','user'],present_ids:['a'],observation_filter:false,path:[],approved_items:[]});
const c=(scope=pub):any=>({id:'VISIBLE_CAND',kind:'dialogue_output',role:'public_script',segments:[{id:'SEG',recipients:scope}],context:[],predecessors:[]});
const run=(cs:any[],s=snap())=>planRequests(s,cs,{own_generation_id:null});
const tests:[string,()=>void][]=[
['M03',()=>assert.equal(coversScope(priv('user'),priv('user','a')),false)],
['M05',()=>assert.deepEqual(unionScopes([priv('user','a'),priv('user','b')]),priv('a','b','user'))],
['M07',()=>{const x:any={id:'X',kind:'internal_control',declared_scope:priv('a'),context:[],predecessors:[]};const y=c(priv('a','user'));y.predecessors=['X'];assert.equal(run([x,y]).reason,'declared_scope_mismatch');}],
['M09',()=>{const s=snap();s.path=[{id:'ROW',generation_id:'old',observation:{visibility:'private',recipient_ids:['user','a'],observer_ids:['b']}}];const x=c(priv('user','b'));x.context=[{source:'path',item_id:'ROW',required:true}];assert.equal(run([x],s).reason,'input_permission');}],
['M13',()=>{const x=c();x.context=[{source:'story',item_id:'STORY',required:true,allowed_override:priv('a')}];assert.equal(run([x]).reason,'input_permission');}],
['M18',()=>{const x=c();x.segments=[];assert.equal(run([x]).reason,'field_mismatch');}],
['M24',()=>{const x=c();x.segments=[{id:'s1',recipients:priv('user','a')},{id:'s2',recipients:priv('a')}];assert.equal(run([x]).reason,'unsupported_in_needed');}],
['M27',()=>assert.equal(JSON.stringify(userProjection(run([c()]))).includes('VISIBLE_CAND'),false)],
['M28',()=>{const a=snap(),b=snap();b.participants=['user'];assert.notEqual(permissionVersion(a,null),permissionVersion(b,null));}],
['M29',()=>{const a=snap(),b=snap();b.observation_filter=true;assert.notEqual(permissionVersion(a,null),permissionVersion(b,null));}],
['M30',()=>{const a=snap(),b=snap();a.path=[{id:'r',generation_id:'old',observation:pub}];b.path=[{id:'r',generation_id:'old',observation:priv('a')}];assert.notEqual(permissionVersion(a,null),permissionVersion(b,null));}],
];
tests.push(
['A duplicate IDs with different context reject before context evaluation',()=>{
 const a=c(),b=c(); b.context=[{source:'story',item_id:'hidden',required:false}];
 const forward=run([a,b]),reverse=run([b,a]);
 assert.equal(forward.reason,'duplicate_id');
 assert.equal(JSON.stringify(forward),JSON.stringify(reverse));
 assert.deepEqual(forward.context,{});
}],
['F Unicode ready-set order uses code points',()=>{
 const ids=['x','\uE000','\u{10000}','\uE000x'];
 const cs=ids.map(id=>({...c(),id}));
 cs[0].predecessors=['\uE000'];
 const result=run(cs);
 assert.equal(result.status,'ok');
 assert.deepEqual(result.execution_plan?.map(x=>x.candidate_id),['\uE000','x','\uE000x','\u{10000}']);
 assert.equal(JSON.stringify(result),JSON.stringify(run([...cs].reverse())));
}],
);
let checks=0;
for(const [id,test] of tests){test();console.log('ok '+(++checks)+' B1 '+id);}
