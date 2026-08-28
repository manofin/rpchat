/** npx tsx bench/conversationOutputPage.test.ts
 * F7-settings (B) output leaf — conversation profileName select only.
 * No PUT /api/profiles (global max_tokens). No live HTTP.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { resolveSettingsRoute } from '../apps/web/src/lib/conversationSettings.ts';
import type { ModelProfile } from '../apps/web/src/types.ts';

const require2 = createRequire(import.meta.url);
let page: typeof import('../apps/web/src/pages/ConversationOutputPage.tsx');
try {
  page = require2('../apps/web/src/pages/ConversationOutputPage.tsx');
} catch (e) {
  console.error('RED: ConversationOutputPage missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

const { rpOutputProfiles, buildProfileNamePatch, OutputView } = page;

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const ROOT = path.resolve('apps/web/src');
const settingsPage = fs.readFileSync(path.join(ROOT, 'pages/ConversationSettingsPage.tsx'), 'utf8');
const outputSrc = fs.readFileSync(path.join(ROOT, 'pages/ConversationOutputPage.tsx'), 'utf8');
const chat = fs.readFileSync(path.join(ROOT, 'pages/ChatPage.tsx'), 'utf8');

const profiles: ModelProfile[] = [
  { name: 'rp-balanced', model: 'm', temperature: 0.7, top_p: 0.9, max_tokens: 800, stop: [], system_mode: 'system', notes: null },
  { name: 'rp-creative', model: 'm', temperature: 1, top_p: 0.9, max_tokens: 800, stop: [], system_mode: 'system', notes: null },
  { name: 'summary', model: 'm', temperature: 0, top_p: 1, max_tokens: 400, stop: [], system_mode: 'system', notes: null },
];

t('OUT-01 href exists; hub page still does not PATCH profileName', () => {
  const route = resolveSettingsRoute('/chat/c-qa/settings/output');
  assert.deepEqual(route, { kind: 'leaf', conversationId: 'c-qa', leaf: 'output' });
  assert.ok(settingsPage.includes('ConversationOutputPage'));
  assert.ok(settingsPage.includes("route.leaf === 'output'"));
  assert.equal(/\bpatch\(/.test(settingsPage), false);
  assert.equal(settingsPage.includes('profileName'), false);
});

t('OUT-02 only rp- names are selectable; patch body is profileName only', () => {
  assert.deepEqual(rpOutputProfiles(profiles).map((p) => p.name), ['rp-balanced', 'rp-creative']);
  assert.deepEqual(buildProfileNamePatch('rp-creative'), { profileName: 'rp-creative' });
  assert.equal(buildProfileNamePatch('summary'), null);
  assert.equal(buildProfileNamePatch(''), null);
});

t('OUT-03 view lists rp- options; leaf has no PUT /api/profiles', () => {
  const html = renderToStaticMarkup(createElement(OutputView, {
    profileName: 'rp-balanced',
    profiles,
    pending: false,
    onChange: () => undefined,
    onBack: () => undefined,
  }));
  assert.ok(html.includes('rp-balanced'));
  assert.ok(html.includes('rp-creative'));
  assert.equal(html.includes('summary'), false);
  assert.ok(html.includes('<select'));
  assert.equal(outputSrc.includes('put('), false);
  assert.equal(outputSrc.includes('/api/profiles/'), false);
  assert.ok(chat.includes('save({ profileName: e.target.value })'));
});

console.log(`passed ${passed}`);
