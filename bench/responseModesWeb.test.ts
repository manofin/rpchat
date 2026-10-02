/** npm run test:benches -- responseModesWeb */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { continuationTarget, buildResponseLengthPatch, parseSideModeCommand } from '../apps/web/src/lib/responseControls.ts';
import { expandLeadingShortcut, resolveShortcutSubmit } from '../apps/web/src/lib/shortcutMacro.ts';
import { ResponseLengthSelect } from '../apps/web/src/components/ResponseLengthSelect.tsx';
import { SideModePanel } from '../apps/web/src/components/SideModePanel.tsx';
import { initialChatState, reduceChatEvent } from '../apps/web/src/lib/chatStreamState.ts';
import type { Message, SseEvent } from '../apps/web/src/types.ts';

let passed = 0;
async function test(name: string, body: () => void | Promise<void>) { await body(); console.log(`ok ${++passed} ${name}`); }
const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'answer', conversation_id: 'room', parent_id: 'user', role: 'assistant', content: 'raw should not render',
  status: 'complete', meta: {}, created_at: '2026-10-02T00:00:00Z', bookmarked: false,
  siblings: { index: 0, count: 1, ids: ['answer'] }, eventVersion: 1,
  events: [{ type: 'narration', id: 'event', text: '현재 이야기입니다.' }], ...overrides,
});
const source = (path: string) => ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function nodeAt(file: ts.SourceFile, predicate: (node: ts.Node) => boolean): ts.Node {
  let result: ts.Node | undefined;
  function visit(node: ts.Node) { if (predicate(node)) result ??= node; ts.forEachChild(node, visit); }
  visit(file);
  assert.ok(result, 'production callback must exist');
  return result;
}
function callback(file: ts.SourceFile, name: string): string {
  const node = nodeAt(file, (node) => (ts.isFunctionDeclaration(node) && node.name?.text === name) || (ts.isVariableDeclaration(node) && node.name.getText(file) === name));
  if (ts.isFunctionDeclaration(node)) return node.getText(file);
  const init = (node as ts.VariableDeclaration).initializer as ts.CallExpression;
  return init.arguments[0].getText(file);
}
function compile(code: string, context: Record<string, unknown>): (...args: any[]) => any {
  const compiled = ts.transpileModule(`exports.callback = ${code}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;
  const exported: { callback?: (...args: any[]) => any } = {};
  new Function(...Object.keys(context), 'exports', compiled)(...Object.values(context), exported);
  return exported.callback!;
}
const chatPage = source('apps/web/src/pages/ChatPage.tsx');
const useChat = source('apps/web/src/pages/useChat.ts');
const sideHook = source('apps/web/src/pages/useSideMode.ts');
const outputPage = source('apps/web/src/pages/ConversationOutputPage.tsx');

async function main() {
await test('built-in commands recognize exact names and keep additional text separate', () => {
  assert.deepEqual(parseSideModeCommand(' /요약 '), { mode: 'summary' });
  assert.deepEqual(parseSideModeCommand('/심층갤 최근 탈출\n반응'), { mode: 'community', prompt: '최근 탈출\n반응' });
  for (const input of ['/요약문', '말하다 /요약', '/심층갤러리', '/other']) assert.equal(parseSideModeCommand(input), null);
});
await test('length selection only changes response_length and rejects unknown values', () => {
  assert.deepEqual(buildResponseLengthPatch('long'), { scene: { response_length: 'long' } });
  assert.equal(buildResponseLengthPatch('99999'), null);
  const html = renderToStaticMarkup(React.createElement(ResponseLengthSelect, { value: 'normal', disabled: true, onChange() {} }));
  assert.match(html, /aria-label="응답 길이"/);
  assert.match(html, /value="normal" selected=""/);
  assert.match(html, /disabled=""/);
  for (const label of ['짧게', '보통', '길게', '출력\/톤 프로필은 유지']) assert.match(html, new RegExp(label));
});
await test('production length save sends a narrow patch and displays server failure without false success', async () => {
  for (const reject of [false, true]) {
    let stored = 'normal'; let shownError: string | null = null; const pending: boolean[] = [];
    const save = compile(callback(outputPage, 'onLengthChange'), {
      buildResponseLengthPatch, pending: false, conversationId: 'room', setPending: (value: boolean) => pending.push(value),
      setError: (value: string | null) => { shownError = value; }, setResponseLength: (value: string) => { stored = value; },
      patch: async (path: string, body: unknown) => {
        assert.equal(path, '/api/conversations/room'); assert.deepEqual(body, { scene: { response_length: 'long' } });
        if (reject) throw new Error('busy'); return { scene: { response_length: 'long' } };
      },
    });
    await save('long');
    assert.equal(stored, reject ? 'normal' : 'long'); assert.equal(shownError, reject ? 'busy' : null); assert.deepEqual(pending, [true, false]);
  }
});
await test('continuation targets only the latest eligible response and preserves completed beat UI head eligibility', () => {
  const answer = message();
  assert.equal(continuationTarget([answer]), answer);
  assert.equal(continuationTarget([answer, message({ id: 'u2', role: 'user' })]), null);
  assert.equal(continuationTarget([message({ status: 'error' })]), null);
  assert.equal(continuationTarget([message({ status: 'streaming' })]), null);
  assert.equal(continuationTarget([message({ meta: { side_mode: { mode: 'summary', prompt: '', anchor_message_id: 'u' } } })]), null);
  assert.equal(continuationTarget([message({ meta: { block_kind: 'ui' }, status: 'interrupted' })])?.id, 'answer');
});
await test('production continuation callback sends no user text or private recipient override', async () => {
  const calls: unknown[] = [];
  const run = compile(callback(useChat, 'continueResponse'), { conversationId: 'room', runStream: (path: string, body: unknown) => calls.push([path, body]) });
  await run('answer'); assert.deepEqual(calls, [['/api/conversations/room/continue', { messageId: 'answer' }]]);
});
await test('continuation button is disabled during either generation or ended room', () => {
  const button = nodeAt(chatPage, (node) => ts.isJsxElement(node) && node.openingElement.tagName.getText(chatPage) === 'button' && node.children.some((child) => ts.isJsxText(child) && child.text.trim() === '이어서 생성'));
  for (const [generating, ended] of [[false, false], [true, false], [false, true]]) {
    const render = compile(`() => (${button.getText(chatPage)})`, { React, generating, ended, continueFrom: message(), stickyRef: { current: false }, chat: { continueResponse() {} } });
    assert.equal(/disabled=""/.test(renderToStaticMarkup(render())), generating || ended);
  }
});
await test('production submit routes reserved commands before macros and never inherits whispers or choice provenance', async () => {
  for (const accepted of [true, false]) {
    let draft = '/요약 최근 약속'; let clearedChoice = false; let clearedWhisper = false; let opened = false;
    const calls: unknown[] = [];
    const submit = compile(callback(chatPage, 'submit'), {
      draft, generating: false, chat: { detail: { conversation: { ended_at: null } }, send() { assert.fail('side command must not enter main send'); } },
      parseSideModeCommand, resolveShortcutSubmit, readShortcuts: () => [{ name: '요약', text: 'override', mode: 'inject' }],
      choiceDraft: { visibility: 'private', recipient_ids: ['old-recipient'] }, whisperIds: 'old-recipient',
      setSideTab: (mode: string) => assert.equal(mode, 'summary'), setSideOpen: (value: boolean) => { opened = value; },
      setChoiceDraft: (value: unknown) => { clearedChoice = value === null; }, setWhisperIds: (value: string) => { clearedWhisper = value === ''; },
      setDraft: (value: string | ((value: string) => string)) => { draft = typeof value === 'function' ? value(draft) : value; },
      sideMode: { generate: async (...args: unknown[]) => { calls.push(args); return accepted; } },
    });
    await submit(); assert.deepEqual(calls, [['summary', '최근 약속']]); assert.equal(opened && clearedChoice && clearedWhisper, true);
    assert.equal(draft, accepted ? '' : '/요약 최근 약속');
  }
});
await test('production typing keeps reserved commands intact even when an insert shortcut has the same name', () => {
  const attribute = nodeAt(chatPage, (node) => ts.isJsxAttribute(node) && node.name.getText(chatPage) === 'onChange' && node.getText(chatPage).includes('parseSideModeCommand')) as ts.JsxAttribute;
  const expression = (attribute.initializer as ts.JsxExpression).expression!;
  let draft = '';
  const type = compile(expression.getText(chatPage), { parseSideModeCommand, expandLeadingShortcut, readShortcuts: () => [{ name: '요약', text: 'dangerous replacement' }], setDraft: (value: string) => { draft = value; } });
  type({ target: { value: '/요약 약속' } }); assert.equal(draft, '/요약 약속');
});
await test('side-mode reducer uses canonical replacement events without inserting rows in main state', async () => {
  const scope = { conversationId: 'room', revision: 0, sequence: 0 };
  let state = { ...initialChatState, loading: false };
  const main = [message()]; const calls: unknown[] = [];
  const row = message({ id: 'side', status: 'streaming', meta: { generation_id: 'generation', side_mode: { mode: 'summary', prompt: '', anchor_message_id: 'answer' } }, events: [] });
  const done = { ...row, status: 'complete' as const, events: [{ type: 'narration' as const, id: 'e', text: '따로 저장된 요약' }] };
  const controllerRef = { current: null as AbortController | null };
  const run = compile(callback(sideHook, 'generate'), {
    state, controllerRef, generationRef: { current: null }, scopeRef: { current: scope }, scope, conversationId: 'room', AbortController,
    setConnected() {}, setState: (update: typeof state | ((value: typeof state) => typeof state)) => { state = typeof update === 'function' ? update(state) : update; }, reduceChatEvent,
    reload: async () => { state = { ...state, generating: false }; },
    streamPost: async (path: string, body: unknown, emit: (event: SseEvent) => void) => {
      calls.push([path, body]);
      emit({ type: 'start', generationId: 'generation', messageId: row.id, message: row, eventVersion: 1 });
      emit({ type: 'token', messageId: row.id, eventVersion: 1, text: '요약', events: done.events });
      assert.deepEqual(state.messages[0].events, done.events);
      emit({ type: 'done', message: done, usage: {}, ttftMs: 1, totalMs: 2 });
    },
  });
  assert.equal(await run('summary', '약속'), true);
  assert.deepEqual(calls, [['/api/conversations/room/side-mode', { mode: 'summary', prompt: '약속' }]]);
  assert.equal(state.messages.length, 1); assert.equal(state.messages[0].id, 'side'); assert.equal(main.length, 1); assert.equal(main[0].id, 'answer'); assert.equal(controllerRef.current, null);
});
await test('reloaded side-mode rows recover generation identity and ignore a stale room response', async () => {
  for (const stale of [false, true]) {
    const scope = { conversationId: 'room', revision: 0, sequence: 0 }; const scopeRef = { current: scope };
    let applied = 0; const generationRef = { current: null as string | null };
    const reload = compile(callback(sideHook, 'reload'), {
      scope, scopeRef, conversationId: 'room', generationRef,
      get: async () => { if (stale) scopeRef.current = { conversationId: 'other', revision: 0, sequence: 0 }; return [message({ status: 'streaming', meta: { generation_id: 'persisted-job' } })]; },
      setState: (update: (state: typeof initialChatState) => typeof initialChatState) => { const result = update(initialChatState); assert.equal(result.generating, true); assert.equal(result.streamingId, 'answer'); applied++; },
    });
    await reload(); assert.equal(applied, stale ? 0 : 1); assert.equal(generationRef.current, stale ? null : 'persisted-job');
  }
});
await test('ended rooms can generate read-only side modes while main composer stays locked', () => {
  const panel = nodeAt(chatPage, (node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText(chatPage) === 'SideModePanel') as ts.JsxSelfClosingElement;
  const attr = panel.attributes.properties.find((item) => ts.isJsxAttribute(item) && item.name.getText(chatPage) === 'disabled') as ts.JsxAttribute;
  const condition = (attr.initializer as ts.JsxExpression).expression!.getText(chatPage);
  for (const generating of [false, true]) {
    assert.equal(compile(`() => (${condition})`, { generating, ended: true })(), generating, 'ended alone must not lock read-only mode');
  }
  const input = nodeAt(chatPage, (node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText(chatPage) === 'textarea' && node.getText(chatPage).includes('enterKeyHint="send"')) as ts.JsxSelfClosingElement;
  const disabled = input.attributes.properties.find((item) => ts.isJsxAttribute(item) && item.name.getText(chatPage) === 'disabled') as ts.JsxAttribute;
  assert.equal(compile(`() => (${(disabled.initializer as ts.JsxExpression).expression!.getText(chatPage)})`, { ended: true })(), true);
});
await test('side-mode panel labels isolation and renders canonical output, not raw model content', () => {
  const row = message({ meta: { side_mode: { mode: 'community', prompt: '탈출 반응', anchor_message_id: 'answer' } } });
  const props = { open: true, mode: 'community' as const, onModeChange() {}, onClose() {}, messages: [row], loading: false, generating: false, disabled: true, error: null, onGenerate: async () => false, onStop() {}, onReload() {} };
  const html = renderToStaticMarkup(React.createElement(SideModePanel, props));
  assert.match(html, /본편 상태에 반영하지 않음/); assert.match(html, /현재 이야기입니다/); assert.match(html, /심층갤/); assert.doesNotMatch(html, /raw should not render/);
  assert.match(html, /disabled=""[^>]*>심층갤 생성/);
  assert.equal(renderToStaticMarkup(React.createElement(SideModePanel, { ...props, open: false })), '');
});
console.log(`passed ${passed}`);

}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
