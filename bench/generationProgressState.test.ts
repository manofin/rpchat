import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GenerationStatus } from '../apps/web/src/components/GenerationStatus.js';
import assert from 'node:assert/strict';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { generationFailure, PrivateValidationError } from '../apps/server/src/model/generationFailure.js';
import { initialChatState, reduceChatEvent } from '../apps/web/src/lib/chatStreamState.js';
async function main() {
const originalNow = Date.now;
Date.now = () => Date.parse('2026-10-06T01:00:12.000Z');
try {
  for (const [phase, label] of [['queued', '대기 중'], ['writing', '이야기 작성 중'], ['validating', '비공개 내용 확인 중']] as const) {
    const html = renderToStaticMarkup(createElement(GenerationStatus, { progress: { generationId:'g', phase, startedAt:'2026-10-06T01:00:00.000Z' } }));
    assert.ok(html.includes(label));
    assert.ok(html.includes('12초'));
    assert.ok(!html.includes('세계관에 반영 중'));
  }
  assert.ok(renderToStaticMarkup(createElement(GenerationStatus)).includes('진행 상태 확인 중'));
} finally { Date.now = originalNow; }
console.log('ok 4 server phases render distinct labels and total elapsed time, unknown phase stays unknown');

const q = new GenerationQueue(1);
let release!: () => void;
const busy = q.run(() => new Promise<void>(resolve => { release = resolve; }));
const controller = new AbortController();
q.register({ id:'g',conversationId:'room',messageId:'',controller,startedAt:'2026-10-06T01:00:00.000Z' });
const phases: string[] = [];
q.watchProgress('g', g => phases.push(g.phase!));
const next = q.runGeneration('g', async () => {
  assert.equal(q.activeList[0].phase,'writing');
},controller.signal);
assert.equal(q.activeList[0].phase,'queued');
assert.ok(!phases.includes('writing'));
release();await busy;await next;
assert.ok(phases.includes('writing'));
q.setPhase('g','validating');
assert.equal(q.activeList[0].phase,'validating');
q.unregister('g');assert.equal(q.activeList.length,0);
console.log('ok 1 queue reports real waiting, execution and validation boundaries');
let state = {...initialChatState,generating:true};
state = reduceChatEvent(state,{type:'progress',generationId:'g',phase:'writing',startedAt:'2026-10-06T01:00:00.000Z'},'room');
assert.equal(state.generationProgress?.phase,'writing');
state = reduceChatEvent(state,{type:'error',message:'시간 초과',code:'timeout'},'room');
assert.equal(state.errorCode,'timeout');assert.equal(state.generating,false);assert.equal(state.generationProgress,null);
const settled=state;
state=reduceChatEvent(state,{type:'progress',generationId:'g',phase:'queued',startedAt:'2026-10-06T01:00:00.000Z'},'room');
assert.equal(state,settled);
console.log('ok 2 progress never replaces transcript or reopens a terminal result');
assert.equal(generationFailure(new PrivateValidationError()).code,'validation');
assert.equal(generationFailure(Object.assign(new Error('private'),{name:'TimeoutError'})).code,'timeout');
assert.equal(generationFailure(Object.assign(new Error('private'),{cause:{code:'ECONNREFUSED'}})).code,'connection');
assert.equal(generationFailure(new Error('private')).code,'generation');
assert.ok(!JSON.stringify(generationFailure(new Error('private'))).includes('private'));
console.log('ok 3 safe structured failures distinguish transport, timeout and validation');

}
main().catch(e=>{console.error(e);process.exitCode=1;});
