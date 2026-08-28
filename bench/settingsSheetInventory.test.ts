/** npx tsx bench/settingsSheetInventory.test.ts
 * Gate 2 follow-up lock: old ConversationSettings sheet entry + write paths.
 * Source inventory only. Does not open a browser or call APIs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const chat = fs.readFileSync(path.resolve('apps/web/src/pages/ChatPage.tsx'), 'utf8');
const settingsPage = fs.readFileSync(path.resolve('apps/web/src/pages/ConversationSettingsPage.tsx'), 'utf8');

t('no remaining setSettings(true) — sheet has no user entry', () => {
  assert.equal((chat.match(/setSettings\(true\)/g) || []).length, 0);
});

t('sheet is still mounted on ChatPage (write path preserved)', () => {
  assert.match(chat, /<ConversationSettings open=\{settings\}/);
});

t('title click goes to settings hub, not the sheet', () => {
  assert.match(chat, /navigate\(`\/chat\/\$\{id\}\/settings`\)/);
});

t('same-persona click is a no-op — cannot reapply via old sheet', () => {
  assert.match(chat, /if \(p\.id === current\) return;/);
});

t('old sheet still PATCHes personaId on a different pick', () => {
  assert.match(chat, /patch\(`\/api\/conversations\/\$\{conversationId\}`, \{ personaId: p\.id \}\)/);
});

t('old sheet still writes profileName', () => {
  assert.match(chat, /save\(\{ profileName: e\.target\.value \}\)/);
});

t('new hub page does not PATCH persona or profile', () => {
  assert.doesNotMatch(settingsPage, /personaId/);
  assert.doesNotMatch(settingsPage, /profileName/);
  assert.doesNotMatch(settingsPage, /\bpatch\(/);
});

console.log(`passed ${passed}`);
