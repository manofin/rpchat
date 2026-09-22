import assert from 'node:assert/strict';
import { ApiError, sendOkForComposer, streamPost, StreamInterruptedError } from '../apps/web/src/lib/api';
import { initialChatState, reduceChatEvent } from '../apps/web/src/lib/chatStreamState';
import type { ChatEvent, Message, SseEvent } from '../apps/web/src/types';

const conversationId = 'room-a';
const message = (id: string, overrides: Partial<Message> = {}): Message => ({
  id, conversation_id: conversationId, parent_id: null, role: 'assistant', content: 'RAW_MUST_NOT_RENDER',
  eventVersion: 1, events: [], status: 'streaming', meta: {}, bookmarked: false,
  created_at: '2026-09-22T00:00:00.000Z', siblings: { index: 0, count: 1, ids: [id] }, ...overrides,
});
const dialogue = (text: string): ChatEvent => ({ id: 'a:0', type: 'dialogue', actorId: 'actor-a', actorName: '아리', text });
const start = (id: string, parentId: string | null = null): SseEvent => ({ type: 'start', generationId: 'generation-a', messageId: id, eventVersion: 1, message: message(id, { parent_id: parentId }) });
const done = (id: string, overrides: Partial<Message> = {}): SseEvent => ({ type: 'done', message: message(id, { status: 'complete', ...overrides }), usage: null, ttftMs: null, totalMs: 1 });
const apply = (state: typeof initialChatState, event: SseEvent) => reduceChatEvent(state, event, conversationId);
let passed = 0;
function test(name: string, run: () => void) { run(); console.log(`ok ${++passed} ${name}`); }

test('start and token replay preserve one message and replace the full event snapshot', () => {
  let state = apply(initialChatState, start('a'));
  const token: SseEvent = { type: 'token', messageId: 'a', eventVersion: 1, text: 'RAW_THOUGHT', events: [dialogue('안녕')] };
  state = apply(state, token);
  state = apply(state, start('a'));
  state = apply(state, token);
  assert.equal(state.messages.length, 1);
  assert.deepEqual(state.messages[0].events, [dialogue('안녕')]);
  assert.equal(state.messages[0].content, 'RAW_MUST_NOT_RENDER');
  state = apply(state, { ...token, events: [dialogue('안녕하세요')] });
  assert.deepEqual(state.messages[0].events, [dialogue('안녕하세요')]);
});
test('done upserts a missed start, aux upserts without duplicates, late start cannot reopen done', () => {
  let state = apply(initialChatState, done('a'));
  state = apply(state, done('a'));
  state = apply(state, start('a'));
  state = apply(state, { type: 'aux', message: message('b', { parent_id: 'a', status: 'complete', events: [dialogue('처음')] }) });
  state = apply(state, { type: 'aux', message: message('b', { parent_id: 'a', status: 'complete', events: [dialogue('갱신')] }) });
  assert.deepEqual(state.messages.map((row) => row.id), ['a', 'b']);
  assert.equal(state.generating, false);
  assert.deepEqual(state.messages[1].events, [dialogue('갱신')]);
});
test('old row tokens and done do not overwrite or settle the current row', () => {
  let state = apply(initialChatState, done('a'));
  state = apply(state, start('b', 'a'));
  state = apply(state, { type: 'token', messageId: 'a', eventVersion: 1, text: 'late', events: [dialogue('late')] });
  state = apply(state, done('a'));
  assert.equal(state.streamingId, 'b');
  assert.equal(state.generating, true);
  assert.deepEqual(state.messages[0].events, []);
});
test('obsolete room start, done and aux cannot insert messages into the active room', () => {
  for (const event of [
    { ...start('other'), message: message('other', { conversation_id: 'room-b' }) },
    done('other', { conversation_id: 'room-b' }),
    { type: 'aux', message: message('other', { conversation_id: 'room-b' }) },
  ] as SseEvent[]) assert.equal(apply(initialChatState, event), initialChatState);
});
test('older server token cannot become display content', () => {
  const state = apply(apply(initialChatState, start('a')), { type: 'token', text: '<think>secret</think>' } as SseEvent);
  assert.match(state.error ?? '', /새로고침/);
  assert.deepEqual(state.messages[0].events, []);
});
test('regeneration selects the new sibling immediately and preserves its parent', () => {
  let state = { ...initialChatState, messages: [message('user', { role: 'user' }), message('old', { parent_id: 'user', status: 'complete' })] };
  state = apply(state, start('new', 'user'));
  assert.deepEqual(state.messages.map((row) => row.id), ['user', 'new']);
  state = apply(state, done('new', { parent_id: 'user', siblings: { index: 1, count: 2, ids: ['old', 'new'] } }));
  assert.deepEqual(state.messages.map((row) => row.id), ['user', 'new']);
  assert.equal(state.messages[1].siblings.count, 2);
});
test('party aux before start replaces the old turn; focus done preserves later aux rows', () => {
  let state = { ...initialChatState, messages: [message('user', { role: 'user' }), message('old-header', { parent_id: 'user' }), message('old-focus', { parent_id: 'old-header' })] };
  state = apply(state, { type: 'aux', message: message('new-header', { parent_id: 'user', status: 'complete' }) });
  assert.deepEqual(state.messages.map((row) => row.id), ['user', 'new-header']);
  state = apply(state, start('new-focus', 'new-header'));
  state = apply(state, { type: 'aux', message: message('new-ui', { parent_id: 'new-focus', status: 'complete' }) });
  state = apply(state, done('new-focus', { parent_id: 'new-header' }));
  assert.deepEqual(state.messages.map((row) => row.id), ['user', 'new-header', 'new-focus', 'new-ui']);
});
test('branch edit selects the new user ancestry and new root replaces a root sibling', () => {
  let state = { ...initialChatState, messages: [message('greeting'), message('old-user', { parent_id: 'greeting', role: 'user' }), message('old', { parent_id: 'old-user' })] };
  const event = start('new', 'new-user');
  assert.equal(event.type, 'start');
  state = apply(state, { ...event, userMessage: message('new-user', { parent_id: 'greeting', role: 'user' }) });
  assert.deepEqual(state.messages.map((row) => row.id), ['greeting', 'new-user', 'new']);
  state = apply(state, start('root-replacement'));
  assert.deepEqual(state.messages.map((row) => row.id), ['root-replacement']);
});

