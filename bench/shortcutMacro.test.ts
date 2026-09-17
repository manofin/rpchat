/** npx tsx bench/shortcutMacro.test.ts
 * story-editor-tabs A9 — client slash macros (D3=a) + shortcut-global.
 * Helper/bench PASS is not a product PASS. No live HTTP / systemd / DB /
 * commit / deploy / restart. LIVE_NO_TOUCH.
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
  SHORTCUT_STORAGE_KEY,
  SHORTCUT_STORAGE_PREFIX,
  INJECT_INSTRUCTION_MAX,
  expandLeadingShortcut,
  normalizeShortcutName,
  parseShortcuts,
  persistShortcuts,
  readShortcuts,
  removeShortcut,
  resolveShortcutSubmit,
  serializeShortcuts,
  shortcutStorageKey,
  upsertShortcut,
  migrateShortcutsIfNeeded,
  listShortcutKvKeys,
} = mod;

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

type Kv = {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  readonly length: number;
  key(i: number): string | null;
  _dump(): Record<string, string>;
};
function memKv(init: Record<string, string> = {}): Kv {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
    get length() { return m.size; },
    key(i) { return [...m.keys()][i] ?? null; },
    _dump: () => Object.fromEntries(m),
  };
}

const ROOT = path.resolve('apps/web/src');
const helperSrc = fs.readFileSync(path.join(ROOT, 'lib/shortcutMacro.ts'), 'utf8');
const editorSrc = fs.readFileSync(path.join(ROOT, 'components/StoryEditor.tsx'), 'utf8');
const chatSrc = fs.readFileSync(path.join(ROOT, 'pages/ChatPage.tsx'), 'utf8');
const typesSrc = fs.readFileSync(path.join(ROOT, 'types.ts'), 'utf8');

t('SM-01 parse rejects junk; NO max truncate; names strip leading slash', () => {
  assert.equal(SHORTCUT_MAX, 20);
  assert.equal(SHORTCUT_STORAGE_KEY, 'rpchat.shortcuts');
  assert.equal(SHORTCUT_STORAGE_PREFIX, 'rpchat.shortcuts.');
  assert.deepEqual(parseShortcuts(null), []);
  assert.deepEqual(parseShortcuts('not-json'), []);
  assert.deepEqual(parseShortcuts('{}'), []);
  assert.deepEqual(parseShortcuts('[{"name":"요약","text":"한줄 정리"}]'), [{ name: '요약', text: '한줄 정리' }]);
  // Critical: parse must NOT truncate at SHORTCUT_MAX (migration oversize round-trip)
  assert.equal(parseShortcuts(JSON.stringify(
    Array.from({ length: 25 }, (_, i) => ({ name: `n${i}`, text: 'x' })),
  )).length, 25);
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

t('SM-04 global save/load/upsert/remove; missing kv is safe', () => {
  const kv = memKv();
  persistShortcuts([{ name: '요약', text: 'A' }], kv);
  assert.equal(kv.getItem(SHORTCUT_STORAGE_KEY) !== null, true);
  assert.deepEqual(readShortcuts(kv), [{ name: '요약', text: 'A' }]);
  const next = upsertShortcut(readShortcuts(kv), '커뮤', 'B');
  assert.equal(next.ok, true);
  persistShortcuts(next.entries, kv);
  assert.deepEqual(readShortcuts(kv), [
    { name: '요약', text: 'A' },
    { name: '커뮤', text: 'B' },
  ]);
  persistShortcuts(removeShortcut(readShortcuts(kv), '요약'), kv);
  assert.deepEqual(readShortcuts(kv), [{ name: '커뮤', text: 'B' }]);
  assert.equal(shortcutStorageKey('s1'), 'rpchat.shortcuts.s1');
  const boom: Kv = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
    get length() { return 0; },
    key() { return null; },
    _dump: () => ({}),
  };
  assert.deepEqual(readShortcuts(boom), []);
  persistShortcuts([{ name: 'x', text: 'y' }], boom);
  assert.ok(serializeShortcuts([{ name: '요약', text: 'A' }]).includes('요약'));
});

t('SM-05 editor has no 단축어 tab; PUT body has no shortcuts; lore tab still there; hub owns CRUD', () => {
  assert.equal(editorSrc.includes("key: 'shortcuts'"), false);
  assert.equal(editorSrc.includes("label: '단축어'"), false);
  assert.equal(editorSrc.includes('persistShortcuts'), false);
  assert.equal(editorSrc.includes('readShortcuts'), false);
  assert.equal(editorSrc.includes('shortcuts_json'), false);
  assert.equal(/put<Story>\(`\/api\/stories\/\$\{story\.id\}`, body\)/.test(editorSrc)
    || editorSrc.includes('put<Story>(`/api/stories/${story.id}`, body)'), true);
  assert.equal(editorSrc.includes('shortcuts:'), false);
  assert.ok(editorSrc.includes("key: 'lore'"));
});

t('SM-06 ChatPage expands on submit; 1:1 (null story_id) uses global readShortcuts()', () => {
  assert.ok(chatSrc.includes('expandLeadingShortcut'));
  assert.ok(chatSrc.includes('resolveShortcutSubmit'));
  assert.ok(chatSrc.includes('readShortcuts'));
  assert.ok(chatSrc.includes('readShortcuts()'));
  assert.equal(chatSrc.includes('readShortcuts(storyId)'), false);
  assert.equal(chatSrc.includes('readShortcuts(conv.story_id)'), false);
  assert.ok(chatSrc.includes('story_id'));
  assert.ok(typesSrc.includes('story_id: string | null'));
  assert.equal(chatSrc.includes('buildPrompt'), false);
  assert.equal(helperSrc.includes('buildPrompt'), false);
});

t('SM-07 inject-macro-client: no hermes; attach/budget prompt files frozen vs HEAD', () => {
  const frozen = execSync(
    'git diff --name-only HEAD -- apps/server/src/prompt/builder.ts apps/server/src/prompt/templates.ts apps/server/src/prompt/resolveFocus.ts apps/server/src/prompt/composeBeat.ts apps/server/src/prompt/injectContext.ts',
    { encoding: 'utf8' },
  ).trim();
  assert.equal(frozen, '', `must not touch frozen prompt/attach files: ${frozen}`);
  assert.equal(helperSrc.includes('hermes'), false);
  assert.ok(typeof resolveShortcutSubmit === 'function');
  assert.equal(INJECT_INSTRUCTION_MAX, 800);
});

t('SM-08 1:1 fire: insert + inject with global list (no storyId)', () => {
  const kv = memKv();
  persistShortcuts([
    { name: '요약', text: '한줄 정리' },
    { name: '지침', text: '절대 유저 대행 금지', mode: 'inject' },
  ], kv);
  const entries = readShortcuts(kv);
  const ins = resolveShortcutSubmit('/요약 더', entries);
  assert.equal(ins.mode, 'insert');
  assert.equal(ins.content, '한줄 정리 더');
  assert.equal(ins.inject_instruction, undefined);
  const inj = resolveShortcutSubmit('/지침', entries);
  assert.equal(inj.mode, 'inject');
  assert.equal(inj.inject_instruction, '절대 유저 대행 금지');
  assert.equal(inj.content, '');
  assert.notEqual(inj.content, inj.inject_instruction);
  const injSpeech = resolveShortcutSubmit('/지침 말해봐', entries);
  assert.equal(injSpeech.content, '말해봐');
  assert.notEqual(injSpeech.content, injSpeech.inject_instruction);
});

t('SM-09 migration: multi legacy → one; collision sorted last wins; over MAX preserved; idempotent', () => {
  // Keys sort: a before b before z (localeCompare)
  const kv = memKv({
    [shortcutStorageKey('z-late')]: JSON.stringify([
      { name: '공유', text: 'from-z' },
      { name: '오직Z', text: 'z-only' },
    ]),
    [shortcutStorageKey('a-early')]: JSON.stringify([
      { name: '공유', text: 'from-a' },
      { name: '오직A', text: 'a-only' },
    ]),
    [shortcutStorageKey('b-mid')]: JSON.stringify(
      Array.from({ length: 18 }, (_, i) => ({ name: `extra${i}`, text: `t${i}` })),
    ),
  });
  // First read migrates
  const merged = readShortcuts(kv);
  assert.equal(kv.getItem(SHORTCUT_STORAGE_KEY) !== null, true);
  // legacy gone
  assert.equal(kv.getItem(shortcutStorageKey('a-early')), null);
  assert.equal(kv.getItem(shortcutStorageKey('b-mid')), null);
  assert.equal(kv.getItem(shortcutStorageKey('z-late')), null);
  // collision: a < b < z → z wins for 공유
  const shared = merged.find((e) => e.name === '공유');
  assert.ok(shared);
  assert.equal(shared!.text, 'from-z');
  assert.ok(merged.find((e) => e.name === '오직A'));
  assert.ok(merged.find((e) => e.name === '오직Z'));
  // over MAX: 2 + 18 + 1 unique from z's 공유 overwrite = 2 unique from a (공유,오직A) + 18 from b + 1 from z (오직Z) with 공유 replaced
  // a: 공유, 오직A; b: extra0..17; z: 공유(overwrite), 오직Z → total 1+1+18+1 = 21
  assert.equal(merged.length, 21);
  assert.ok(merged.length > SHORTCUT_MAX);
  const snapshot = kv.getItem(SHORTCUT_STORAGE_KEY);
  // second read idempotent
  const again = readShortcuts(kv);
  assert.deepEqual(again, merged);
  assert.equal(kv.getItem(SHORTCUT_STORAGE_KEY), snapshot);
  // no legacy keys left
  const leftover = listShortcutKvKeys(kv).filter((k) => k.startsWith(SHORTCUT_STORAGE_PREFIX));
  assert.deepEqual(leftover, []);
});

t('SM-10 migration skip when global already set; migrateShortcutsIfNeeded direct', () => {
  const kv = memKv({
    [SHORTCUT_STORAGE_KEY]: JSON.stringify([{ name: '이미', text: 'global' }]),
    [shortcutStorageKey('old')]: JSON.stringify([{ name: '레거시', text: 'should-stay-orphan-until-manual' }]),
  });
  migrateShortcutsIfNeeded(kv);
  assert.deepEqual(readShortcuts(kv), [{ name: '이미', text: 'global' }]);
  // legacy not touched because global was already set
  assert.equal(kv.getItem(shortcutStorageKey('old')) !== null, true);
});

t('SM-11 conversation with story_id still uses global list (source + helper)', () => {
  const kv = memKv();
  persistShortcuts([{ name: '파티', text: '파티용' }], kv);
  // helper ignores story — same list
  assert.deepEqual(readShortcuts(kv), [{ name: '파티', text: '파티용' }]);
  assert.ok(chatSrc.includes('readShortcuts()'));
  assert.equal(/readShortcuts\(\s*conv\.story_id\s*\)/.test(chatSrc), false);
});

t('SM-12 serialize round-trips oversize lists; upsert still caps new names', () => {
  const over = Array.from({ length: 25 }, (_, i) => ({ name: `n${i}`, text: 'x' }));
  const raw = serializeShortcuts(over);
  assert.equal(parseShortcuts(raw).length, 25);
  const kv = memKv();
  persistShortcuts(over, kv);
  assert.equal(readShortcuts(kv).length, 25);
  const blocked = upsertShortcut(over, 'newone', 'y');
  assert.equal(blocked.ok, false);
  // replace existing still ok when over MAX
  const replaced = upsertShortcut(over, 'n0', 'zz');
  assert.equal(replaced.ok, true);
  assert.equal(replaced.entries[0].text, 'zz');
});

t('SM-13 server/prompt untouched (this PR does not change apps/server)', () => {
  const serverDiff = execSync('git diff --name-only HEAD -- apps/server', { encoding: 'utf8' }).trim();
  assert.equal(serverDiff, '', `apps/server must stay untouched: ${serverDiff}`);
  const staged = execSync('git diff --cached --name-only -- apps/server', { encoding: 'utf8' }).trim();
  assert.equal(staged, '', `apps/server must not be staged: ${staged}`);
});

console.log(`passed ${passed}`);
