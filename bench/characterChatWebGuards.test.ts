/**
 * npx tsx bench/characterChatWebGuards.test.ts
 * character-chat-web-guards — CharacterPage count/last-chat fallback + useChat send latch.
 * Isolated: no systemd, no live DB, no model, no generate, no server import.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import ts from 'typescript';
import { ApiError, sendOkForComposer } from '../apps/web/src/lib/api.ts';
import { resolveShortcutSubmit } from '../apps/web/src/lib/shortcutMacro.ts';

const require2 = createRequire(import.meta.url);
let stats: typeof import('../apps/web/src/lib/characterChatStats.ts');
try {
  stats = require2('../apps/web/src/lib/characterChatStats.ts');
} catch (e) {
  console.error('RED: helper module missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

const {
  resolveConversationCount,
  resolveLastChatAt,
  characterHeroEmpty,
} = stats;

let passed = 0;
const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];
function t(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, '..');
const src = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

t('1 detail conversation_count wins; missing falls back to convs.length', () => {
  assert.equal(resolveConversationCount(7, 2), 7);
  assert.equal(resolveConversationCount(0, 4), 0);
  assert.equal(resolveConversationCount(undefined, 4), 4);
  assert.equal(resolveConversationCount(null, 3), 3);
  const page = src('apps/web/src/pages/CharacterPage.tsx');
  assert.match(page, /resolveConversationCount\(/);
  assert.match(page, /conversation_count/);
});

t('2 conversations fetch includes limit=200', () => {
  const page = src('apps/web/src/pages/CharacterPage.tsx');
  assert.match(page, /\/api\/conversations\?characterId=\$\{id\}&limit=200/);
});

t('3 last_chat_at missing picks latest last_message_at', () => {
  const convs = [
    { last_message_at: '2026-01-01T00:00:00.000Z' },
    { last_message_at: '2026-03-01T00:00:00.000Z' },
    { last_message_at: null },
  ];
  assert.equal(resolveLastChatAt('2026-02-01T00:00:00.000Z', convs), '2026-02-01T00:00:00.000Z');
  assert.equal(resolveLastChatAt(null, convs), '2026-03-01T00:00:00.000Z');
  assert.equal(resolveLastChatAt(undefined, convs), '2026-03-01T00:00:00.000Z');
  assert.equal(resolveLastChatAt(undefined, []), null);
  const page = src('apps/web/src/pages/CharacterPage.tsx');
  assert.match(page, /resolveLastChatAt\(/);
});

t('4 empty hero copy only when resolved count is 0', () => {
  assert.equal(characterHeroEmpty(0), true);
  assert.equal(characterHeroEmpty(1), false);
  const page = src('apps/web/src/pages/CharacterPage.tsx');
  assert.match(page, /characterHeroEmpty\(/);
  assert.match(page, /아직 대화 없음/);
  assert.doesNotMatch(page, /char\.conversation_count\s*\?/);
});

function callback(name: string, dependencies: Record<string, unknown>, file = 'apps/web/src/pages/useChat.ts') {
  const source = ts.createSourceFile(file, src(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const callbacks: ts.Node[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      assert.ok(node.initializer, `${name} must have an executable callback`);
      callbacks.push(ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer);
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) callbacks.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(callbacks.length, 1, `one ${name} callback`);
  const compiled = ts.transpileModule(`return (${callbacks[0].getText(source)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(dependencies), compiled)(...Object.values(dependencies));
}

function streamHarness(transport: () => Promise<void>, generating = false) {
  const abortRef: { current: AbortController | null } = { current: null };
  const scope = { conversationId: 'fixture-room', revision: 0, reloadSequence: 0 };
  const visible = { generating, streamingId: 'previous' as string | null, error: null as string | null };
  const requests: Array<{ path: string; body: unknown }> = [];
  const connected: boolean[] = [];
  let reloads = 0;
  const runStream = callback('runStream', {
    state: { generating }, abortRef, scope, scopeRef: { current: scope }, genIdRef: { current: null },
    AbortController, ApiError, sendOkForComposer,
    setStreamConnected: (value: boolean) => connected.push(value),
    patchState: (patch: Partial<typeof visible>) => Object.assign(visible, patch),
    applyEvent: () => {},
    reload: async () => {
      assert.equal(abortRef.current, null, 'release the send latch before recovery');
      assert.equal(visible.generating, false, 'release generating before recovery');
      reloads++;
      return null;
    },
    streamPost: async (path: string, body: unknown, _onEvent: unknown, signal: AbortSignal) => {
      assert.equal(visible.generating, true, 'generating becomes true before POST');
      assert.equal(signal, abortRef.current?.signal, 'POST uses the latched controller');
      requests.push({ path, body });
      await transport();
    },
  }) as (path: string, body: unknown) => Promise<boolean | undefined>;
  const send = callback('send', { conversationId: scope.conversationId, runStream }) as
    (content: string, options?: { inject_instruction?: string }) => Promise<boolean | undefined>;
  return { runStream, send, abortRef, visible, requests, connected, reloads: () => reloads };
}

t('5 running generation and an in-flight transport each block duplicate POST', async () => {
  const active = streamHarness(async () => {}, true);
  assert.equal(await active.send('already generating'), undefined);
  assert.equal(active.requests.length, 0);

  let release!: () => void;
  const pending = streamHarness(() => new Promise<void>((resolve) => { release = resolve; }));
  const first = pending.send('first');
  assert.equal(pending.requests.length, 1);
  const duplicate = pending.send('duplicate');
  assert.equal(pending.requests.length, 1, 'a duplicate before React rerenders still has one POST');
  assert.equal(await duplicate, undefined);
  release();
  assert.equal(await first, true);
  assert.equal(pending.abortRef.current, null);
});

t('6 generating and connection state are set before POST', async () => {
  const current = streamHarness(async () => {});
  assert.equal(await current.send('fixture'), true);
  assert.equal(current.requests.length, 1);
  assert.deepEqual(current.connected, [true, false]);
});

t('7 failed POST clears generating and latch, preserves error, and permits retry', async () => {
  const current = streamHarness(async () => { throw new ApiError(400, 'fixture rejection'); });
  assert.equal(await current.send('first'), false);
  assert.equal(current.visible.generating, false);
  assert.equal(current.visible.streamingId, null);
  assert.equal(current.visible.error, 'fixture rejection');
  assert.equal(current.abortRef.current, null);
  assert.equal(current.reloads(), 1);
  assert.equal(await current.send('retry'), false);
  assert.equal(current.requests.length, 2, 'failure does not leave the send latch stuck');
  assert.equal(current.reloads(), 2);
});

t('8 composer and choice send use the message endpoint and preserve optional injection', async () => {
  const current = streamHarness(async () => {});
  const pending: Array<Promise<boolean | undefined>> = [];
  const dependencies = {
    draft: 'typed text', resolveShortcutSubmit, readShortcuts: () => [],
    chat: { generating: false, detail: { conversation: { ended_at: null } },
      send: (text: string, options?: { inject_instruction?: string }) => {
        const promise = current.send(text, options);
        pending.push(promise);
        return promise;
      } },
    setDraft: () => {}, requestAnimationFrame: () => {}, grow: () => {}, stickyRef: { current: false },
  };
  await callback('submit', dependencies, 'apps/web/src/pages/ChatPage.tsx')();
  callback('onChoice', dependencies, 'apps/web/src/pages/ChatPage.tsx')('choice text');
  await Promise.all(pending);
  await current.send('', { inject_instruction: 'fixture instruction' });
  assert.deepEqual(current.requests, [
    { path: '/api/conversations/fixture-room/messages', body: { content: 'typed text' } },
    { path: '/api/conversations/fixture-room/messages', body: { content: 'choice text' } },
    { path: '/api/conversations/fixture-room/messages', body: { content: '', inject_instruction: 'fixture instruction' } },
  ]);
});

t('9 no server file changes in this slice', () => {
  const changed = execSync('git diff --name-only HEAD -- apps/server', { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(changed, '');
  const untracked = execSync('git ls-files --others --exclude-standard -- apps/server', { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(untracked, '');
});

async function main() {
  for (const { name, fn } of tests) {
    await fn();
    console.log(`ok ${++passed} ${name}`);
  }
  console.log(`passed ${passed}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
