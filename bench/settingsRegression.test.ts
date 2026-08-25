/** npx tsx bench/settingsRegression.test.ts
 * Gate 2 — no server/builder/memory/SSE/swipe change; no new migration.
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WEB_APP_VERSION } from '../apps/web/src/lib/conversationSettings.ts';

const root = join(import.meta.dirname, '..');
let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

function git(args: string): string {
  return execSync(`git ${args}`, { cwd: root, encoding: 'utf8' });
}

t('WEB_APP_VERSION matches apps/web/package.json', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'apps/web/package.json'), 'utf8')) as { version: string };
  assert.equal(WEB_APP_VERSION, pkg.version);
});

t('CSS contracts: dvh via --app-height, safe-area, contain, 44px, focus-visible', () => {
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

t('existing chat SSE generate path is unchanged', () => {
  const chat = readFileSync(join(root, 'apps/web/src/pages/useChat.ts'), 'utf8');
  const api = readFileSync(join(root, 'apps/web/src/lib/api.ts'), 'utf8');
  assert.match(chat, /runStream\(`\/api\/conversations\/\$\{conversationId\}\/messages`/);
  assert.match(chat, /streamPost\(path, body, applyEvent/);
  assert.match(api, /accept: 'text\/event-stream'/);
  assert.match(api, /res\.body\.getReader\(\)/);
});

t('existing swipe sibling selection remains in ChatPage', () => {
  const src = readFileSync(join(root, 'apps/web/src/pages/ChatPage.tsx'), 'utf8');
  assert.match(src, /selectSibling|swipe|touchstart|onTouchStart/);
});

t('no conversation_settings table or play_guide model added', () => {
  const changed = git('diff --name-only HEAD -- apps/server apps/web');
  assert.doesNotMatch(changed, /conversation_settings/);
  assert.doesNotMatch(changed, /play_guide/);
  const serverDiff = git('diff HEAD -- apps/server');
  assert.equal(serverDiff.trim(), '');
});

t('no new migration files vs HEAD', () => {
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
