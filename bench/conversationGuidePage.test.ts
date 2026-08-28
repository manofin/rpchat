/** npx tsx bench/conversationGuidePage.test.ts
 * F7-settings (A) guide leaf — port ChatPage orphan join, read-only.
 * No live HTTP / play_guide table / prompt re-inject.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { resolveSettingsRoute } from '../apps/web/src/lib/conversationSettings.ts';

const require2 = createRequire(import.meta.url);
let page: typeof import('../apps/web/src/pages/ConversationGuidePage.tsx');
try {
  page = require2('../apps/web/src/pages/ConversationGuidePage.tsx');
} catch (e) {
  console.error('RED: ConversationGuidePage missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

const { joinPlayGuide, GuideView } = page;

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const ROOT = path.resolve('apps/web/src');
const settingsPage = fs.readFileSync(path.join(ROOT, 'pages/ConversationSettingsPage.tsx'), 'utf8');
const guideSrc = fs.readFileSync(path.join(ROOT, 'pages/ConversationGuidePage.tsx'), 'utf8');
const chat = fs.readFileSync(path.join(ROOT, 'pages/ChatPage.tsx'), 'utf8');

t('GUIDE-01 href exists; hub page does not PATCH', () => {
  const route = resolveSettingsRoute('/chat/c-qa/settings/guide');
  assert.deepEqual(route, { kind: 'leaf', conversationId: 'c-qa', leaf: 'guide' });
  assert.ok(settingsPage.includes('ConversationGuidePage'));
  assert.ok(settingsPage.includes("route.leaf === 'guide'"));
  assert.equal(/\bpatch\(/.test(settingsPage), false);
});

t('GUIDE-02 join matches orphan sheet field list — empty fallback', () => {
  assert.equal(joinPlayGuide({ description: '', personality: '', speech_style: '', taboos: '' }), '(작성된 가이드 없음)');
  assert.equal(joinPlayGuide({ description: '  ', personality: null, speech_style: undefined, taboos: '' }), '(작성된 가이드 없음)');
  assert.equal(
    joinPlayGuide({ description: '외형', personality: '성격', speech_style: '말투', taboos: '금기' }),
    '외형\n\n성격\n\n말투\n\n금기',
  );
  assert.equal(joinPlayGuide({ description: '', personality: '만 성격', speech_style: '', taboos: '' }), '만 성격');
  assert.ok(chat.includes('character.description, character.personality, character.speech_style, character.taboos'));
});

t('GUIDE-03 view is read-only; no PATCH / play_guide table', () => {
  const html = renderToStaticMarkup(createElement(GuideView, { text: '외형\n\n성격', onBack: () => undefined }));
  assert.ok(html.includes('플레이 가이드'));
  assert.ok(html.includes('외형'));
  assert.ok(html.includes('성격'));
  assert.equal(/\bpatch\(/.test(guideSrc), false);
  assert.equal(guideSrc.includes('play_guide'), false);
  assert.equal(guideSrc.includes('CREATE TABLE'), false);
});

console.log(`passed ${passed}`);
