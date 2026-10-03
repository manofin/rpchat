import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StoryPortraitSettings } from '../apps/web/src/components/StoryPortraitSettings';
import { buildPortraitCatalog, portraitDraft } from '../apps/web/src/lib/storyPortraits';
let passed=0;
function t(name:string,fn:()=>void){fn();console.log(`ok ${++passed} ${name}`)}
const original={outfits:['교복','사복'],emotions:{평온:0,웃음:1},default_emotion:'평온'};
t('authored image settings round-trip exactly without losing zero',()=>{
 assert.deepEqual(buildPortraitCatalog(portraitDraft(original)).value,original);
 const absent={outfits:[],emotions:{}};assert.deepEqual(buildPortraitCatalog(portraitDraft(absent)).value,absent);
});
t('clearing initial emotion omits its key but preserves mappings',()=>{
 const d=portraitDraft(original);d.defaultEmotion='';
 assert.deepEqual(buildPortraitCatalog(d).value,{outfits:original.outfits,emotions:original.emotions});
});
t('duplicate/partial/invalid mapping refuses instead of silently selecting a file',()=>{
 for(const emotions of [[{name:'평온',index:'0'},{name:'평온',index:'1'}],[{name:'평온',index:''}],[{name:'',index:'1'}],[{name:'평온',index:'-1'}],[{name:'평온',index:'1.5'}],[{name:'평온',index:'10000'}]]){
  const result=buildPortraitCatalog({...portraitDraft(original),emotions});assert.ok(result.error);assert.equal(result.value,undefined);
 }
});
t('deleted/renamed starting emotion requires explicit reselection',()=>{
 const d=portraitDraft(original);d.emotions=d.emotions.filter(x=>x.name!=='평온');
 assert.ok(buildPortraitCatalog(d).error);
 d.defaultEmotion='웃음';assert.equal(buildPortraitCatalog(d).value?.default_emotion,'웃음');
});
t('outfit path traversal and excessive authoring input fail before save',()=>{
 for(const outfits of ['../secret','bad/segment','bad\\segment','a'.repeat(41)])assert.ok(buildPortraitCatalog({...portraitDraft(original),outfits}).error);
 const d=portraitDraft(original);d.emotions=Array.from({length:51},(_,i)=>({name:'표정'+i,index:String(i)}));assert.ok(buildPortraitCatalog(d).error);
});
t('actual rendered controls distinguish initial display from unimplemented automatic changes',()=>{
 const html=renderToStaticMarkup(React.createElement(StoryPortraitSettings,{draft:portraitDraft(original),onChange:()=>{}}));
 for(const label of ['의상 이름','표정 이름','이미지 번호','새 방의 시작 표정','표정 추가','표정 삭제','지정하지 않음','대화 중 표정 자동 변경은 아직 지원하지 않습니다'])assert.ok(html.includes(label),label);
 assert.match(html,/<option value="평온" selected="">평온<\/option>/);
 assert.match(html,/type="number" min="0" max="9999" step="1"/);
});
t('StoryEditor loads draft, validates before save, and round-trips unrelated catalog fields',()=>{
 const src=fs.readFileSync('apps/web/src/components/StoryEditor.tsx','utf8');
 assert.ok(src.includes('setPortraits(portraitDraft(rest))'));assert.ok(src.includes('buildPortraitCatalog(portraits)'));
 assert.ok(src.indexOf('if (portraitSettings.error)')<src.indexOf('const body = {'));
 assert.ok(src.includes('scene_catalog: { ...catalogFields, ...portraitSettings.value, places }'));
 assert.ok(src.includes('default_emotion: _oldDefaultEmotion'));assert.ok(src.includes('<StoryPortraitSettings draft={portraits} onChange={setPortraits} />'));
});
console.log(`PASS=${passed}`);
