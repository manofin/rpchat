/** Execute production hook callbacks with controlled I/O; no network, DB or model. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { initialChatState, reduceChatEvent } from '../apps/web/src/lib/chatStreamState';
import { ApiError, isUserCancelledRequest, requestFailureCode, sendOkForComposer, StreamInterruptedError } from '../apps/web/src/lib/api';

const file = ts.createSourceFile('useChat.ts', fs.readFileSync('apps/web/src/pages/useChat.ts', 'utf8'), ts.ScriptTarget.Latest, true);
function callback(name: string, deps: Record<string, unknown>) {
  let code = '';
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name && node.initializer && ts.isCallExpression(node.initializer)) code = node.initializer.arguments[0].getText(file);
    ts.forEachChild(node, visit);
  }
  visit(file); assert.ok(code, `${name} callback exists`);
  const compiled = ts.transpileModule(`return (${code});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(deps), compiled)(...Object.values(deps));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function message(id: string) {
  return { id, conversation_id: 'room', parent_id: null, role: 'assistant', status: 'complete', content: id, eventVersion: 1, events: [], meta: {}, siblings: { index: 0, count: 1, ids: [id] }, bookmarked: false, created_at: '2026-10-20' } as any;
}
function detail(head: string) {
  return { conversation: { id: 'room', head_message_id: head, mode: 'chat', scene: {} }, messages: [message(head)], activeGeneration: null } as any;
}
function harness() {
  let state: any = { ...initialChatState, loading: false, detail: detail('A'), messages: [message('A')], pendingDraft: 'next unsent action' };
  const scope = { conversationId: 'room', revision: 0, reloadSequence: 0 };
  const scopeRef: { current: typeof scope | null } = { current: scope };
  const abortRef: { current: AbortController | null } = { current: null };
  let persisted = detail('A');
  let gets = 0;
  const io = { read: async () => persisted, remove: async () => ({ messages: persisted.messages }) };
  const base = { scope, scopeRef, abortRef, genIdRef: { current: null }, conversationId: 'room',
    setState: (update: (previous: any) => any) => { state = update(state); },
    patchState: (patch: any) => { if (scopeRef.current === scope) state = { ...state, ...patch }; },
    get: async () => { gets++; return io.read(); } };
  const reload = callback('reload', base);
  const applyEvent = (event: any) => { scope.revision++; state = reduceChatEvent(state, event, 'room'); };
  const run = callback('runStream', { ...base, state, reload, AbortController, ApiError, isUserCancelledRequest, requestFailureCode, sendOkForComposer, StreamInterruptedError,
    setStreamConnected: () => {}, applyEvent,
    streamPost: async (_path: string, _body: unknown, emit: (event: any) => void) => {
      emit({ type: 'start', generationId: 'g', messageId: 'B', message: { ...message('B'), status: 'streaming' }, eventVersion: 1 });
      persisted = { ...detail('internal-anchor'), messages: [message('A'), message('B')] };
      emit({ type: 'done', message: message('B'), usage: null, ttftMs: null, totalMs: 1 });
    },
  });
  const remove = callback('deleteMessage', { ...base, reload, del: () => io.remove() });
  return { scope, scopeRef, abortRef, io, run, reload, remove, applyEvent, state: () => state, gets: () => gets, persist: (head: string) => { persisted = detail(head); } };
}
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`ok ${++passed} ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}:`, (error as Error).message); }
}
async function main() {
  await test('ordinary successful stream reloads authoritative head without changing pending draft', async () => {
    const h = harness();
    assert.equal(await h.run('/fixture', { content: 'sent' }), true);
    assert.equal(h.state().detail.conversation.head_message_id, 'internal-anchor');
    assert.equal(h.state().messages.at(-1).id, 'B', 'raw head need not equal the projected visible tail');
    assert.equal(h.state().pendingDraft, 'next unsent action');
    assert.equal(h.gets(), 1);
  });
  await test('delete reloads authoritative head and scene after applying returned messages', async () => {
    const h = harness(); h.persist('parent');
    await h.remove('A');
    assert.equal(h.state().detail.conversation.head_message_id, 'parent');
    assert.equal(h.state().messages.at(-1).id, 'parent');
    assert.equal(h.state().pendingDraft, 'next unsent action');
  });
  await test('a delayed completion reload cannot replace a newer active stream snapshot', async () => {
    const h = harness(); const read = deferred<any>(); h.io.read = () => read.promise;
    const work = h.run('/fixture', {});
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(h.gets(), 1);
    h.abortRef.current = new AbortController();
    h.applyEvent({ type: 'start', generationId: 'new', messageId: 'C', message: { ...message('C'), parent_id: 'B', status: 'streaming' }, eventVersion: 1 });
    read.resolve(detail('old-reload'));
    await work;
    assert.equal(h.state().messages.at(-1).id, 'C');
    assert.equal(h.state().generating, true);
    assert.equal(h.state().pendingDraft, 'next unsent action');
  });
  await test('delayed deletion cannot erase a newer stream or issue a snapshot read during it', async () => {
    const h = harness(); const deletion = deferred<any>(); h.io.remove = () => deletion.promise;
    const work = h.remove('A');
    h.abortRef.current = new AbortController();
    h.applyEvent({ type: 'start', generationId: 'new', messageId: 'C', message: { ...message('C'), status: 'streaming' }, eventVersion: 1 });
    deletion.resolve({ messages: [] }); await work;
    assert.equal(h.state().messages.at(-1).id, 'C'); assert.equal(h.state().generating, true); assert.equal(h.gets(), 0);
  });
  await test('old-room deletion response cannot change state or reload a new room', async () => {
    const h = harness(); const deletion = deferred<any>(); h.io.remove = () => deletion.promise;
    const work = h.remove('A'); h.scopeRef.current = { conversationId: 'other', revision: 0, reloadSequence: 0 };
    deletion.resolve({ messages: [] }); await work;
    assert.equal(h.state().messages.at(-1).id, 'A'); assert.equal(h.gets(), 0);
  });
  if (failed) process.exitCode = 1;
  console.log(JSON.stringify({ passed, failed }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
