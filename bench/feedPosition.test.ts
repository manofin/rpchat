import assert from 'node:assert/strict';
import { trackFeedPosition } from '../apps/web/src/lib/feedPosition.js';
const values = new Map<string,string>();
const storage = {getItem:(k:string)=>values.get(k) ?? null,setItem:(k:string,v:string)=>{values.set(k,v);}};
class Feed {
  height = 4000; clientHeight = 600; y = 0;
  offsets = [0,1000,2000,3000];
  get scrollHeight(){return this.height;}
  get scrollTop(){return this.y;}
  set scrollTop(n:number){this.y=Math.max(0,Math.min(n,this.height-this.clientHeight));}
  getBoundingClientRect(){return {top:100};}
  querySelectorAll(){return this.offsets.map((offset,i)=>({id:`msg-${i}`,getBoundingClientRect:()=>({top:100+offset-this.y,bottom:100+(this.offsets[i+1] ?? this.height)-this.y})}));}
  get element(){return this as unknown as HTMLElement;}
}
const feed=new Feed();const sticky={current:true};let latest=true;
let t=trackFeedPosition(feed.element,sticky,'a',storage,v=>latest=v);
assert.equal(feed.y,3400);
feed.scrollTop=1150;t.onScroll();assert.equal(latest,false);assert.equal(sticky.current,false);
feed.offsets=[0,1400,2400,3400];feed.height=4400;t.refresh();
assert.equal(feed.y,1550,'late image above reader preserves message 1 at -150px');
feed.clientHeight=300;t.refresh();assert.equal(feed.y,1550,'keyboard opening retains anchor');
feed.clientHeight=600;t.refresh();assert.equal(feed.y,1550,'keyboard closing retains anchor');
t.save();
console.log('ok 1 image and keyboard resize retain the reading anchor while away from bottom');
const reopened=new Feed();reopened.offsets=[0,1200,2200,3200];reopened.height=4200;
t=trackFeedPosition(reopened.element,{current:true},'a',storage,v=>latest=v);
assert.equal(reopened.y,1350,'reopen restores same message offset despite changed layout');
assert.equal(latest,false);
t.jumpLatest();assert.equal(reopened.y,3600);assert.equal(latest,true);
reopened.height=4600;t.refresh();assert.equal(reopened.y,4000,'new output follows bottom after explicit latest');
console.log('ok 2 return restores reading location and latest action resumes following new output');
const other=new Feed();trackFeedPosition(other.element,{current:false},'b',storage,()=>{});assert.equal(other.y,3400);
values.set('rpchat:reading:c',JSON.stringify({latest:false,messageId:'msg-deleted',offset:-50,scrollTop:700}));
const removed=new Feed();trackFeedPosition(removed.element,{current:true},'c',storage,()=>{});assert.equal(removed.y,700);
const search=new Feed();trackFeedPosition(search.element,{current:false},'c',storage,()=>{},false);assert.equal(search.y,3400);
console.log('ok 3 rooms are isolated; removed messages fall back and explicit search bypasses restore');
const restricted=new Feed();trackFeedPosition(restricted.element,{current:false},'d',{getItem(){throw Error('denied');},setItem(){throw Error('denied');}},()=>{}).onScroll();
assert.equal(restricted.y,3400);
console.log('ok 4 unavailable local storage never blocks conversation reading');

const raced = new Feed();
const racingTracker = trackFeedPosition(raced.element, { current: true }, 'font-race', storage, () => {});
raced.scrollTop = 1150; racingTracker.onScroll();
raced.offsets = [0, 1400, 2400, 3400]; raced.height = 4400;
racingTracker.onScroll(); // Browser scroll notification arrives before ResizeObserver.
racingTracker.refresh();
assert.equal(raced.y, 1550, 'layout-triggered scroll must not replace the saved reading anchor');
console.log('ok 5 layout scroll before ResizeObserver preserves the original reading anchor');
