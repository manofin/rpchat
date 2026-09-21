/**
 * npx tsx bench/conversationTitleLabel.test.ts
 * EmptyTitleLabel — display-only conversation title fallback.
 * Isolated: no systemd, no live DB, no model, no generate, no server import.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const require2 = createRequire(import.meta.url);
let helper: typeof import('../apps/web/src/lib/conversationTitleLabel.ts');
try {
  helper = require2('../apps/web/src/lib/conversationTitleLabel.ts');
} catch (e) {
  console.error('RED: helper module missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

const { conversationTitleLabel, conversationMetaLabel, conversationTitleMatchesMeta } = helper;

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, '..');
const src = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

const FIXTURES: Array<{
  name: string;
  input: {
    title?: string | null;
    character_name?: string | null;
    story_name_snapshot?: string | null;
  };
  expected: string;
}> = [
  { name: 'explicit title kept', input: { title: '명시제목', character_name: '캐릭터', story_name_snapshot: '스토리' }, expected: '명시제목' },
  { name: 'explicit title whitespace preserved', input: { title: '  공백보존  ', character_name: '캐릭터', story_name_snapshot: '스토리' }, expected: '  공백보존  ' },
  { name: 'whitespace-only title treated empty → character · story', input: { title: '   ', character_name: '캐릭터', story_name_snapshot: '스토리' }, expected: '캐릭터 · 스토리' },
  { name: 'empty string title → character · story', input: { title: '', character_name: '캐릭터', story_name_snapshot: '스토리' }, expected: '캐릭터 · 스토리' },
  { name: 'null title → character · story', input: { title: null, character_name: '캐릭터', story_name_snapshot: '스토리' }, expected: '캐릭터 · 스토리' },
  { name: 'undefined title → character · story', input: { character_name: '캐릭터', story_name_snapshot: '스토리' }, expected: '캐릭터 · 스토리' },
  { name: 'character only', input: { title: '', character_name: '캐릭터', story_name_snapshot: null }, expected: '캐릭터' },
  { name: 'story only', input: { title: '', character_name: null, story_name_snapshot: '스토리' }, expected: '스토리' },
  { name: 'character undefined, story present', input: { title: '', story_name_snapshot: '스토리' }, expected: '스토리' },
  { name: 'story undefined, character present', input: { title: '', character_name: '캐릭터' }, expected: '캐릭터' },
  { name: 'empty character string ignored', input: { title: '', character_name: '', story_name_snapshot: '스토리' }, expected: '스토리' },
  { name: 'empty story string ignored', input: { title: '', character_name: '캐릭터', story_name_snapshot: '' }, expected: '캐릭터' },
  { name: 'whitespace character ignored', input: { title: '', character_name: '  ', story_name_snapshot: '스토리' }, expected: '스토리' },
  { name: 'whitespace story ignored', input: { title: '', character_name: '캐릭터', story_name_snapshot: '  ' }, expected: '캐릭터' },
  { name: 'both missing → 대화', input: { title: '', character_name: null, story_name_snapshot: null }, expected: '대화' },
  { name: 'both undefined → 대화', input: { title: '' }, expected: '대화' },
  { name: 'both empty strings → 대화', input: { title: '', character_name: '', story_name_snapshot: '' }, expected: '대화' },
  { name: 'both whitespace → 대화', input: { title: ' \t ', character_name: '  ', story_name_snapshot: '  ' }, expected: '대화' },
  { name: 'identical character+story shown once', input: { title: '', character_name: '같은이름', story_name_snapshot: '같은이름' }, expected: '같은이름' },
  { name: 'identical after trim shown once', input: { title: '', character_name: ' 같은이름 ', story_name_snapshot: '같은이름' }, expected: '같은이름' },
];

t('fixture matrix', () => {
  for (const row of FIXTURES) {
    const got = conversationTitleLabel(row.input);
    assert.equal(got, row.expected, row.name);
    console.log(`FIXTURE ${JSON.stringify(row.input)} => ${JSON.stringify(got)}`);
  }
});

t('does not mutate input object', () => {
  const input = { title: '   ', character_name: ' 캐릭터 ', story_name_snapshot: ' 스토리 ' };
  const snapshot = { ...input };
  conversationTitleLabel(input);
  conversationMetaLabel(input);
  conversationTitleMatchesMeta(input);
  assert.deepEqual(input, snapshot);
});

const META_FIXTURES: Array<{
  name: string;
  input: { character_name?: string | null; story_name_snapshot?: string | null };
  expected: string;
}> = [
  { name: 'char · story', input: { character_name: '캐릭터', story_name_snapshot: '스토리' }, expected: '캐릭터 · 스토리' },
  { name: 'identical shown once', input: { character_name: '같은이름', story_name_snapshot: '같은이름' }, expected: '같은이름' },
  { name: 'identical after trim shown once', input: { character_name: ' 같은이름 ', story_name_snapshot: '같은이름' }, expected: '같은이름' },
  { name: 'trim both sides', input: { character_name: ' 캐릭터 ', story_name_snapshot: ' 스토리 ' }, expected: '캐릭터 · 스토리' },
  { name: 'character only', input: { character_name: '캐릭터', story_name_snapshot: null }, expected: '캐릭터' },
  { name: 'story only', input: { character_name: null, story_name_snapshot: '스토리' }, expected: '스토리' },
  { name: 'whitespace character ignored', input: { character_name: '  ', story_name_snapshot: '스토리' }, expected: '스토리' },
  { name: 'whitespace story ignored', input: { character_name: '캐릭터', story_name_snapshot: '  ' }, expected: '캐릭터' },
  { name: 'both missing → empty', input: { character_name: null, story_name_snapshot: null }, expected: '' },
  { name: 'both undefined → empty', input: {}, expected: '' },
  { name: 'both empty strings → empty', input: { character_name: '', story_name_snapshot: '' }, expected: '' },
];

t('meta helper matrix', () => {
  assert.equal(typeof conversationMetaLabel, 'function', 'conversationMetaLabel export');
  for (const row of META_FIXTURES) {
    const got = conversationMetaLabel(row.input);
    assert.equal(got, row.expected, row.name);
    console.log(`META_FIXTURE ${JSON.stringify(row.input)} => ${JSON.stringify(got)}`);
  }
});

const MATCH_FIXTURES: Array<{
  name: string;
  input: {
    title?: string | null;
    character_name?: string | null;
    story_name_snapshot?: string | null;
  };
  expected: boolean;
}> = [
  { name: 'empty title + char·story matches', input: { title: '', character_name: '캐릭터', story_name_snapshot: '스토리' }, expected: true },
  { name: 'null title + char·story matches', input: { title: null, character_name: '캐릭터', story_name_snapshot: '스토리' }, expected: true },
  { name: 'whitespace title + char·story matches', input: { title: '   ', character_name: '캐릭터', story_name_snapshot: '스토리' }, expected: true },
  { name: 'trim mismatch avoided', input: { title: '', character_name: ' 캐릭터 ', story_name_snapshot: ' 스토리 ' }, expected: true },
  { name: 'identical char+story matches once-form', input: { title: '', character_name: '같은이름', story_name_snapshot: '같은이름' }, expected: true },
  { name: 'explicit title ≠ meta', input: { title: '명시제목', character_name: '캐릭터', story_name_snapshot: '스토리' }, expected: false },
  { name: 'explicit title == meta', input: { title: '캐릭터 · 스토리', character_name: '캐릭터', story_name_snapshot: '스토리' }, expected: true },
  { name: 'explicit title == collapsed identical meta', input: { title: '같은이름', character_name: '같은이름', story_name_snapshot: '같은이름' }, expected: true },
  { name: 'empty title no meta does not match 대화', input: { title: '', character_name: null, story_name_snapshot: null }, expected: false },
  { name: 'character-only empty title matches', input: { title: '', character_name: '캐릭터', story_name_snapshot: null }, expected: true },
];

t('title matches meta matrix', () => {
  assert.equal(typeof conversationTitleMatchesMeta, 'function', 'conversationTitleMatchesMeta export');
  for (const row of MATCH_FIXTURES) {
    const got = conversationTitleMatchesMeta(row.input);
    assert.equal(got, row.expected, row.name);
    console.log(`MATCH_FIXTURE ${JSON.stringify(row.input)} => ${got}`);
  }
});

t('three list screens share helper; inline || 대화 removed', () => {
  const pages = [
    'apps/web/src/pages/ChatsPage.tsx',
    'apps/web/src/pages/ChatListRail.tsx',
    'apps/web/src/pages/CharacterPage.tsx',
  ];
  for (const rel of pages) {
    const text = src(rel);
    assert.match(text, /conversationTitleLabel\(/, rel);
    assert.match(text, /from ['\"]\.\.\/lib\/conversationTitleLabel['\"]/, rel);
    assert.doesNotMatch(text, /\|\| ['\"]대화['\"]/, rel);
  }
  const characterPage = src('apps/web/src/pages/CharacterPage.tsx');
  assert.match(characterPage, /resume\.title \|\| ['\"]최근 대화['\"]/);
});

t('/chats hides meta-only .p when label==meta; muted time/preview kept', () => {
  const chats = src('apps/web/src/pages/ChatsPage.tsx');
  assert.match(chats, /conversationMetaLabel/);
  assert.match(chats, /conversationTitleMatchesMeta/);
  assert.doesNotMatch(chats, /c\.character_name, c\.story_name_snapshot \|\| null/);
  assert.match(chats, /className=["']p muted["']/);
  assert.match(chats, /relTime\(c\.last_message_at \|\| c\.created_at\)/);
  assert.match(chats, /c\.preview \? ` · \$\{c\.preview\}`/);
  assert.match(chats, /!conversationTitleMatchesMeta\(c\)/);
});

t('rail omits char·story when label==meta; keeps relTime/preview line', () => {
  const rail = src('apps/web/src/pages/ChatListRail.tsx');
  assert.match(rail, /conversationMetaLabel/);
  assert.match(rail, /conversationTitleMatchesMeta/);
  assert.doesNotMatch(rail, /\[c\.character_name, c\.story_name_snapshot\]\.filter\(Boolean\)\.join\(' · '\)/);
  assert.match(rail, /className=["']p["']/);
  assert.match(rail, /relTime\(c\.last_message_at\)/);
  assert.match(rail, /c\.preview/);
  assert.match(rail, /conversationTitleMatchesMeta\(c\)/);
});

t('CharacterPage ConversationRow subtitle stays preview', () => {
  const characterPage = src('apps/web/src/pages/CharacterPage.tsx');
  assert.match(characterPage, /conv\.preview \|\| ['\"]메시지 없음['\"]/);
  assert.doesNotMatch(characterPage, /conversationTitleMatchesMeta/);
  assert.doesNotMatch(characterPage, /conversationMetaLabel/);
});

t('apps/server diff 0', () => {
  const changed = execSync('git diff --name-only HEAD -- apps/server', { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(changed, '');
  const untracked = execSync('git ls-files --others --exclude-standard -- apps/server', { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(untracked, '');
});

console.log(`passed ${passed}`);
console.log(`fixture_count ${FIXTURES.length}`);
