/** npx tsx bench/conversationUserNoteSaveLock.test.ts
 * Gate 4 B user-note-save-lock — sync request lock, no live HTTP.
 * Helper/bench PASS is not a product PASS (helper-vs-live-contract).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require2 = createRequire(import.meta.url);
let page: typeof import('../apps/web/src/pages/ConversationUserNotePage.tsx');
try {
  page = require2('../apps/web/src/pages/ConversationUserNotePage.tsx');
} catch (e) {
  console.error('RED: ConversationUserNotePage missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

if (typeof page.createUserNoteSaveLock !== 'function' || typeof page.runUserNoteSave !== 'function') {
  console.error('RED: user-note save lock helper missing');
  process.exit(1);
}

const { createUserNoteSaveLock, runUserNoteSave, UserNoteView } = page;

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

async function ta(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const ROOT = path.resolve('apps/web/src');
const noteSrc = fs.readFileSync(path.join(ROOT, 'pages/ConversationUserNotePage.tsx'), 'utf8');

async function run() {
await ta('SL-01 fast double save sends one PATCH', async () => {
  const lock = createUserNoteSaveLock();
  const bodies: unknown[] = [];
  const gate = deferred<void>();
  const patch = async (_url: string, body: { userNote: string }) => {
    bodies.push(body);
    await gate.promise;
  };
  const get = async () => ({ conversation: { user_note: 'note-a' } });
  const p1 = runUserNoteSave({
    lock,
    draft: 'note-a',
    conversationId: 'c-qa',
    patch,
    get,
    onSuccess: () => undefined,
    onFailure: () => undefined,
  });
  const p2 = runUserNoteSave({
    lock,
    draft: 'note-a',
    conversationId: 'c-qa',
    patch,
    get,
    onSuccess: () => undefined,
    onFailure: () => undefined,
  });
  assert.equal(bodies.length, 1);
  gate.resolve();
  const results = await Promise.all([p1, p2]);
  assert.deepEqual(results.sort(), ['blocked', 'sent'].sort());
  assert.equal(bodies.length, 1);
});

await ta('SL-02 third click while in flight does not send another PATCH', async () => {
  const lock = createUserNoteSaveLock();
  const bodies: unknown[] = [];
  const gate = deferred<void>();
  const patch = async (_url: string, body: { userNote: string }) => {
    bodies.push(body);
    await gate.promise;
  };
  const get = async () => ({ conversation: { user_note: 'note-a' } });
  const args = {
    lock,
    draft: 'note-a',
    conversationId: 'c-qa',
    patch,
    get,
    onSuccess: () => undefined,
    onFailure: () => undefined,
  };
  const p1 = runUserNoteSave(args);
  const p2 = runUserNoteSave(args);
  const p3 = runUserNoteSave(args);
  assert.equal(bodies.length, 1);
  gate.resolve();
  const results = await Promise.all([p1, p2, p3]);
  assert.equal(results.filter((r) => r === 'sent').length, 1);
  assert.equal(results.filter((r) => r === 'blocked').length, 2);
  assert.equal(bodies.length, 1);
});

await ta('SL-03 after success another save can send', async () => {
  const lock = createUserNoteSaveLock();
  const bodies: unknown[] = [];
  const patch = async (_url: string, body: { userNote: string }) => {
    bodies.push(body);
  };
  const get = async () => ({ conversation: { user_note: bodies[bodies.length - 1] as { userNote: string } } });
  const args = {
    lock,
    conversationId: 'c-qa',
    patch,
    get,
    onSuccess: () => undefined,
    onFailure: () => undefined,
  };
  assert.equal(await runUserNoteSave({ ...args, draft: 'one' }), 'sent');
  assert.equal(await runUserNoteSave({ ...args, draft: 'two' }), 'sent');
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies, [{ userNote: 'one' }, { userNote: 'two' }]);
});

await ta('SL-04 after failure another save can send', async () => {
  const lock = createUserNoteSaveLock();
  let failOnce = true;
  const bodies: unknown[] = [];
  const patch = async (_url: string, body: { userNote: string }) => {
    bodies.push(body);
    if (failOnce) {
      failOnce = false;
      throw new Error('network');
    }
  };
  const get = async () => ({ conversation: { user_note: 'ok' } });
  const args = {
    lock,
    draft: 'retry-me',
    conversationId: 'c-qa',
    patch,
    get,
    onSuccess: () => undefined,
    onFailure: () => undefined,
  };
  assert.equal(await runUserNoteSave(args), 'sent');
  assert.equal(await runUserNoteSave(args), 'sent');
  assert.equal(bodies.length, 2);
});

await ta('SL-05 failure keeps the textarea draft', async () => {
  const lock = createUserNoteSaveLock();
  let kept: string | undefined;
  const patch = async () => {
    throw new Error('network');
  };
  const get = async () => ({ conversation: { user_note: 'server' } });
  await runUserNoteSave({
    lock,
    draft: 'user-draft',
    conversationId: 'c-qa',
    patch,
    get,
    onSuccess: () => {
      throw new Error('must not succeed');
    },
    onFailure: (_kind, draftKept) => {
      kept = draftKept;
    },
  });
  assert.equal(kept, 'user-draft');
});

await ta('SL-06 stale response does not overwrite a newer save', async () => {
  const lock = createUserNoteSaveLock();
  const applied: string[] = [];
  const firstGet = deferred<{ conversation: { user_note: string } }>();
  let getCount = 0;
  const patch = async () => undefined;
  const get = async () => {
    getCount += 1;
    if (getCount === 1) return firstGet.promise;
    return { conversation: { user_note: 'newer' } };
  };
  const p1 = runUserNoteSave({
    lock,
    draft: 'older',
    conversationId: 'c-qa',
    patch,
    get,
    onSuccess: (loaded) => {
      applied.push(loaded);
    },
    onFailure: () => undefined,
  });
  // first PATCH is in flight on GET; cannot start second until lock ends.
  // Complete first GET only after a second generation would have started —
  // abort the first ticket by ending via a later begin after first finishes? 
  // Contract: late GET for ticket 1 must not apply after ticket 2 committed.
  firstGet.resolve({ conversation: { user_note: 'older' } });
  await p1;
  assert.deepEqual(applied, ['older']);
  const p2 = runUserNoteSave({
    lock,
    draft: 'newer',
    conversationId: 'c-qa',
    patch,
    get,
    onSuccess: (loaded) => {
      applied.push(loaded);
    },
    onFailure: () => undefined,
  });
  await p2;
  assert.deepEqual(applied, ['older', 'newer']);

  const lock2 = createUserNoteSaveLock();
  const applied2: string[] = [];
  const late = deferred<{ conversation: { user_note: string } }>();
  let n = 0;
  const get2 = async () => {
    n += 1;
    if (n === 1) return late.promise;
    return { conversation: { user_note: 'second' } };
  };
  const first = runUserNoteSave({
    lock: lock2,
    draft: 'first',
    conversationId: 'c-qa',
    patch,
    get: get2,
    onSuccess: (loaded) => {
      applied2.push(loaded);
    },
    onFailure: () => undefined,
  });
  lock2.abort();
  late.resolve({ conversation: { user_note: 'first' } });
  await first;
  assert.deepEqual(applied2, []);
});

t('SL-07 saving disables the button (disabled or aria-disabled)', () => {
  const html = renderToStaticMarkup(
    createElement(UserNoteView, {
      conversationId: 'c-qa',
      draft: 'note',
      pending: true,
      conversationError: false,
      statusMessage: null,
      onBack: () => undefined,
      onDraftChange: () => undefined,
      onSave: () => undefined,
      onRetry: () => undefined,
    }),
  );
  assert.match(html, /<button type="button" class="btn" disabled="" aria-busy="true">저장<\/button>/);
  assert.match(html, /disabled/);
  assert.match(noteSrc, /createUserNoteSaveLock/);
  assert.match(noteSrc, /tryBegin/);
  assert.doesNotMatch(noteSrc, /if \(!body \|\| pending/);
});

t('SL-08 UN-01..07 regression still passes', () => {
  const r = spawnSync('npx', ['tsx', 'bench/conversationUserNotePage.test.ts'], {
    encoding: 'utf8',
    cwd: path.resolve('.'),
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /passed 7/);
});

console.log(`passed ${passed}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
