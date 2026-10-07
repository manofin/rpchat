import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadAudienceActors, actorLabel, audienceLabel, type AudienceActor } from '../apps/web/src/lib/audienceLabels.js';
import { WhisperRecipients } from '../apps/web/src/components/WhisperRecipients.js';
import { BeatUiPanel } from '../apps/web/src/components/view.js';
import type { ConversationDetail } from '../apps/web/src/types.js';
async function main() {
const actors:AudienceActor[]=[{id:'a',name:'유키',description:'서점 주인',available:true},{id:'b',name:'유키',description:'여행자',available:true}];
assert.notEqual(actorLabel('a',actors),actorLabel('b',actors));
assert.equal(actorLabel('a',[...actors].reverse()),actorLabel('a',actors));
assert.equal(audienceLabel({visibility:'private',recipient_ids:['user','a','a'],observer_ids:['b']},actors),'비공개 · 나·유키 (인물 1)만 아는 내용 · 유키 (인물 2)에게는 대화가 있었다는 사실만 전달');
assert.ok(audienceLabel({visibility:'private',recipient_ids:['user','deleted']},actors)?.includes('이름 확인 불가'));
assert.equal(audienceLabel({visibility:'private'} as any,actors),'공개 범위 확인 불가');
console.log('ok 1 duplicate names, observers and unavailable names keep explicit scope without guessing');
const html=renderToStaticMarkup(createElement(WhisperRecipients,{actors,value:'b',onChange(){},disabled:false,loading:false,error:false}));
assert.ok(html.includes('유키 (인물 1)') && html.includes('서점 주인') && html.includes('여행자'));
assert.ok(html.includes('/character/b') && html.includes('나·유키 (인물 2)만 아는 내용'));
assert.ok(!html.includes('수신자 ID') && !html.includes('type="text"'));
const tree=WhisperRecipients({actors,value:'',onChange(v){assert.equal(v,'b');},disabled:false,loading:false,error:false});
const inputs:any[]=[];
function walk(node:any){if(Array.isArray(node))return node.forEach(walk);if(!node?.props)return;if(node.type==='input')inputs.push(node);walk(node.props.children);}
walk(tree);inputs[1].props.onChange({target:{checked:true}});
console.log('ok 2 named checkbox sends the exact selected actor ID and offers profile disambiguation');
const detail={conversation:{story_id:'story',story_participant_ids_snapshot:'["a","b"]'},character:{id:'a',name:'유키',tagline:'서점 주인',description:''}} as unknown as ConversationDetail;
const calls:string[]=[];
const loaded=await loadAudienceActors(detail,async <T>(url:string)=>{calls.push(url);return {id:'b',name:'유키',tagline:'여행자',description:''} as T;});
assert.deepEqual(calls,['/api/characters/b']);assert.deepEqual(loaded.map(a=>a.id),['a','b']);
assert.equal((await loadAudienceActors(detail,async()=>{throw Error('missing');}))[1].available,false);
await assert.rejects(()=>loadAudienceActors({...detail,conversation:{...detail.conversation,story_participant_ids_snapshot:'{"bad":1}'}},async()=>{throw Error('must not query alternate roster');}));
console.log('ok 3 frozen participant roster drives choices; missing cards and malformed snapshots fail safely');
const cast=renderToStaticMarkup(createElement(BeatUiPanel,{ui:{roster:[{id:'a',name:'유키',chip:'🔒',locked:true,in_room:true}]}}));
assert.ok(cast.includes('이번 턴 대사 없음'));assert.ok(!cast.includes('잠금') && !cast.includes('🔒'));
console.log('ok 4 cast uses speech eligibility wording instead of security imagery');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
