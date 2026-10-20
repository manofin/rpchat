import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { openMigratedDb } from '../apps/server/src/db/index.js';
import { insertMessage, setHead } from '../apps/server/src/db/tree.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { PartyMetrics, partyMetricsCreationCount } from '../apps/server/src/model/partyMetrics.js';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { chatRoutes, logPartyOverflowAfterDelta } from '../apps/server/src/routes/chat.js';
import { config } from '../apps/server/src/config.js';
import { buildWireBlock, preflightWire, type WireSource } from '../apps/server/src/prompt/partyContextWire.js';
import { estimateMessageTokens } from '../apps/server/src/prompt/tokens.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { GenParams, GenResult } from '../apps/server/src/model/adapter.js';

let assertions = 0, passed = 0;
const a = new Proxy(assert, { get(target, key) { const v = Reflect.get(target, key); return typeof v === 'function' ? (...args: unknown[]) => { assertions++; return Reflect.apply(v, target, args); } : v; } });
async function test(name: string, f: () => unknown) { const n = assertions; await f(); assert.ok(assertions > n); console.log(`ok ${++passed} ${name}`); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'party-metrics-'));
const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
const app = Fastify();
const queue = new GenerationQueue(1);
const fixture = JSON.parse(fs.readFileSync('bench/fixtures/party-u1-metrics/conditions.json', 'utf8'));
let cast: any[] = [], storyId = '', failure = '', mutateDelta = false;
const calls: Array<{ id: string; params: GenParams; result: GenResult | null }> = [];
const allMetrics: unknown[] = [];
const result = (text: string, usage: GenResult['usage'] = { prompt_tokens: 31, completion_tokens: 7 }): GenResult => ({ text, usage, finishReason: 'stop', ttftMs: 0, totalMs: 2 });
function identify(p: GenParams, stream: boolean) {
  if (p.audience?.kind === 'actor') return `scoped:${p.audience.actor_id}`;
  if (p.audience?.kind === 'narrator') return 'scoped:narrator';
  if (stream) return p.audience ? 'S' : 'F';
  if (p.max_tokens === 200) return 'delta';
  if (p.max_tokens === 300) return 'N';
  if (p.max_tokens === 160) return 'C';
  // E's prompt includes only its permitted card scenario; IDs are determined
  // from actual submitted input, not copied from the metrics under test.
  const actor = cast.find(c => p.messages.some(m => m.content.includes(`CARD_${c.name}_CANARY`)));
  return `E:${actor?.id ?? 'missing'}`;
}
async function respond(p: GenParams, emit?: (s: string) => void) {
  const id = identify(p, !!emit), call = { id, params: p, result: null as GenResult | null }; calls.push(call);
  await new Promise(resolve => setTimeout(resolve, 3));
  if (failure === id) throw new Error('synthetic pass failure');
  if (id === 'F' && failure === 'deadline') { queue.activeList[0].turnDeadline!.tripDeadline(); p.signal?.throwIfAborted(); }
  if (id === 'F' && failure === 'cancel') { queue.abort(queue.activeList[0].id); p.signal?.throwIfAborted(); }
  if (id === 'delta' && mutateDelta) db.prepare('UPDATE characters SET description=? WHERE id=?').run('가'.repeat(20000), cast[0].id);
  const text = id === 'delta' ? 'null' : id === 'C' ? '<choices>["조건 문의","보류","떠나기"]</choices>'
    : id.startsWith('scoped:') ? (id === 'scoped:narrator' ? 'NO_NARRATION' : 'NO_LINE')
    : id === 'S' ? '나리 | 조건을 알려 드릴게요.' : id === 'F' ? '조건을 알려 드릴게요.\n속마음: 기다리자.' : '접수원은 종이를 정리한다.';
  if (emit) emit(text);
  call.result = result(text, calls.length % 2 ? { prompt_tokens: 31, completion_tokens: 7 } : null);
  return call.result;
}
const ctx = { db, model: { complete: (p: GenParams) => respond(p), stream: (p: GenParams, emit: (s: string) => void) => respond(p, emit) }, queue,
  resolvedModel: () => 'mock', effectiveDataDir: tmp, log: app.log } as unknown as Ctx;
