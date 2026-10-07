import assert from 'node:assert/strict';
import { renderChatMessage } from './helpers/chatMessageView.js';
import type { Message } from '../apps/web/src/types.js';
const m: Message = { id:'a',conversation_id:'room',parent_id:null,role:'assistant',content:'대사',status:'complete',meta:{},
  eventVersion:1,events:[{id:'a:0',type:'dialogue',actorId:'actor',actorName:'유키',text:'대사'}],
  bookmarked:false,created_at:'2026-10-06T00:00:00Z',siblings:{index:0,count:1,ids:['a']} };
const html=renderChatMessage(m);
const menu=html.match(/<details\b[^>]*>[\s\S]*?<\/details>/)?.[0];
assert.ok(menu);
assert.ok(!/^<details[^>]*\bopen\b/.test(menu));
assert.ok(menu.includes('메시지 관리') && menu.includes('편집') && menu.includes('즐겨찾기') && menu.includes('삭제'));
const outside=html.replace(menu,'');
assert.ok(outside.includes('재생성'));
assert.ok(!outside.includes('편집') && !outside.includes('즐겨찾기') && !outside.includes('삭제'));
console.log('ok 1 secondary actions start in a closed native disclosure; regenerate stays available');
assert.ok(!renderChatMessage(m,{generating:true}).includes('<details'));
assert.ok(!renderChatMessage(m,{streaming:true}).includes('<details'));
assert.ok(renderChatMessage({...m,bookmarked:true}).includes('즐겨찾기 해제'));
console.log('ok 2 generating and streaming retain action guards, bookmarked state remains visible');
