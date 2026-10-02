import assert from 'node:assert/strict';
import { messagePortrait, portraitMessageIds } from '../apps/web/src/lib/chatPortraits.ts';
import { renderChatMessage } from './helpers/chatMessageView.ts';
import type { Message } from '../apps/web/src/types.ts';
let passed=0; const t=(name:string,fn:()=>void)=>{fn();console.log(`ok ${++passed} ${name}`);};
const src='/media/assets/nari/uniform/1.webp';
function message(id:string,actorId='nari',image:string|undefined=src):Message {
  return {id,conversation_id:'fixture',parent_id:null,role:'assistant',content:'어서 와.',status:'complete',meta:{image_url:image,speaker_avatar:image},eventVersion:1,events:[{type:'dialogue',id:id+':0',actorId,actorName:actorId,text:'어서 와.'}],siblings:{index:0,count:1,ids:[id]},bookmarked:false,created_at:'2026-10-02'};
}
const user=(id:string):Message=>({...message(id),role:'user',content:'문을 연다.',meta:{},events:[]});
t('server-selected portrait is inline, accessible, reserved-size and never duplicated in the avatar',()=>{
 const html=renderChatMessage(message('a'));assert.match(html,/class="character-portrait"/);assert.match(html,/alt="nari의 모습"/);assert.match(html,/width="600" height="800" loading="lazy"/);assert.equal((html.match(/src="\/media\/assets/g)??[]).length,1);assert.match(html,/어서 와/);
});
t('empty, remote, arbitrary and query image URLs produce no image card',()=>{
 for(const url of ['',undefined,'https://example.test/image.webp','/media/avatars/a.webp',src+'?x=1','data:image/png;base64,abc']){const m=message('a');m.meta.image_url=url;m.meta.speaker_avatar=undefined;assert.equal(messagePortrait(m),null);assert.doesNotMatch(renderChatMessage(m),/character-portrait/);}
});
t('user, hidden thought, narration and damaged event contract cannot show a portrait',()=>{
 for(const m of [user('u'),{...message('t'),events:[]},{...message('n'),events:[{type:'narration' as const,id:'n:0',text:'서술'}]},{...message('broken'),eventVersion:undefined}])assert.equal(messagePortrait(m),null);
});
t('same actor and selected asset appear once in each turn; another actor is independent',()=>{
 const rows=[user('u'),message('a'),message('b'),message('c','mio','/media/assets/mio/casual/2.webp'),user('u2'),message('d')];
 assert.deepEqual([...portraitMessageIds(rows,false)],['a','c','d']);assert.deepEqual([...portraitMessageIds(rows,true)],['a','c','d']);
 assert.doesNotMatch(renderChatMessage(rows[2],{showPortrait:false}),/character-portrait/);
});
t('selected outfit changes and returns render in order; no client asset inference',()=>{
 assert.deepEqual([...portraitMessageIds([message('a'),message('b','nari','/media/assets/nari/casual/2.webp'),message('c')],false)],['a','b','c']);
});
t('branch/regenerate recomputes exclusively from supplied active messages',()=>{
 const old=[user('u'),message('old'),message('old-repeat')]; const next=[user('u'),message('regen','nari','/media/assets/nari/casual/2.webp'),message('regen-repeat','nari','/media/assets/nari/casual/2.webp')];
 assert.deepEqual([...portraitMessageIds(old,false)],['old']);assert.deepEqual([...portraitMessageIds(next,false)],['regen']);assert.deepEqual([...portraitMessageIds([user('u'),message('branch','mio','/media/assets/mio/casual/1.webp')],false)],['branch']);
});
t('dialog UI reorder preserves portrait selection, choices, focus and streaming cursor',()=>{
 const panel={...message('panel'),meta:{block_kind:'info' as const},events:[{type:'system' as const,id:'panel:0',presentation:'info' as const,text:'INFO'}]};
 assert.deepEqual([...portraitMessageIds([user('u'),panel,message('a')],true)],['a']);
 const m=message('a');m.meta.choices=['창가에 앉는다'];assert.match(renderChatMessage(m),/창가에 앉는다/);assert.match(renderChatMessage(m,{streaming:true,focusId:'nari'}),/class="cursor"/);assert.match(renderChatMessage(m,{focusId:'nari'}),/is-focus/);
});
console.log(`\n${passed} passed`);