const originalFetch = globalThis.fetch;
async function transport(frames: string[], onEvent: (event: SseEvent) => void = () => {}) {
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
    for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
    controller.close();
  } }), { status: 200 });
  try { await streamPost('/fixture', {}, onEvent); } finally { globalThis.fetch = originalFetch; }
}
const frame = (event: SseEvent) => `data: ${JSON.stringify(event)}\n\n`;

async function main() {
await transport([frame(start('a')).slice(0, 17), frame(start('a')).slice(17), frame(done('a'))]);
console.log(`ok ${++passed} fragmented frames complete`);
const observed: SseEvent[] = [];
await transport([frame(start('a')).replaceAll('\n', '\r\n'), ': heartbeat\r\n\r\n', 'data: malformed\r\n\r\n', frame(done('a')).replaceAll('\n', '\r\n')], (event) => observed.push(event));
assert.equal(observed.length, 2);
console.log(`ok ${++passed} CRLF, heartbeat and malformed frame preserve valid events`);
for (const [label, frames] of [
  ['EOF during row', [frame(start('a')), 'data: {"type":"token"']],
  ['EOF before start', []],
  ['EOF between party rows', [frame(start('a')), frame(done('a')), frame(start('b'))]],
] as const) {
  await assert.rejects(transport([...frames]), (error) => error instanceof StreamInterruptedError && sendOkForComposer(error, false));
  console.log(`ok ${++passed} ${label} raises resync error without restoring submitted composer`);
}
await transport([frame({ type: 'error', message: 'failed' })]);
assert.equal(sendOkForComposer(new ApiError(400, 'rejected'), false), false);
assert.equal(sendOkForComposer(new ApiError(499, 'stopped'), false), true);
assert.equal(sendOkForComposer(new Error('network'), true), true);
console.log(`ok ${++passed} terminal failure and composer failure/stop semantics remain distinct`);
const callbackFailure = new Error('callback');
await assert.rejects(transport([frame(done('a'))], () => { throw callbackFailure; }), (error) => error === callbackFailure);
console.log(`ok ${++passed} consumer exceptions are not mistaken for malformed JSON`);
console.log(`passed ${passed}`);

}
main().catch((error) => { console.error(error); process.exit(1); });
