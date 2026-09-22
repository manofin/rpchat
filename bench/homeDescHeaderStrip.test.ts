/**
 * npx tsx bench/homeDescHeaderStrip.test.ts
 * HomeDescHeaderStrip — display-only section-header strip on home/hero desc.
 * Isolated: no systemd, no live DB, no model, no generate, no server import.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StoryCard } from '../apps/web/src/pages/HomePage.tsx';
import { storyFixture } from './helpers/storyUiHarness.ts';

const require2 = createRequire(import.meta.url);
let helper: typeof import('../apps/web/src/lib/stripDescSectionHeaders.ts');
try {
  helper = require2('../apps/web/src/lib/stripDescSectionHeaders.ts');
} catch (e) {
  console.error('RED: helper module missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

const { stripDescSectionHeaders } = helper;

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, '..');
const src = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

const WEAPON_HEADER = 'WEAPON & ABILITY (무장 및 가호)';
const BACKGROUND_HEADER = 'BACKGROUND & PROFILE';
const YUKI_LINE = '관리국 보안팀장';
const OVERHAUL = '[오버홀 건틀릿]';
const LONG_KO = '그는 오래전부터 그 거리를 걸어 다녔고 아무도 그의 이름을 부르지 않았다.';

const FIXTURES: Array<{ name: string; input: string; expected: string }> = [
  {
    name: 'WEAPON header first line stripped',
    input: `${WEAPON_HEADER}\n${YUKI_LINE}`,
    expected: YUKI_LINE,
  },
  {
    name: 'BACKGROUND header first line stripped',
    input: `${BACKGROUND_HEADER}\n${YUKI_LINE}`,
    expected: YUKI_LINE,
  },
  {
    name: 'mid-body BACKGROUND stripped; surrounding prose kept',
    input: `${YUKI_LINE}\n${BACKGROUND_HEADER}\n${LONG_KO}`,
    expected: `${YUKI_LINE}\n${LONG_KO}`,
  },
  {
    name: '정상 첫줄 관리국 보안팀장 오지움',
    input: YUKI_LINE,
    expected: YUKI_LINE,
  },
  {
    name: '긴 한글 문장 오지움',
    input: LONG_KO,
    expected: LONG_KO,
  },
  {
    name: '[오버홀 건틀릿] 본문 오지움',
    input: `장비는 ${OVERHAUL} 한 벌이다.`,
    expected: `장비는 ${OVERHAUL} 한 벌이다.`,
  },
  {
    name: 'bracket-only line is body, not header',
    input: OVERHAUL,
    expected: OVERHAUL,
  },
  {
    name: 'empty desc',
    input: '',
    expected: '',
  },
  {
    name: 'header-only becomes empty',
    input: WEAPON_HEADER,
    expected: '',
  },
  {
    name: 'header plus blanks becomes empty',
    input: `${WEAPON_HEADER}\n\n`,
    expected: '',
  },
  {
    name: 'period line is not a header',
    input: 'WEAPON & ABILITY.',
    expected: 'WEAPON & ABILITY.',
  },
  {
    name: 'no ampersand is not a header',
    input: 'WEAPON ABILITY',
    expected: 'WEAPON ABILITY',
  },
  {
    name: 'mixed case is not a header',
    input: 'Weapon & Ability',
    expected: 'Weapon & Ability',
  },
];

t('fixture matrix', () => {
  for (const row of FIXTURES) {
    const got = stripDescSectionHeaders(row.input);
    assert.equal(got, row.expected, row.name);
    console.log(`FIXTURE ${JSON.stringify(row.input)} => ${JSON.stringify(got)}`);
  }
});

t('null/undefined → empty', () => {
  assert.equal(stripDescSectionHeaders(null), '');
  assert.equal(stripDescSectionHeaders(undefined), '');
});

t('does not mutate input string identity for keep-path', () => {
  const input = YUKI_LINE;
  const got = stripDescSectionHeaders(input);
  assert.equal(got, input);
});

t('HomePage character description strips headers; compact story card omits the world excerpt', () => {
  const text = src('apps/web/src/pages/HomePage.tsx');
  assert.match(text, /from ['\"]\.\.\/lib\/stripDescSectionHeaders['\"]/);
  assert.match(text, /stripDescSectionHeaders\(/);
  assert.match(text, /disc-card-desc/);
  const charBlock = text.slice(text.indexOf('filteredChars'));
  assert.match(charBlock, /stripDescSectionHeaders\(c\.description\)/);
  const html = renderToStaticMarkup(React.createElement(StoryCard, { story: storyFixture({ setting: `${WEAPON_HEADER}\n${YUKI_LINE}`, tagline: '짧은 소개' }) }));
  assert.match(html, /짧은 소개/);
  assert.doesNotMatch(html, /WEAPON|관리국 보안팀장|disc-card-desc/);
});

t('CharacterPage hero desc uses helper', () => {
  const text = src('apps/web/src/pages/CharacterPage.tsx');
  assert.match(text, /from ['\"]\.\.\/lib\/stripDescSectionHeaders['\"]/);
  assert.match(text, /stripDescSectionHeaders\(/);
  assert.match(text, /char-hero-desc/);
  assert.match(text, /stripDescSectionHeaders\(char\.description\)/);
});

t('CharacterEditor 원문 비범위 — helper 미적용, textarea 원문', () => {
  const text = src('apps/web/src/components/CharacterEditor.tsx');
  assert.doesNotMatch(text, /stripDescSectionHeaders/);
  assert.match(text, /value=\{d\.description\}/);
});

t('apps/server diff 0', () => {
  const changed = execSync('git diff --name-only HEAD -- apps/server', { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(changed, '');
  const untracked = execSync('git ls-files --others --exclude-standard -- apps/server', { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(untracked, '');
});

console.log(`passed ${passed}`);
console.log(`fixture_count ${FIXTURES.length}`);
console.log(`fixture_raw_weapon ${JSON.stringify(WEAPON_HEADER)}`);
console.log(`fixture_raw_background ${JSON.stringify(BACKGROUND_HEADER)}`);
console.log(`fixture_raw_yuki ${JSON.stringify(YUKI_LINE)}`);
console.log(`fixture_raw_overhaul ${JSON.stringify(OVERHAUL)}`);
