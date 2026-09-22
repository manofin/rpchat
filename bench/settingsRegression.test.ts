/** npx tsx bench/settingsRegression.test.ts
 * Settings invariants and chat recovery behavior; synthetic I/O only.
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import type { Message, SseEvent } from '../apps/web/src/types.ts';
import { ApiError, sendOkForComposer, StreamInterruptedError } from '../apps/web/src/lib/api.ts';
import { WEB_APP_VERSION } from '../apps/web/src/lib/conversationSettings.ts';

const root = join(import.meta.dirname, '..');
let passed = 0;
async function t(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

function git(args: string): string {
  return execSync(`git ${args}`, { cwd: root, encoding: 'utf8' });
}

async function main() {
await t('WEB_APP_VERSION matches apps/web/package.json', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'apps/web/package.json'), 'utf8')) as { version: string };
  assert.equal(WEB_APP_VERSION, pkg.version);
});

await t('CSS contracts: dvh via --app-height, safe-area, contain, 44px, focus-visible', () => {
  const css = readFileSync(join(root, 'apps/web/src/app.css'), 'utf8');
  assert.match(css, /--app-height:\s*100dvh/);
  assert.match(css, /\.settings-screen[\s\S]*min-height:\s*var\(--app-height\)/);
  assert.match(css, /\.settings-main[\s\S]*padding:[\s\S]*var\(--safe-bottom\)/);
  assert.match(css, /--safe-bottom:\s*env\(safe-area-inset-bottom/);
  assert.match(css, /\.settings-screen[\s\S]*overscroll-behavior-y:\s*contain/);
  assert.match(css, /\.settings-main[\s\S]*overscroll-behavior-y:\s*contain/);
  assert.match(css, /\.settings-row[\s\S]*min-height:\s*44px/);
  assert.match(css, /\.settings-row:focus-visible/);
});

await t('chat SSE FailSend recovery contract remains intact', async () => {
  const chat = readFileSync(join(root, 'apps/web/src/pages/useChat.ts'), 'utf8');
  const api = readFileSync(join(root, 'apps/web/src/lib/api.ts'), 'utf8');
  assert.match(chat, /runStream\(`\/api\/conversations\/\$\{conversationId\}\/messages`/);
  assert.match(api, /accept: 'text\/event-stream'/);
  assert.match(api, /res\.body\.getReader\(\)/);

  // Execute the actual hook callback with I/O doubles; no React renderer or
  // duplicate recovery implementation. AST extraction ignores layout/arg names.
  const source = ts.createSourceFile('useChat.ts', chat, ts.ScriptTarget.Latest, true);
  const callbacks: ts.ArrowFunction[] = [];
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'runStream') {
      const init = node.initializer;
      assert.ok(init && ts.isCallExpression(init), 'runStream must be a useCallback call');
      const callback = init.arguments[0];
      assert.ok(callback && ts.isArrowFunction(callback), 'runStream callback must exist');
      callbacks.push(callback);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(callbacks.length, 1, 'one runStream callback');
  const compiled = ts.transpileModule(`const runStream = ${callbacks[0].getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;

  type Event = SseEvent;
  async function scenario(events: Event[], error?: Error, abort = false, switchAfterFirst = false) {
    const received: Event[] = [];
    const calls: string[] = [];
    const abortRef: { current: AbortController | null } = { current: null };
    const scope = { conversationId: 'fixture-conversation', revision: 0, reloadSequence: 0 };
    const scopeRef = { current: scope };
    const connections: boolean[] = [];
    const nextController = new AbortController();
    const request = { content: 'fixture send' };
    let visibleError: string | null = null;
    let releaseReload: (() => void) | undefined;
    let notifyReload!: () => void;
    const reloading = new Promise<void>((resolve) => { notifyReload = resolve; });
    const deps = {
      state: { generating: false }, abortRef, genIdRef: { current: null }, scope, scopeRef,
      setStreamConnected: (connected: boolean) => { connections.push(connected); },
      patchState: (patch: { error?: string | null }) => { if (patch.error !== undefined) visibleError = patch.error; }, ApiError, sendOkForComposer, AbortController,
      applyEvent: (e: Event) => { received.push(e); if (e.type === 'error') visibleError = e.message; },
      reload: async () => {
        assert.equal(abortRef.current, null, 'release transport before reload so polling can resume');
        calls.push('reload');
        await new Promise<void>((resolve) => { releaseReload = resolve; notifyReload(); });
        visibleError = null;
      },
      streamPost: async (url: string, body: unknown, onEvent: (e: Event) => void, signal: AbortSignal) => {
        assert.equal(url, '/fixture/messages');
        assert.equal(body, request);
        assert.equal(signal, abortRef.current?.signal);
        for (const [index, e] of events.entries()) {
          onEvent(e);
          if (switchAfterFirst && index === 0) {
            scopeRef.current = { conversationId: 'new-room', revision: 0, reloadSequence: 0 };
            abortRef.current = nextController;
          }
        }
        if (abort) abortRef.current!.abort();
        if (error) throw error;
      },
    };
    const run = new Function(...Object.keys(deps), `${compiled}\nreturn runStream;`)(...Object.values(deps)) as
      (url: string, body: unknown) => Promise<boolean | undefined>;
    let settled = false;
    const result = run('/fixture/messages', request).then((value) => {
      settled = true;
      calls.push('return');
      return value;
    });
    let timeout!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('runStream recovery did not settle')), 1000);
    });
    try {
      await Promise.race([reloading, result, deadline]);
      if (releaseReload) {
        assert.equal(settled, false, 'SSE failure must await reload before restoring composer');
        releaseReload();
      }
      const value = await Promise.race([result, deadline]);
      assert.deepEqual(received, switchAfterFirst ? events.slice(0, 1) : events, 'forward only current-room SSE events to applyEvent');
      assert.equal(abortRef.current, switchAfterFirst ? nextController : null, 'release only the current generation controller');
      assert.deepEqual(connections, switchAfterFirst ? [true] : [true, false], 'old room completion cannot change the new connection state');
      assert.equal(scope.revision, 1, 'invalidate pre-stream reloads before sending');
      return { value, calls, visibleError };
    } finally {
      clearTimeout(timeout);
    }
  }

  const message: Message = {
    id: 'fixture-message', conversation_id: 'fixture-conversation', parent_id: null,
    role: 'assistant', content: 'fixture text', status: 'complete', meta: {},
    bookmarked: false, created_at: '2026-09-22T00:00:00Z',
    eventVersion: 1, events: [{ type: 'narration', id: 'fixture-message:0', text: 'fixture text' }],
    siblings: { index: 0, count: 1, ids: ['fixture-message'] },
  };
  const ordinary: SseEvent[] = [
    { type: 'start', generationId: 'fixture-generation', messageId: message.id, eventVersion: 1 },
    { type: 'token', text: 'fixture ', messageId: message.id, eventVersion: 1, events: [{ type: 'narration', id: 'fixture-message:0', text: 'fixture ' }] },
    { type: 'aux', message: { ...message, id: 'fixture-aux', meta: { block_kind: 'narration' } } },
    { type: 'token', text: 'text', messageId: message.id, eventVersion: 1, events: message.events! },
    { type: 'done', message, usage: null, ttftMs: 1, totalMs: 2 },
  ];
  assert.deepEqual(await scenario(ordinary), { value: true, calls: ['return'], visibleError: null }, 'successful stream');
  assert.deepEqual(await scenario([...ordinary, { type: 'error', message: 'failed' }]),
    { value: false, calls: ['reload', 'return'], visibleError: 'failed' }, 'SSE error remains visible after reload retracts the send and restores composer');
  for (const [error, abort, expected] of [
    [new ApiError(503, 'server failure'), false, false],
    [new TypeError('network disconnected'), false, true],
    [new StreamInterruptedError(), false, true],
    [new ApiError(499, 'explicit stop'), false, true],
    [new Error('aborted'), true, true],
    [new ApiError(503, 'abort overrides HTTP failure'), true, true],
  ] as const) {
    const result = await scenario([], error, abort);
    assert.equal(result.value, expected, `${error.message}: composer recovery`);
    assert.equal(result.calls.filter((call) => call === 'reload').length, 1, `${error.message}: resynchronize`);
    assert.equal(result.visibleError, abort || (error instanceof ApiError && error.status === 499) ? null : error.message,
      `${error.message}: retain failure after resync, keep explicit stop quiet`);
  }
  assert.deepEqual(await scenario(ordinary, new ApiError(503, 'old room failed'), false, true),
    { value: true, calls: ['return'], visibleError: null }, 'old room failure cannot restore composer, resync or alter the new stream');
});

await t('existing swipe sibling selection remains in ChatPage', () => {
  const src = readFileSync(join(root, 'apps/web/src/pages/ChatPage.tsx'), 'utf8');
  assert.match(src, /selectSibling|swipe|touchstart|onTouchStart/);
});

await t('no conversation_settings table; server diff clean', () => {
  const changed = git('diff --name-only HEAD -- apps/server apps/web');
  assert.doesNotMatch(changed, /conversation_settings/);
  // C3 가 합법적으로 play_guide 를 추가함 — /play_guide/ 부재 검사는 제거.
  const serverDiff = git('diff HEAD -- apps/server');
  assert.equal(serverDiff.trim(), '');
});

await t('no new migration files vs HEAD', () => {
  const migDir = join(root, 'apps/server/migrations');
  const listed = readdirSync(migDir).sort();
  const tracked = git('ls-files apps/server/migrations')
    .trim()
    .split('\n')
    .map((p) => p.split('/').pop())
    .sort();
  assert.deepEqual(listed, tracked);
  const untrackedMig = git('ls-files --others --exclude-standard -- apps/server/migrations');
  assert.equal(untrackedMig.trim(), '');
});

console.log(`passed ${passed}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
