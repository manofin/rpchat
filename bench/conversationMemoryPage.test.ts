/** npx tsx bench/conversationMemoryPage.test.ts
 * F7-settings (A) memory leaf — wire existing ChatDrawer MemoryTab/SummaryTab.
 * Source inventory + route. No live HTTP / QA PATCH / generate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveSettingsRoute } from '../apps/web/src/lib/conversationSettings.ts';

const require2 = createRequire(import.meta.url);
try {
  require2('../apps/web/src/pages/ConversationMemoryPage.tsx');
} catch (e) {
  console.error('RED: ConversationMemoryPage missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const ROOT = path.resolve('apps/web/src');
const settingsPage = fs.readFileSync(path.join(ROOT, 'pages/ConversationSettingsPage.tsx'), 'utf8');
const memorySrc = fs.readFileSync(path.join(ROOT, 'pages/ConversationMemoryPage.tsx'), 'utf8');
const drawerSrc = fs.readFileSync(path.join(ROOT, 'pages/ChatDrawer.tsx'), 'utf8');

t('MEM-01 memory href already exists; hub page does not PATCH', () => {
  const route = resolveSettingsRoute('/chat/c-qa/settings/memory');
  assert.deepEqual(route, { kind: 'leaf', conversationId: 'c-qa', leaf: 'memory' });
  assert.ok(settingsPage.includes('ConversationMemoryPage'));
  assert.ok(settingsPage.includes("route.leaf === 'memory'"));
  assert.equal(/\bpatch\(/.test(settingsPage), false);
  assert.equal(settingsPage.includes('personaId'), false);
  assert.equal(settingsPage.includes('profileName'), false);
});

t('MEM-02 leaf reuses ChatDrawer MemoryTab/SummaryTab — no BudgetTab, no new API', () => {
  assert.ok(memorySrc.includes("from './ChatDrawer'"));
  assert.ok(memorySrc.includes('MemoryTab'));
  assert.ok(memorySrc.includes('SummaryTab'));
  assert.equal(memorySrc.includes('BudgetTab'), false);
  assert.equal(memorySrc.includes('BottomSheet'), false);
  assert.equal(memorySrc.includes('/api/play_guide'), false);
  assert.equal(memorySrc.includes('CREATE TABLE'), false);
  assert.equal(memorySrc.includes('prompt-preview'), false);
  assert.ok(drawerSrc.includes('export function MemoryTab'));
  assert.ok(drawerSrc.includes('export function SummaryTab'));
});

t('MEM-03 ChatDrawer keep path — drawer still hosts the same tabs', () => {
  assert.ok(drawerSrc.includes("{tab === 'memory' && <MemoryTab"));
  assert.ok(drawerSrc.includes("{tab === 'summary' && <SummaryTab"));
  assert.ok(drawerSrc.includes('/api/conversations/${conversationId}/memories'));
  assert.ok(drawerSrc.includes('/api/conversations/${conversationId}/summarize'));
});

t('MEM-04 fullscreen tabs are not scoped to .sheet', () => {
  assert.ok(memorySrc.includes('settings-leaf-tabs'));
  assert.equal(memorySrc.includes('className="tabs"'), false);
  const css = fs.readFileSync(path.join(ROOT, 'settings-leaf.css'), 'utf8');
  assert.ok(css.includes('.settings-leaf-tabs {'));
  assert.ok(css.includes('.settings-leaf-tabs button.active'));
  assert.equal(css.includes('.sheet'), false);
  const appCss = fs.readFileSync(path.join(ROOT, 'app.css'), 'utf8');
  assert.equal(appCss.includes('settings-leaf-tabs'), false);
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.tsx'), 'utf8');
  assert.ok(mainSrc.includes("./settings-leaf.css"));
});

console.log(`passed ${passed}`);
