/** npx tsx bench/conversationStylePage.test.ts
 * F7-settings (C) style leaf — two presets, localStorage, no font engine.
 * No live HTTP / E1 toggle / app.css mixed hunks.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { resolveSettingsRoute } from '../apps/web/src/lib/conversationSettings.ts';

const require2 = createRequire(import.meta.url);
let page: typeof import('../apps/web/src/pages/ConversationStylePage.tsx');
try {
  page = require2('../apps/web/src/pages/ConversationStylePage.tsx');
} catch (e) {
  console.error('RED: ConversationStylePage missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

const { parseFontPreset, applyFontPreset, StyleView } = page;

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const ROOT = path.resolve('apps/web/src');
const settingsPage = fs.readFileSync(path.join(ROOT, 'pages/ConversationSettingsPage.tsx'), 'utf8');
const styleSrc = fs.readFileSync(path.join(ROOT, 'pages/ConversationStylePage.tsx'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.tsx'), 'utf8');
const fontCss = fs.readFileSync(path.join(ROOT, 'font.css'), 'utf8');
const appCss = fs.readFileSync(path.join(ROOT, 'app.css'), 'utf8');

t('STYLE-01 href exists; hub page does not PATCH', () => {
  const route = resolveSettingsRoute('/chat/c-qa/settings/style');
  assert.deepEqual(route, { kind: 'leaf', conversationId: 'c-qa', leaf: 'style' });
  assert.ok(settingsPage.includes('ConversationStylePage'));
  assert.ok(settingsPage.includes("route.leaf === 'style'"));
  assert.equal(/\bpatch\(/.test(settingsPage), false);
});

t('STYLE-02 kami default; system is the only extra preset', () => {
  assert.equal(parseFontPreset(null), 'kami');
  assert.equal(parseFontPreset(''), 'kami');
  assert.equal(parseFontPreset('webfont-engine'), 'kami');
  assert.equal(parseFontPreset('system'), 'system');
  const root = { dataset: {} as Record<string, string | undefined> };
  applyFontPreset('system', root);
  assert.equal(root.dataset.rpchatFont, 'system');
  applyFontPreset('kami', root);
  assert.equal(root.dataset.rpchatFont, undefined);
});

t('STYLE-03 view is local select; no conversation PATCH / font engine', () => {
  const html = renderToStaticMarkup(createElement(StyleView, {
    preset: 'kami',
    onChange: () => undefined,
    onBack: () => undefined,
  }));
  assert.ok(html.includes('글꼴'));
  assert.ok(html.includes('kami'));
  assert.ok(html.includes('system'));
  assert.ok(html.includes('<select'));
  assert.equal(/\bpatch\(/.test(styleSrc), false);
  assert.equal(styleSrc.includes('@font-face'), false);
  assert.equal(styleSrc.includes('FontFace'), false);
  assert.equal(styleSrc.includes('webfont'), false);
});

t('STYLE-04 font.css overlay only; app.css not mixed into this leaf', () => {
  assert.ok(mainSrc.includes("./font.css"));
  assert.ok(mainSrc.includes('applyFontPreset'));
  assert.ok(fontCss.includes('html[data-rpchat-font="system"]'));
  assert.ok(fontCss.includes('system-ui'));
  assert.equal(appCss.includes('data-rpchat-font'), false);
});

console.log(`passed ${passed}`);
