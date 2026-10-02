import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { choiceContext, PUBLIC } from '../apps/server/src/prompt/observation.js';
const source=ts.createSourceFile('ChatPage.tsx',fs.readFileSync(process.env.CHOICE_SOURCE ?? 'apps/web/src/pages/ChatPage.tsx','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let declaration:ts.VariableDeclaration|undefined;
function visit(n:ts.Node) { if(ts.isVariableDeclaration(n)&&n.name.getText(source)==='onChoice') declaration=n; ts.forEachChild(n,visit); }
visit(source); assert.ok(declaration?.initializer);
const js=ts.transpileModule(`const onChoice=${declaration!.initializer!.getText(source)};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const sent:any[]=[];
const deps={chat:{generating:false,detail:{conversation:{ended_at:null,scene:{observation_filter:true}}},send:async(content:string,opts?:object)=>{sent.push({content,...opts});return true;}},whisperIds:'npc-a, npc-b',setWhisperIds:()=>{},setChoiceDraft:()=>{},setDraft:()=>{},requestAnimationFrame:()=>{},grow:()=>{},stickyRef:{current:false}};
const callback=new Function(...Object.keys(deps),js+';return onChoice;')(...Object.values(deps));
callback('PRIVATE_CHOICE_7319');
assert.deepEqual(sent,[{content:'PRIVATE_CHOICE_7319'}], 'unrelated stored choices must default public, not inherit the composer whisper');
console.log('ok 1 actual unrelated choice defaults public despite a previous whisper recipient');

let pending:any=null; let draft='';
const privateDeps={...deps,chat:{...deps.chat,messages:[{id:'saved',meta:{choices:['PRIVATE_CHOICE_7319'],choices_context:{private_context:true,recipient_ids:['npc-a']}}}]},setChoiceDraft:(v:any)=>{pending=v;},setDraft:(v:string)=>{draft=v;}};
const prepare=new Function(...Object.keys(privateDeps),js+';return onChoice;')(...Object.values(privateDeps));
sent.length=0; prepare('PRIVATE_CHOICE_7319');
assert.equal(sent.length,0); assert.equal(draft,'PRIVATE_CHOICE_7319'); assert.deepEqual(pending,{message_id:'saved',index:0,recipient_ids:['npc-a'],visibility:'public'});
console.log('ok 2 private-context choice waits for confirmation with public default');
let submitDecl:ts.FunctionDeclaration|undefined;
function findSubmit(n:ts.Node) {if(ts.isFunctionDeclaration(n)&&n.name?.text==='submit')submitDecl=n;ts.forEachChild(n,findSubmit);}
findSubmit(source);assert.ok(submitDecl);
const submitJs=ts.transpileModule(submitDecl!.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
async function sendChoice(visibility:'public'|'private') {
  draft='PRIVATE_CHOICE_7319'; sent.length=0; const d={...privateDeps,draft,choiceDraft:{...pending,visibility},resolveShortcutSubmit:(content:string)=>({content}),readShortcuts:()=>[]};
  await new Function(...Object.keys(d),submitJs+';return submit;')(...Object.values(d))();
  assert.deepEqual(sent,[{content:'PRIVATE_CHOICE_7319',choice:{message_id:'saved',index:0,visibility}}]);
}
async function main() {
await sendChoice('public');console.log('ok 3 confirmed public choice overrides stale whisper settings');
pending={message_id:'saved',index:0,recipient_ids:['npc-a'],visibility:'public'};
await sendChoice('private');console.log('ok 4 confirmed whisper sends source reference, never client recipient IDs');

}
main().catch(err => {console.error(err);process.exitCode=1;});

assert.equal(choiceContext([PUBLIC,undefined]),null);
assert.deepEqual(choiceContext([{visibility:'private',recipient_ids:['user','a'],observer_ids:['b']}]),{private_context:true,recipient_ids:['a']});
assert.deepEqual(choiceContext([{visibility:'private',recipient_ids:['user','a'],observer_ids:[]},{visibility:'private',recipient_ids:['user','b'],observer_ids:[]}]),{private_context:true,recipient_ids:[]});
console.log('ok 5 incompatible private audiences cannot broaden recipients');
