/** npx tsx bench/conversationUserNoteSaveLockLifecycle.test.ts
 * Gate 4 B1 user-note-save-lock-lifecycle — Strict Mode replay must not
 * permanently abort the request lock. No live HTTP.
 * Helper/bench PASS is not a product PASS (helper-vs-live-contract).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

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

const { createUserNoteSaveLock, runUserNoteSave } = page;

let passed = 0;
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

type Lock = ReturnType<typeof createUserNoteSaveLock>;

function simulateStrictReplay(lock: Lock): void {
  const g1 = lock.beginLifecycle();
  lock.endLifecycle(g1);
  lock.beginLifecycle();
}

const ROOT = path.resolve('apps/web/src');
const noteSrc = fs.readFileSync(path.join(ROOT, 'pages/ConversationUserNotePage.tsx'), 'utf8');

async function run() {
await ta('B1-01 Strict replay 이후 저장 가능', async () => {
  const lock = createUserNoteSaveLock();
  simulateStrictReplay(lock);
  const bodies: unknown[] = [];
  const applied: string[] = [];
  const result = await runUserNoteSave({
    lock,
    draft: 'after-strict',
    conversationId: 'c-qa',
    patch: async (_url, body) => {
      bodies.push(body);
    },
    get: async () => ({ conversation: { user_note: 'after-strict' } }),
    onSuccess: (loaded) => {
      applied.push(loaded);
    },
    onFailure: () => {
      throw new Error('must not fail');
    },
  });
  assert.equal(result, 'sent');
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies, [{ userNote: 'after-strict' }]);
  assert.deepEqual(applied, ['after-strict']);
});

await ta('B1-02 중복 클릭 차단 유지', async () => {
  const lock = createUserNoteSaveLock();
  simulateStrictReplay(lock);
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
  assert.equal(bodies.length, 1);
  gate.resolve();
  const results = await Promise.all([p1, p2]);
  assert.deepEqual(results.sort(), ['blocked', 'sent'].sort());
  assert.equal(bodies.length, 1);
});

await ta('B1-03 성공 후 재저장 가능', async () => {
  const lock = createUserNoteSaveLock();
  simulateStrictReplay(lock);
  const bodies: unknown[] = [];
  const patch = async (_url: string, body: { userNote: string }) => {
    bodies.push(body);
  };
  const get = async () => ({ conversation: { user_note: 'x' } });
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

await ta('B1-04 실패 후 재저장 가능', async () => {
  const lock = createUserNoteSaveLock();
  simulateStrictReplay(lock);
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

await ta('B1-05 stale GET 차단', async () => {
  const lock = createUserNoteSaveLock();
  const g1 = lock.beginLifecycle();
  lock.endLifecycle(g1);
  const g2 = lock.beginLifecycle();
  assert.equal(lock.shouldApply(g1), false);
  assert.equal(lock.shouldApply(g2), true);
});

await ta('B1-06 실제 unmount 이후 상태 미반영', async () => {
  const lock = createUserNoteSaveLock();
  lock.beginLifecycle();
  const applied: string[] = [];
  const late = deferred<{ conversation: { user_note: string } }>();
  const first = runUserNoteSave({
    lock,
    draft: 'first',
    conversationId: 'c-qa',
    patch: async () => undefined,
    get: async () => late.promise,
    onSuccess: (loaded) => {
      applied.push(loaded);
    },
    onFailure: () => undefined,
  });
  lock.abort();
  late.resolve({ conversation: { user_note: 'first' } });
  await first;
  assert.deepEqual(applied, []);
});

await ta('B1-07 lock과 lifecycle 독립', async () => {
  const lock = createUserNoteSaveLock();
  const g1 = lock.beginLifecycle();
  const bodies: unknown[] = [];
  const gate = deferred<void>();
  const p1 = runUserNoteSave({
    lock,
    draft: 'inflight',
    conversationId: 'c-qa',
    patch: async (_url, body) => {
      bodies.push(body);
      await gate.promise;
    },
    get: async () => ({ conversation: { user_note: 'inflight' } }),
    onSuccess: () => undefined,
    onFailure: () => undefined,
  });
  lock.endLifecycle(g1);
  lock.beginLifecycle();
  const r2 = await runUserNoteSave({
    lock,
    draft: 'too-soon',
    conversationId: 'c-qa',
    patch: async (_url, body) => {
      bodies.push(body);
    },
    get: async () => ({ conversation: { user_note: 'too-soon' } }),
    onSuccess: () => undefined,
    onFailure: () => undefined,
  });
  assert.equal(r2, 'blocked');
  gate.resolve();
  await p1;
  const r3 = await runUserNoteSave({
    lock,
    draft: 'after',
    conversationId: 'c-qa',
    patch: async (_url, body) => {
      bodies.push(body);
    },
    get: async () => ({ conversation: { user_note: 'after' } }),
    onSuccess: () => undefined,
    onFailure: () => undefined,
  });
  assert.equal(r3, 'sent');
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies, [{ userNote: 'inflight' }, { userNote: 'after' }]);
});

await ta('B1-08 기존 회귀 SL-01..08 UN-01..07 web typecheck', async () => {
  assert.match(noteSrc, /beginLifecycle/);
  assert.match(noteSrc, /endLifecycle/);
  assert.doesNotMatch(noteSrc, /if \(busy \|\| aborted\)/);
  const sl = spawnSync('npx', ['tsx', 'bench/conversationUserNoteSaveLock.test.ts'], {
    encoding: 'utf8',
    cwd: path.resolve('.'),
  });
  assert.equal(sl.status, 0, sl.stderr || sl.stdout);
  assert.match(sl.stdout, /passed 8/);
  const un = spawnSync('npx', ['tsx', 'bench/conversationUserNotePage.test.ts'], {
    encoding: 'utf8',
    cwd: path.resolve('.'),
  });
  assert.equal(un.status, 0, un.stderr || un.stdout);
  assert.match(un.stdout, /passed 7/);
  const tc = spawnSync('npm', ['run', 'typecheck', '--workspace=@rpchat/web'], {
    encoding: 'utf8',
    cwd: path.resolve('.'),
  });
  assert.equal(tc.status, 0, tc.stderr || tc.stdout);
});

console.log(`passed ${passed}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
