import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source=ts.createSourceFile('ChatPage.tsx',fs.readFileSync('apps/web/src/pages/ChatPage.tsx','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let declaration:ts.VariableDeclaration|undefined;
function visit(n:ts.Node) { if(ts.isVariableDeclaration(n)&&n.name.getText(source)==='onChoice') declaration=n; ts.forEachChild(n,visit); }
visit(source); assert.ok(declaration?.initializer);
const js=ts.transpileModule(`const onChoice=${declaration!.initializer!.getText(source)};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const sent:any[]=[];
const deps={chat:{generating:false,detail:{conversation:{ended_at:null,scene:{observation_filter:true}}},send:async(content:string,opts?:object)=>{sent.push({content,...opts});return true;}},whisperIds:'npc-a, npc-b',setWhisperIds:()=>{},setChoiceDraft:()=>{},setDraft:()=>{},requestAnimationFrame:()=>{},grow:()=>{},stickyRef:{current:false}};
const callback=new Function(...Object.keys(deps),js+';return onChoice;')(...Object.values(deps));
callback('PRIVATE_CHOICE_7319');
assert.deepEqual(sent,[{content:'PRIVATE_CHOICE_7319'}]);
console.log('ok 1 actual unrelated choice defaults public despite a previous whisper recipient');
