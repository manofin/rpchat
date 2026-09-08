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
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
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

t('5 runStream guards with generating OR abortRef.current', () => {
  const hook = src('apps/web/src/pages/useChat.ts');
  assert.match(hook, /if \(state\.generating \|\| abortRef\.current\) return;/);
});

t('6 generating true is set before POST', () => {
  const hook = src('apps/web/src/pages/useChat.ts');
  const run = hook.slice(hook.indexOf('const runStream'));
  const genTrue = run.indexOf('generating: true');
  const post = run.indexOf('streamPost(');
  assert.ok(genTrue >= 0 && post >= 0 && genTrue < post);
  assert.match(hook, /patchState\(\{\s*error:\s*null,\s*generating:\s*true\s*\}\)/);
});

t('7 failure path restores generating false', () => {
  const hook = src('apps/web/src/pages/useChat.ts');
  assert.match(hook, /generating:\s*false/);
  assert.match(hook, /catch \(e\)/);
});

t('8 choices and composer send share the same runStream path', () => {
  const hook = src('apps/web/src/pages/useChat.ts');
  const page = src('apps/web/src/pages/ChatPage.tsx');
  assert.match(hook, /const send = useCallback\(\(content: string\) => runStream\(`\/api\/conversations\/\$\{conversationId\}\/messages`/);
  assert.match(page, /void chat\.send\(text\)/);
  assert.match(page, /await chat\.send\(text\)/);
});

t('9 no server file changes in this slice', () => {
  const changed = execSync('git diff --name-only HEAD -- apps/server', { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(changed, '');
  const untracked = execSync('git ls-files --others --exclude-standard -- apps/server', { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(untracked, '');
});

console.log(`passed ${passed}`);
