import fs from 'node:fs';
import ts from 'typescript';
import { sceneDisplay } from '../apps/web/src/lib/sceneDisplay.ts';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SceneStatusPanel } from '../apps/web/src/components/sceneStatus/SceneStatusPanel.tsx';
import { summarizeConversationDetail } from '../apps/web/src/lib/conversationSettings.ts';

const scene = { clock_minutes: 555, user_sheet: { hp: 7, money: 0 }, present_ids: ['npc'] };
const html = renderToStaticMarkup(createElement(SceneStatusPanel, {
  conversationId: 'fixture', scene, hasBeatRoster: false, placement: 'desktop',
}));
assert.doesNotMatch(html, /장면 정보가 없습니다/);
assert.match(html, /09:15/);
assert.match(html, /HP 7/);
assert.match(html, /동행 1명/);
const summary = summarizeConversationDetail({
  conversation: { id: 'fixture', title: '', profile_name: 'rp-balanced', scene },
  character: { name: '유키', avatar: null, scenario: '옛 시작 장면' }, persona: null,
}, 'test');
assert.match(summary.startTitle, /09:15/);
assert.match(summary.startTitle, /HP 7/);
console.log('passed scene display regression');

const places = [{ id:'pier', name:'제3부두' }];
assert.equal(sceneDisplay({ location:'pier' }, places).place, '제3부두');
assert.equal(sceneDisplay({ place:'직접 지정', location:'pier' }, places).place, '직접 지정');
assert.equal(sceneDisplay({ location:'unknown' }, places).place, 'unknown');
assert.equal(sceneDisplay({ place:'  ', user_sheet:{hp:null,money:null} }).hasScene, false);
assert.match(sceneDisplay({ clock_minutes:0, user_sheet:{hp:0,money:0} }).text, /00:00.*HP 0.*소지금 0/);
assert.equal(sceneDisplay({ clock_minutes:NaN }).hasScene, false);
assert.equal(sceneDisplay({ time:'밤', clock_minutes:555 }).summary, '밤');
assert.match(sceneDisplay({ present_ids:['npc','npc'] }).summary, /동행 1명/);
assert.equal(summarizeConversationDetail({ conversation:{id:'c',title:'',profile_name:'rp-balanced',scene:{}}, character:{name:'유키',avatar:null,scenario:'옛 시나리오'},persona:null },'test').startTitle, '');
for (const generating of [true,false]) {
 const rendered = renderToStaticMarkup(createElement(SceneStatusPanel, { conversationId:'c',scene,hasBeatRoster:false,placement:'desktop',generating }));
 assert.doesNotMatch(rendered,/장면 정보가 없습니다/);
 assert.match(rendered,/HP 7/);
}
console.log('passed scene display boundary cases');

// Execute the production stream callback: successful legacy party/beat and dialog
// must all re-read the committed scene; 1:1 keeps its existing behavior.
const source = ts.createSourceFile('useChat.ts',fs.readFileSync('apps/web/src/pages/useChat.ts','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
let callback='';
function visit(node:any) {
 if(ts.isCallExpression(node) && node.expression.getText(source)==='streamPost') callback=node.arguments[2].getText(source);
 ts.forEachChild(node,visit);
}
visit(source);
assert.ok(callback);
const js=ts.transpileModule(callback,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const invoke=new Function('state','event',`const scope={},ctrl={},scopeRef={current:scope},abortRef={current:ctrl};let resync=false,failed=false,requestError=null;const applyEvent=()=>{};const cb=${js};cb(event);return resync;`);
for(const [mode,format,expected] of [['story',undefined,true],['chat','beat',true],['chat','dialog',true],['chat',undefined,false]]) {
 const state={detail:{conversation:{mode,scene:{format}}}};
 assert.equal(invoke(state,{type:'done',message:{status:'complete'}}),expected);
 assert.equal(invoke(state,{type:'done',message:{status:'interrupted'}}),false);
}
console.log('passed committed scene resync cases');
