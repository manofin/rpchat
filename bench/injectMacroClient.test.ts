/** npx tsx bench/injectMacroClient.test.ts
 * inject-macro-client — A9 mode insert|inject + resolveShortcutSubmit parse lock (ADR §6.4).
 * LIVE_NO_TOUCH. No live HTTP / systemd / DB / deploy.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require2 = createRequire(import.meta.url);
let mod: typeof import('../apps/web/src/lib/shortcutMacro.ts');
try {
  mod = require2('../apps/web/src/lib/shortcutMacro.ts');
} catch (e) {
  console.error('RED: shortcutMacro missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

const {
  INJECT_INSTRUCTION_MAX,
  expandLeadingShortcut,
  parseShortcuts,
  resolveShortcutSubmit,
  serializeShortcuts,
  upsertShortcut,
} = mod;

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const ROOT = path.resolve('apps/web/src');
const helperSrc = fs.readFileSync(path.join(ROOT, 'lib/shortcutMacro.ts'), 'utf8');
const editorSrc = fs.readFileSync(path.join(ROOT, 'components/StoryEditor.tsx'), 'utf8');
const chatSrc = fs.readFileSync(path.join(ROOT, 'pages/ChatPage.tsx'), 'utf8');
const useChatSrc = fs.readFileSync(path.join(ROOT, 'pages/useChat.ts'), 'utf8');
const serverChatSrc = fs.readFileSync(path.resolve('apps/server/src/routes/chat.ts'), 'utf8');

t('IMC-01 INJECT_INSTRUCTION_MAX is 800 (client mirror)', () => {
  assert.equal(INJECT_INSTRUCTION_MAX, 800);
  assert.ok(helperSrc.includes('Client mirror of apps/server/src/prompt/injectContext.ts'));
});

t('IMC-02 insert regression: expandLeadingShortcut still expands insert entries', () => {
  const entries = [{ name: '요약', text: '한 줄로 정리해.' }, { name: '커뮤', text: '*OOC*' }];
  assert.equal(expandLeadingShortcut('/요약', entries).text, '한 줄로 정리해.');
  assert.equal(expandLeadingShortcut('/요약 더', entries).text, '한 줄로 정리해. 더');
  assert.equal(expandLeadingShortcut('/없는', entries).text, '/없는');
});

t('IMC-03 default mode insert for legacy entries (missing mode)', () => {
  const parsed = parseShortcuts(JSON.stringify([{ name: '옛것', text: '본문' }]));
  assert.deepEqual(parsed, [{ name: '옛것', text: '본문' }]);
  assert.equal(parsed[0].mode, undefined);
  const r = resolveShortcutSubmit('/옛것', parsed);
  assert.equal(r.mode, 'insert');
  assert.equal(r.content, '본문');
  assert.equal(r.inject_instruction, undefined);
});

t('IMC-04 expandLeadingShortcut does not expand inject mode into draft', () => {
  const entries = [{ name: '지침', text: '절대 유저 대행 금지', mode: 'inject' as const }];
  assert.equal(expandLeadingShortcut('/지침', entries).text, '/지침');
  assert.equal(expandLeadingShortcut('/지침', entries).matched, null);
  assert.equal(expandLeadingShortcut('/지침 말해', entries, { bare: false }).text, '/지침 말해');
  assert.equal(expandLeadingShortcut('/지침 ', entries, { bare: false }).text, '/지침 ');
});

t('IMC-05 inject alone: content ≠ text; inject_instruction = text', () => {
  const body = '이번 턴만 짧게. 유저 대행 금지.';
  const entries = [{ name: '짧게', text: body, mode: 'inject' as const }];
  const r = resolveShortcutSubmit('/짧게', entries);
  assert.equal(r.matched, '짧게');
  assert.equal(r.mode, 'inject');
  assert.equal(r.inject_instruction, body);
  assert.equal(r.content, '');
  assert.notEqual(r.content, body);
});

t('IMC-06 inject + speech: content = speech only; field = text', () => {
  const body = '지침 본문 XYZ';
  const entries = [{ name: '지침', text: body, mode: 'inject' as const }];
  const r = resolveShortcutSubmit('/지침  창가에 앉아.  ', entries);
  assert.equal(r.inject_instruction, body);
  assert.equal(r.content, '창가에 앉아.');
  assert.ok(!r.content.includes('XYZ'));
  assert.notEqual(r.content, body);
});

t('IMC-07 upsert blocks inject text >800', () => {
  const over = 'x'.repeat(INJECT_INSTRUCTION_MAX + 1);
  const bad = upsertShortcut([], '긴것', over, 'inject');
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.reason, 'inject_too_long');
  const okInsert = upsertShortcut([], '긴것', over, 'insert');
  assert.equal(okInsert.ok, true);
  const okExact = upsertShortcut([], '딱800', 'y'.repeat(INJECT_INSTRUCTION_MAX), 'inject');
  assert.equal(okExact.ok, true);
});

t('IMC-08 parse/serialize preserve inject mode', () => {
  const rows = upsertShortcut([], '주입', 'do not speak for user', 'inject');
  assert.equal(rows.ok, true);
  const raw = serializeShortcuts(rows.entries);
  const again = parseShortcuts(raw);
  assert.equal(again[0].mode, 'inject');
  assert.equal(again[0].text, 'do not speak for user');
});

t('IMC-09 insert resolve still expands; no inject field', () => {
  const entries = [{ name: '요약', text: '한줄 정리' }];
  const r = resolveShortcutSubmit('/요약 추가', entries);
  assert.equal(r.mode, 'insert');
  assert.equal(r.content, '한줄 정리 추가');
  assert.equal(r.inject_instruction, undefined);
});

t('IMC-10 StoryEditor has mode labels; ChatPage uses resolve; useChat posts inject_instruction', () => {
  assert.ok(editorSrc.includes('입력창에 넣기'));
  assert.ok(editorSrc.includes('지침으로 주입'));
  assert.ok(editorSrc.includes('INJECT_INSTRUCTION_MAX'));
  assert.ok(editorSrc.includes('inject_too_long'));
  assert.ok(chatSrc.includes('resolveShortcutSubmit'));
  assert.ok(chatSrc.includes('inject_instruction'));
  assert.ok(useChatSrc.includes('inject_instruction'));
  assert.ok(useChatSrc.includes('opts?: { inject_instruction?: string }'));
});

t('IMC-11 server sendSchema allows empty content when inject present (companion refine)', () => {
  assert.ok(serverChatSrc.includes("content: z.string().max(8000)"));
  assert.ok(serverChatSrc.includes('content required when inject_instruction is absent'));
  assert.ok(serverChatSrc.includes('inject-macro-client'));
  // must not reintroduce min(1) on send/branch content
  assert.equal(/content: z\.string\(\)\.min\(1\)\.max\(8000\)/.test(serverChatSrc), false);
});

console.log(`passed ${passed}`);