for (const route of [characterRoutes, storyRoutes, conversationRoutes, chatRoutes]) app.register(route(ctx));
const saved = { flag: config.partyContext, context: config.model.contextTokens };
async function api(method: 'POST' | 'PATCH', url: string, payload: any) { const r = await app.inject({ method, url, payload }); a.ok(r.statusCode < 400, r.body); return r.json(); }
async function room(format: string, scoped = false) {
  const c = await api('POST', '/api/conversations', { characterId: cast[0].id, storyId, mode: 'story', scene: { format, location: '교실', present_ids: cast.map(c => c.id) } });
  if (scoped) {
    const root = insertMessage(db, c.id, null, 'user', '비공개 기록 승인', 'complete'); setHead(db, c.id, root.id);
    const entries = [[cast[0].id], []].map((known_by, i) => {
      const mid = `${c.id}-${i}`;
      db.prepare("INSERT INTO memories(id,conversation_id,content,source,status,importance,scope,evidence_message_ids_json,created_at,updated_at) VALUES(?,?,?,'manual','pinned',3,'conversation',?,'2026','2026')").run(mid, c.id, `SECRET_CANARY_${i}`, JSON.stringify([root.id]));
      return { memory_id: mid, anchor_message_id: root.id, kind: 'fact', known_by, status: 'active' };
    });
    await api('PATCH', `/api/conversations/${c.id}`, { scene: { dialog_context: { version: 1, entries }, pending_edit: { head_message_id: root.id } } });
  }
  return c.id as string;
}
async function send(id: string) {
  calls.length = 0;
  const response = await app.inject({ method: 'POST', url: `/api/conversations/${id}/messages`, payload: { content: '나리, USER_CANARY 조건을 알려 주세요.' } });
  const rows = db.prepare('SELECT * FROM generation_log WHERE conversation_id=? ORDER BY rowid').all(id) as any[];
  const events = response.body.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
  const m = rows.length ? JSON.parse(rows.at(-1).budget_json).party_metrics : undefined;
  if (m) allMetrics.push(m);
  return { response, rows, events, m };
}
const metricKeys = ['version','accepted_at','first_model_token_ms','first_output_ms','turn_complete_ms','termination','calls','totals'];
const callKeys = ['call_id','started_at_ms','ended_at_ms','queue_wait_ms','ttft_ms','usage_prompt_tokens','usage_completion_tokens','est_prompt_tokens','max_tokens','status','finish_reason'];
function checkCalls(m: any) {
  a.deepEqual(m.calls.map((c: any) => c.call_id), calls.map(c => c.id));
  a.equal(m.calls.length, calls.length);
  for (const [i, c] of m.calls.entries()) {
    a.deepEqual(Object.keys(c), callKeys); a.equal(c.queue_wait_ms, null);
    a.equal(c.est_prompt_tokens, calls[i].params.messages.reduce((n, message) => n + estimateMessageTokens(message.content, 1), 0));
    a.equal(c.max_tokens, calls[i].params.max_tokens);
  }
}
async function main() {
  config.model.contextTokens = 16384;
  db.prepare("INSERT INTO model_profiles(name,temperature,top_p,max_tokens,stop_json,system_mode) VALUES('rp-balanced',.8,.95,400,'[]','system')").run();
  for (const name of ['나리','세라','하연']) cast.push(await api('POST', '/api/characters', { name, scenario: `CARD_${name}_CANARY`, first_message: '', tags: ['party:place=교실'] }));
  storyId = (await api('POST', '/api/stories', { name: '합성 측정', setting: 'SETTING_CANARY 교실의 규칙.', minor_cast: [{ name: '접수원', note: '종이를 정리한다' }], scene_catalog: { places: [{ id: '교실' }] } })).id;
  for (const [i,c] of cast.entries()) await api('POST', `/api/stories/${storyId}/characters`, { characterId: c.id, sortOrder: i });
  const successful: Array<Awaited<ReturnType<typeof send>>> = [];
  await test('off creates no collector and writes no metrics for either format', async () => {
    config.partyContext = false;
    for (const format of ['beat','dialog']) { const id = await room(format), n = partyMetricsCreationCount(), r = await send(id); a.equal(r.response.statusCode, 200); a.ok(r.events.some(e => e.type === 'done')); a.equal(r.m, undefined); a.equal(partyMetricsCreationCount(), n); successful.push(r); }
  });
  await test('on beat records the actual delta N F E and C calls in contract order', async () => {
    config.partyContext = true; const r = await send(await room('beat')); a.ok(r.events.some(e => e.type === 'done'), r.response.body);
    a.deepEqual(Object.keys(r.m), metricKeys); checkCalls(r.m);
    for (const id of ['delta','N','F','C']) a.ok(calls.some(c => c.id === id));
    a.ok(calls.some(c => c.id.startsWith('E:'))); a.deepEqual(Object.keys(r.m.totals), ['usage_prompt_tokens','usage_completion_tokens','est_prompt_tokens']); successful.push(r);
  });
  await test('dialog records public and both actor and narrator scoped requests', async () => {
    const r = await send(await room('dialog', true)); a.ok(r.events.some(e => e.type === 'done'), r.response.body); checkCalls(r.m);
    a.deepEqual(calls.map(c => c.id), ['delta','S','scoped:narrator',`scoped:${cast[0].id}`]); successful.push(r);
  });
  await test('missing usage remains null with partial sums and missing counts', () => {
    let time = 10; const m = new PartyMetrics('2026-10-18T00:00:00Z', () => time);
    const one = m.start('N', 100, 300); time = 15; m.end(one, result('not stored', { prompt_tokens: 31, completion_tokens: 7 }));
    const two = m.start('F', 200, 500); time = 20; m.end(two, result('not stored', null));
    const s = m.finish('completed'); a.equal(s.calls[1].usage_prompt_tokens, null); a.equal(s.calls[1].usage_completion_tokens, null);
    a.deepEqual(s.totals, { usage_prompt_tokens: { partial_sum:31, missing_count:1 }, usage_completion_tokens:{ partial_sum:7,missing_count:1 }, est_prompt_tokens:{ partial_sum:300,missing_count:0 } });
    for (const r of successful.filter(r => r.m)) { const m = r.m; const present = m.calls.filter((c: any) => c.usage_prompt_tokens !== null).length; a.deepEqual(m.totals.usage_prompt_tokens, { partial_sum:31 * present, missing_count:m.calls.length-present }); }
  });
  await test('timing uses accepted-relative first token and first eligible output', () => {
    let time = 10; const m = new PartyMetrics('fixed', () => time); const d = m.start('delta', 10, 200); time = 20; m.end(d, { ...result(''), ttftMs:3 });
    a.equal(m.finish('completed').first_output_ms, null); const s = m.start('S', 20, 900); time = 40; m.output(); m.output(); time = 50; m.end(s, { ...result(''), ttftMs:5 });
    const out = m.finish('completed'); a.equal(out.first_model_token_ms,13); a.equal(out.first_output_ms,40); a.equal(out.turn_complete_ms,50);
    for (const r of successful.filter(r => r.m)) { a.ok(r.m.first_model_token_ms <= r.m.first_output_ms); a.ok(r.m.first_output_ms <= r.m.turn_complete_ms); a.equal(r.m.first_model_token_ms, Math.min(...r.m.calls.filter((c:any)=>c.ttft_ms!==null).map((c:any)=>c.started_at_ms+c.ttft_ms))); }
    const source = fs.readFileSync('apps/server/src/routes/chat.ts','utf8'); a.match(source, /\['narration', 'line', 'thought'\]/); a.match(source, /e\.message\.role !== 'user'/);
  });
  await test('delta failure F failure deadline and cancellation retain failed calls', async () => {
    for (const [mode,status,id] of [['delta','error','delta'],['F','error','F'],['deadline','deadline','F'],['cancel','aborted','F']]) {
      failure = mode; const r = await send(await room('beat')); failure = '';
      a.ok(r.m, r.response.body); const c = r.m.calls.find((c:any)=>c.call_id===id); a.ok(c); a.equal(c.status,status); a.equal(c.usage_prompt_tokens,null); a.ok(c.ended_at_ms!==null);
    }
    for (const [term,status] of [['internal_error','error'],['user_cancelled','aborted'],['turn_deadline_exceeded','deadline']]) { const m = new PartyMetrics('fixed',()=>25); m.start('F',3,4); const s=m.finish(term); a.equal(s.calls.length,1); a.equal(s.calls[0].ended_at_ms,25); a.equal(s.calls[0].status,status); }
  });
  await test('post-delta overflow helper writes one failure row only when enabled', async () => {
    // Attempt mutation after preflight: source cards are already frozen, so this
    // does not reach overflow. No production preflight changes are made to force it.
    mutateDelta=true; const attempt = await send(await room('beat')); mutateDelta=false;
    db.prepare("UPDATE characters SET description='' WHERE id=?").run(cast[0].id);
    a.equal(attempt.response.statusCode,200); a.equal(attempt.m.termination,'completed');
    const id = await room('beat'), m = new PartyMetrics('fixed',()=>10); const c=m.start('delta',3,200); m.end(c,result('null'));
    const log = (budget: Record<string,unknown>, reason:string) => db.prepare("INSERT INTO generation_log(id,conversation_id,profile_name,prompt_version,status,finish_reason,budget_json,created_at) VALUES(?,?,'rp-balanced','fixture','fail',?,?,?)").run(`${id}-overflow`,id,reason,JSON.stringify(budget),'2026');
    logPartyOverflowAfterDelta(null,log,{}); a.equal((db.prepare('SELECT count(*) AS n FROM generation_log WHERE conversation_id=?').get(id) as any).n,0);
    logPartyOverflowAfterDelta(m,log,{}); const rows=db.prepare('SELECT * FROM generation_log WHERE conversation_id=?').all(id) as any[];
    a.equal(rows.length,1); a.equal(rows[0].status,'fail'); a.equal(rows[0].finish_reason,'party_context_overflow'); const data=JSON.parse(rows[0].budget_json).party_metrics; a.equal(data.termination,'party_context_overflow'); a.equal(data.calls[0].status,'ok'); a.equal(data.calls[0].call_id,'delta');
  });
  await test('preflight overflow has no model call or generation log', async () => {
    for (const format of ['beat','dialog']) { const id=await room(format); db.prepare('UPDATE characters SET description=? WHERE id=?').run('가'.repeat(20000),cast[0].id); const r=await send(id); db.prepare("UPDATE characters SET description='' WHERE id=?").run(cast[0].id); a.equal(r.response.statusCode,422); a.equal(r.response.json().code,'party_context_overflow'); a.equal(calls.length,0); a.equal(r.rows.length,0); }
  });
  await test('legacy columns and SSE done semantics remain unchanged on and off', () => {
    for (const r of successful) { const row=r.rows.at(-1); for (const k of ['actual_prompt_tokens','completion_tokens','ttft_ms']) a.equal(row[k],null); a.ok(Number.isInteger(row.est_prompt_tokens) && row.est_prompt_tokens>0); a.ok(Number.isInteger(row.total_ms) && row.total_ms>=0); const done=r.events.find(e=>e.type==='done'); a.ok(done); a.deepEqual(Object.keys(done).sort(), (row.finish_reason === 'dialog' ? ['type','message','usage','ttftMs','totalMs','budget'] : ['type','message','usage','ttftMs','totalMs']).sort()); a.equal(done.usage,null); a.equal(done.ttftMs,null); a.ok(Number.isInteger(done.totalMs) && done.totalMs >= 0); }
  });
  await test('24 handwritten size conditions preserve required context and reject overflow', async () => {
    a.equal(fixture.conditions.length,24);
    for (const f of fixture.conditions) {
      const ids=Array.from({length:f.participants},(_,i)=>`a${i}`), cards=Object.fromEntries(ids.map((id,i)=>[id,{name:`인물${i}`,tagline:'',description:i===0?'가'.repeat(f.cardChars):'',personality:'',speech_style:'',taboos:'',scenario:'배경'}]));
      const s:WireSource={castIds:ids,cards,storySnapshot:{setting:'가'.repeat(f.settingChars),minorCast:['나'.repeat(f.minorChars),'조연 둘']}};
      const budget={inputLimitTokens:f.limit,outputReserveTokens:f.format==='beat'?500:900,calibration:1}; a.ok(s.storySnapshot.setting.length<=8000);
      const allowed=ids.slice(0,f.format==='beat'?1:3);
      if (f.reject) { a.throws(()=>preflightWire(s,allowed.length,budget),/party_context_overflow/); const id=await room(f.format); db.prepare('UPDATE conversations SET story_setting_snapshot=? WHERE id=?').run(s.storySnapshot.setting,id); db.prepare('UPDATE characters SET description=? WHERE id=?').run(cards.a0.description,cast[0].id); const r=await send(id); db.prepare("UPDATE characters SET description='' WHERE id=?").run(cast[0].id); a.equal(r.response.statusCode,422); a.equal(calls.length,0); }
      else { preflightWire(s,allowed.length,budget); const b=buildWireBlock(s,allowed,ids,budget).diagnostics; a.equal(b.inputLimitTokens,f.limit); a.equal(b.sections.find(x=>x.key==='setting')?.status,'included_full'); a.equal(b.sections.find(x=>x.key==='scene')?.reason,'empty'); for(const id of allowed) a.equal(b.sections.find(x=>x.key===`card:${id}`)?.status,'included_full'); a.equal(b.sections.find(x=>x.key==='minor:0')?.status,f.minorStatus); if(f.minorStatus==='omitted'){a.equal(b.sections.find(x=>x.key==='minor:0')?.reason,'budget');a.equal(b.sections.find(x=>x.key==='minor:1')?.reason,'budget');} a.ok(b.totalEstimatedTokens<=f.limit); }
    }
  });
  await test('metrics contain none of the setting card input or secret canaries', () => { const text=JSON.stringify(allMetrics); for(const canary of ['SETTING_CANARY','CARD_','USER_CANARY','SECRET_CANARY']) a.ok(!text.includes(canary)); });
  await test('collector has no DB config or network imports', () => { const text=fs.readFileSync('apps/server/src/model/partyMetrics.ts','utf8'); a.doesNotMatch(text,/import[^;]*(?:db\/|config|node:|fetch)/); a.doesNotMatch(text,/\bfetch\s*\(/); });
  console.log(`passed ${passed} checks; ${assertions} assertions`);
}
main().finally(async()=>{config.partyContext=saved.flag; config.model.contextTokens=saved.context; await app.close(); db.close(); fs.rmSync(tmp,{recursive:true,force:true});}).catch(e=>{console.error(e);process.exitCode=1;});
