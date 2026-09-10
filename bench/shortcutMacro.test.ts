/** npx tsx bench/shortcutMacro.test.ts
 * story-editor-tabs A9 — client slash macros (D3=a). Helper + source inventory.
 * Helper/bench PASS is not a product PASS. No live HTTP / systemd / DB /
 * commit / deploy / restart. apps/server must stay byte-untouched vs HEAD.
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
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
  SHORTCUT_MAX,
  expandLeadingShortcut,
  normalizeShortcutName,
  parseShortcuts,
  persistShortcuts,
  readShortcuts,
  removeShortcut,
  serializeShortcuts,
  shortcutStorageKey,
  upsertShortcut,
} = mod;

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

type Kv = { getItem(k: string): string | null; setItem(k: string, v: string): void };
function memKv(init: Record<string, string> = {}): Kv {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => { m.set(k, v); },
  };
}

const ROOT = path.resolve('apps/web/src');
const helperSrc = fs.readFileSync(path.join(ROOT, 'lib/shortcutMacro.ts'), 'utf8');
const editorSrc = fs.readFileSync(path.join(ROOT, 'components/StoryEditor.tsx'), 'utf8');
const chatSrc = fs.readFileSync(path.join(ROOT, 'pages/ChatPage.tsx'), 'utf8');
const typesSrc = fs.readFileSync(path.join(ROOT, 'types.ts'), 'utf8');

t('SM-01 parse rejects junk; caps at 20; names strip leading slash', () => {
  assert.equal(SHORTCUT_MAX, 20);
  assert.deepEqual(parseShortcuts(null), []);
  assert.deepEqual(parseShortcuts('not-json'), []);
  assert.deepEqual(parseShortcuts('{}'), []);
  assert.deepEqual(parseShortcuts('[{"name":"요약","text":"한줄 정리"}]'), [{ name: '요약', text: '한줄 정리' }]);
  assert.equal(parseShortcuts(JSON.stringify(
    Array.from({ length: 25 }, (_, i) => ({ name: `n${i}`, text: 'x' })),
  )).length, 20);
  assert.equal(normalizeShortcutName('/커뮤'), '커뮤');
  assert.equal(normalizeShortcutName(' 커뮤 '), '커뮤');
  assert.equal(normalizeShortcutName(''), null);
  assert.equal(normalizeShortcutName('/a b'), null);
});

t('SM-02 upsert max 20; replace existing; remove', () => {
  let rows = upsertShortcut([], '요약', '한줄').entries;
  assert.equal(rows.length, 1);
  rows = upsertShortcut(rows, '요약', '다른').entries;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, '다른');
  const filled = Array.from({ length: 20 }, (_, i) => ({ name: `n${i}`, text: 'x' }));
  const extra = upsertShortcut(filled, '넘침', 'no');
  assert.equal(extra.ok, false);
  assert.equal(removeShortcut(filled, 'n0').length, 19);
});

t('SM-03 expand leading /name only; unknown and mid-line stay', () => {
  const entries = [{ name: '요약', text: '한 줄로 정리해.' }, { name: '커뮤', text: '*OOC*' }];
  assert.equal(expandLeadingShortcut('/요약', entries).text, '한 줄로 정리해.');
  assert.equal(expandLeadingShortcut('/요약', entries).matched, '요약');
  assert.equal(expandLeadingShortcut('/요약 더', entries).text, '한 줄로 정리해. 더');
  assert.equal(expandLeadingShortcut('/없는', entries).text, '/없는');
  assert.equal(expandLeadingShortcut('안녕 /요약', entries).text, '안녕 /요약');
  assert.equal(expandLeadingShortcut('/요약본', entries).text, '/요약본');
  assert.equal(expandLeadingShortcut('', entries).text, '');
  assert.equal(expandLeadingShortcut('/요약', entries, { bare: false }).text, '/요약');
  assert.equal(expandLeadingShortcut('/요약 ', entries, { bare: false }).text, '한 줄로 정리해.');
});

t('SM-04 localStorage is per-story; null story is empty; missing kv is safe', () => {
  const kv = memKv();
  persistShortcuts('s1', [{ name: '요약', text: 'A' }], kv);
  persistShortcuts('s2', [{ name: '커뮤', text: 'B' }], kv);
  assert.equal(shortcutStorageKey('s1'), 'rpchat.shortcuts.s1');
  assert.deepEqual(readShortcuts('s1', kv), [{ name: '요약', text: 'A' }]);
  assert.deepEqual(readShortcuts('s2', kv), [{ name: '커뮤', text: 'B' }]);
  assert.deepEqual(readShortcuts(null, kv), []);
  assert.deepEqual(readShortcuts(undefined, kv), []);
  const boom: Kv = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  };
  assert.deepEqual(readShortcuts('s1', boom), []);
  persistShortcuts('s1', [{ name: 'x', text: 'y' }], boom);
  assert.ok(serializeShortcuts([{ name: '요약', text: 'A' }]).includes('요약'));
});

t('SM-05 editor has 단축어 tab; PUT body has no shortcuts; lore tab still there', () => {
  assert.ok(editorSrc.includes("key: 'shortcuts'"));
  assert.ok(editorSrc.includes("label: '단축어'"));
  assert.ok(editorSrc.includes('persistShortcuts'));
  assert.ok(editorSrc.includes('readShortcuts'));
  assert.equal(editorSrc.includes('shortcuts_json'), false);
  assert.equal(/put<Story>\(`\/api\/stories\/\$\{story\.id\}`, body\)/.test(editorSrc)
    || editorSrc.includes('put<Story>(`/api/stories/${story.id}`, body)'), true);
  assert.equal(editorSrc.includes('shortcuts:'), false);
  assert.ok(editorSrc.includes("key: 'lore'"));
});

t('SM-06 ChatPage expands on submit; 1:1 (null story_id) is a no-op path', () => {
  assert.ok(chatSrc.includes('expandLeadingShortcut'));
  assert.ok(chatSrc.includes('readShortcuts'));
  assert.ok(chatSrc.includes('story_id'));
  assert.ok(typesSrc.includes('story_id: string | null'));
  assert.equal(chatSrc.includes('buildPrompt'), false);
  assert.equal(helperSrc.includes('buildPrompt'), false);
});

t('SM-07 A9 does not touch apps/server vs HEAD (D3=a)', () => {
  const changed = execSync('git diff --name-only HEAD -- apps/server', { encoding: 'utf8' }).trim();
  assert.equal(changed, '', `A9 apps/server must stay empty: ${changed}`);
  const frozen = execSync(
    'git diff --name-only HEAD -- apps/server/src/prompt/builder.ts apps/server/src/prompt/templates.ts apps/server/src/prompt/resolveFocus.ts apps/server/src/routes/chat.ts apps/server/src/prompt/composeBeat.ts',
    { encoding: 'utf8' },
  ).trim();
  assert.equal(frozen, '', `A9 must not touch frozen files: ${frozen}`);
});

console.log(`passed ${passed}`);
