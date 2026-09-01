/** npx tsx bench/contextInspectorEntry.test.ts
 * P5-R1 minimal — labeled, stable Context Inspector entry in the chat header.
 * Source inventory only. Helper/bench PASS is not a product PASS.
 * No live HTTP / systemd / DB / commit / deploy / restart.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require2 = createRequire(import.meta.url);
try {
  require2('../apps/web/src/pages/ChatPage.tsx');
} catch (e) {
  console.error('RED: ChatPage missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const ROOT = path.resolve('apps/web/src');
const chatSrc = fs.readFileSync(path.join(ROOT, 'pages/ChatPage.tsx'), 'utf8');
const drawerSrc = fs.readFileSync(path.join(ROOT, 'pages/ChatDrawer.tsx'), 'utf8');

t('CI-01 header entry is labeled and test-addressable, not a bare glyph', () => {
  assert.ok(chatSrc.includes('data-test="context-inspector"'), 'stable hook missing');
  assert.match(chatSrc, /data-test="context-inspector"[\s\S]{0,400}컨텍스트/, 'visible 컨텍스트 label missing on the entry');
  assert.ok(chatSrc.includes('aria-label="컨텍스트 인스펙터 열기"'), 'screen-reader label missing');
  assert.equal(chatSrc.includes('aria-label="컨텍스트/기억"'), false, 'old unlabeled glyph entry must be replaced, not duplicated');
});

t('CI-02 it opens the existing drawer on the budget tab', () => {
  assert.ok(chatSrc.includes("setDrawerTab('budget')"), 'must target the budget tab explicitly');
  assert.match(
    chatSrc,
    /data-test="context-inspector"[\s\S]{0,400}setDrawerTab\('budget'\)[\s\S]{0,80}setDrawer\(true\)/,
    'the entry itself must set the tab then open',
  );
  assert.ok(chatSrc.includes('initialTab={drawerTab}'), 'tab still travels through the existing prop');
});

t('CI-03 no second inspector surface was added', () => {
  assert.equal((chatSrc.match(/<ChatDrawer/g) ?? []).length, 1, 'exactly one drawer');
  assert.equal((chatSrc.match(/BottomSheet/g) ?? []).length, 9, 'no new BottomSheet in ChatPage');
  assert.equal((chatSrc.match(/setDrawer\(true\)/g) ?? []).length, 3, 'header + 요약하기 + 설정→기억, no more');
  assert.equal((chatSrc.match(/prompt-preview/g) ?? []).length, 1, 'no new preview fetch for the entry');
  assert.equal(chatSrc.includes('inject-preview'), false, 'story pre-start preview is a different surface');
});

t('CI-04 the drawer budget tab remains the inspector, untouched', () => {
  assert.ok(drawerSrc.includes("initialTab ?? 'budget'"), 'budget is still the default tab');
  assert.ok(drawerSrc.includes('>컨텍스트</button>'), 'drawer tab label unchanged');
  assert.ok(drawerSrc.includes('prompt-preview'), 'BudgetTab still reads the existing route');
  assert.ok(drawerSrc.includes('조립된 프롬프트 보기'), 'raw prompt view unchanged');
});

console.log(`passed ${passed}`);
