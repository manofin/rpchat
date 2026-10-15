/** npm run test:benches -- turnDeadlineClient — fake HTTP responses, no network/model/DB. */
import assert from 'node:assert/strict';
import { ApiError, isUserCancelledRequest, requestFailureCode, sendOkForComposer, streamPost } from '../apps/web/src/lib/api.js';

async function main() {
  const original = globalThis.fetch;
  let checks=0;
  try {
    for (const status of [504,499]) {
      globalThis.fetch=async()=>new Response(JSON.stringify({error:'전체 처리 시간이 초과됐습니다.',code:'turn_deadline_exceeded'}),{status});
      await assert.rejects(streamPost('/synthetic',{},()=>assert.fail('no SSE on HTTP failure')),error=>{
        assert.ok(error instanceof ApiError);
        assert.equal(requestFailureCode(error),'turn_deadline_exceeded');
        assert.equal(isUserCancelledRequest(error),false);
        assert.equal(sendOkForComposer(error,false),false);
        assert.equal(error.message,'전체 처리 시간이 초과됐습니다.');
        return true;
      });
      console.log(`ok ${++checks} HTTP ${status} deadline preserves code and restores unconfirmed draft`);
    }
    for (const code of ['user_cancelled',undefined]) {
      globalThis.fetch=async()=>new Response(JSON.stringify({error:'생성을 취소했습니다.',code}),{status:499});
      await assert.rejects(streamPost('/synthetic',{},()=>{}),error=>{
        assert.equal(isUserCancelledRequest(error),true);assert.equal(sendOkForComposer(error,false),true);return true;
      });
      console.log(`ok ${++checks} ${code??'legacy'} cancellation keeps previous composer policy`);
    }
    globalThis.fetch=async()=>new Response('gateway unavailable',{status:502});
    await assert.rejects(streamPost('/synthetic',{},()=>{}),error=>{
      assert.ok(error instanceof ApiError);assert.equal(error.message,'gateway unavailable');assert.equal(isUserCancelledRequest(error),false);return true;
    });
    console.log(`ok ${++checks} non-JSON failures retain fallback`);
  } finally {globalThis.fetch=original;}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
