/**
 * npx tsx bench/rpMobilePwaR6.test.ts
 * R6 — Mobile PWA polish. Web CSS / PWA shell / Galaxy slots.
 * Isolated: no browser, no DB, no model. Does not claim Galaxy PASS.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderScene } from '../apps/server/src/prompt/templates.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(dir, '..');
const src = (rel: string) => fs.readFileSync(path.join(appRoot, rel), 'utf8');
const css = src('apps/web/src/app.css');
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');

t('chip, pencil, send/stop meet 44px Galaxy tap targets', () => {
  assert.match(cssCode, /\.chip-edit\s*\{[^}]*min-width:\s*44px/);
  assert.match(cssCode, /\.chip-edit\s*\{[^}]*min-height:\s*44px/);
  assert.match(cssCode, /\.chip\s*\{[^}]*min-height:\s*44px/);
  assert.match(cssCode, /\.inputbar \.btn\.icon\s*\{[^}]*min-width:\s*44px/);
  assert.match(cssCode, /\.inputbar \.btn\.icon\s*\{[^}]*min-height:\s*44px/);
});

t('chat column respects safe-area and contains overscroll', () => {
  assert.match(cssCode, /--safe-top:\s*env\(safe-area-inset-top/);
  assert.match(cssCode, /--safe-bottom:\s*env\(safe-area-inset-bottom/);
  assert.match(cssCode, /--safe-left:\s*env\(safe-area-inset-left/);
  assert.match(cssCode, /--safe-right:\s*env\(safe-area-inset-right/);
  assert.match(cssCode, /\.chat-main\s*\{[^}]*padding-left:\s*var\(--safe-left\)/);
  assert.match(cssCode, /\.chat-main\s*\{[^}]*padding-right:\s*var\(--safe-right\)/);
  assert.match(cssCode, /\.chat-main\s*\{[^}]*overscroll-behavior-y:\s*contain/);
  assert.match(cssCode, /\.inputbar\s*\{[^}]*var\(--safe-bottom\)/);
  assert.match(cssCode, /\.topbar\.chat-topbar\s*\{[^}]*var\(--safe-top\)/);
  assert.match(src('apps/web/index.html'), /viewport-fit=cover/);
});

t('PWA caches the app shell only — no API runtime cache', () => {
  const vite = src('apps/web/vite.config.ts');
  assert.match(vite, /navigateFallback:\s*'\/index\.html'/);
  assert.match(vite, /navigateFallbackDenylist:\s*\[\s*\/\^\\\/api\\\//);
  assert.match(vite, /runtimeCaching:\s*\[\s*\]/);
  assert.doesNotMatch(vite, /CacheFirst|NetworkFirst|StaleWhileRevalidate/);
  assert.match(vite, /globPatterns:/);
});

t('Galaxy checklist has R1–R6 evidence slots and forbids agent PASS', () => {
  const list = src('docs/GALAXY-CHECKLIST.md');
  assert.match(list, /Crack-play density \(R1–R6\)/);
  for (const id of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']) {
    assert.match(list, new RegExp(`### ${id} `));
    assert.match(list, new RegExp(`### ${id} [\\s\\S]*?증거 슬롯`));
    assert.match(list, new RegExp(`### ${id} [\\s\\S]*?수동 확인 대기`));
  }
  assert.match(list, /기기 증거 없이 PASS 금지/);
  assert.doesNotMatch(list, /### R1[\s\S]*?- \[x\].*PASS/);
});

t('1:1 prompt and useChat SSE are not this slice', () => {
  const gold = '### 현재 장면 (정본. 없는 항목을 창작하지 말 것)\n장소: 항구\n시간: 밤';
  assert.equal(renderScene({ place: '항구', time: '밤' }), gold);
  assert.doesNotMatch(src('apps/web/src/pages/useChat.ts'), /safe-area|runtimeCaching/);
  assert.doesNotMatch(src('apps/server/src/prompt/builder.ts'), /runtimeCaching|cast-status/);
});

console.log(`\n${passed} passed`);
