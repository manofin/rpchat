/**
 * npx tsx bench/characterPromptPreviewUi.test.ts
 * C7 character editor prompt-tab preview UI. No live HTTP / DB / deploy.
 * Helper/bench PASS is not a product PASS.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CharacterPromptPreview,
  CharacterPromptPreviewView,
  loadCharacterPromptPreview,
  UNSAVED_CHARACTER_PROMPT_PREVIEW_HINT,
} from '../apps/web/src/components/CharacterPromptPreview.tsx';
import type { CharacterPromptPreview as CharacterPromptPreviewBody } from '../apps/web/src/types.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const ROOT = path.resolve('apps/web/src');
const editor = fs.readFileSync(path.join(ROOT, 'components/CharacterEditor.tsx'), 'utf8');
const previewSrc = fs.readFileSync(path.join(ROOT, 'components/CharacterPromptPreview.tsx'), 'utf8');
const typesSrc = fs.readFileSync(path.join(ROOT, 'types.ts'), 'utf8');

function tabSection(key: string, next: string | null): string {
  const startTok = `tab === '${key}'`;
  const start = editor.indexOf(startTok);
  assert.ok(start >= 0, `tab === '${key}' missing`);
  const endTok = next ? `tab === '${next}'` : '← 이전';
  const end = editor.indexOf(endTok, start + startTok.length);
  assert.ok(end > start, `end marker ${JSON.stringify(endTok)} missing after ${key}`);
  return editor.slice(start, end);
}

const FIXTURE: CharacterPromptPreviewBody = {
  charName: '델타',
  userName: '나',
  promptVersion: '2026.08.22-r1+story+compact+roster+opening',
  model: 'm',
  contextTokens: 16384,
  sections: [
    { name: '시스템 규칙+카드+페르소나+장면', est_tokens: 1004, budget: 3880 },
    { name: '활성 로어', est_tokens: 0, budget: 2328 },
  ],
  totalEstTokens: 1004,
  fixedExcerpt: '고정발췌-UNIQUE-C7UI',
  fixedTruncated: false,
};

async function main() {
  await t('unsaved helper performs 0 getFn calls', async () => {
    const paths: string[] = [];
    const getFn = async <T>(p: string): Promise<T> => {
      paths.push(p);
      throw new Error(`unsaved must not fetch ${p}`);
    };
    assert.equal(await loadCharacterPromptPreview(undefined, getFn), null);
    assert.equal(await loadCharacterPromptPreview(null, getFn), null);
    assert.equal(await loadCharacterPromptPreview('', getFn), null);
    assert.deepEqual(paths, []);
  });

  await t('saved helper GETs /api/characters/:id/prompt-preview once', async () => {
    const paths: string[] = [];
    const getFn = async <T>(p: string): Promise<T> => {
      paths.push(p);
      return FIXTURE as T;
    };
    const out = await loadCharacterPromptPreview('7abb652b-c0be-43fe-b501-40d97a61a419', getFn);
    assert.equal(out, FIXTURE);
    assert.deepEqual(paths, ['/api/characters/7abb652b-c0be-43fe-b501-40d97a61a419/prompt-preview']);
  });

  await t('unsaved CharacterPromptPreview shows hint and no fetch', () => {
    const html = renderToStaticMarkup(createElement(CharacterPromptPreview, { characterId: undefined }));
    assert.ok(html.includes(UNSAVED_CHARACTER_PROMPT_PREVIEW_HINT));
    assert.equal(html.includes('새로고침'), false);
    assert.equal(html.includes('/api/characters/'), false);
  });

  await t('saved view binds sections, excerpt, est tokens', () => {
    const html = renderToStaticMarkup(createElement(CharacterPromptPreviewView, { preview: FIXTURE }));
    assert.ok(html.includes('시스템 규칙+카드+페르소나+장면'));
    assert.ok(html.includes('1004'));
    assert.ok(html.includes('3880'));
    assert.ok(html.includes('활성 로어'));
    assert.ok(html.includes('예상 토큰 1004'));
    assert.ok(html.includes('고정발췌-UNIQUE-C7UI'));
    assert.equal(html.includes('play_guide'), false);
  });

  await t('prompt tab mounts CharacterPromptPreview on character?.id only', () => {
    const prompt = tabSection('prompt', 'detail');
    assert.ok(prompt.includes('<CharacterPromptPreview characterId={character?.id} />'));
    assert.equal(prompt.includes('<CharacterPromptPreview characterId={character?.id} set='), false);
    assert.equal(tabSection('setup', 'intro').includes('CharacterPromptPreview'), false);
    assert.equal(tabSection('intro', 'prompt').includes('CharacterPromptPreview'), false);
    assert.equal(tabSection('detail', 'lore').includes('CharacterPromptPreview'), false);
    assert.equal(tabSection('lore', null).includes('CharacterPromptPreview'), false);
  });

  await t('preview does not call draft set() / autosave', () => {
    assert.equal(previewSrc.includes('setD('), false);
    assert.equal(previewSrc.includes('dirtyRef'), false);
    assert.equal(previewSrc.includes('flushCharacterDraft'), false);
    assert.equal(previewSrc.includes("set('"), false);
    assert.equal(previewSrc.includes('set("'), false);
    assert.ok(previewSrc.includes('새로고침'));
    assert.ok(previewSrc.includes('setReload((n) => n + 1)'));
  });

  await t('TokenChips field= count stays 8; none on preview', () => {
    assert.equal((editor.match(/<TokenChips field="/g) ?? []).length, 8);
    assert.equal(previewSrc.includes('TokenChips'), false);
    assert.equal(tabSection('prompt', 'detail').includes('<TokenChips field="play_guide"'), false);
  });

  await t('types export CharacterPromptPreview; editor as unknown stays 0', () => {
    assert.ok(typesSrc.includes('export interface CharacterPromptPreview'));
    assert.ok(typesSrc.includes('totalEstTokens'));
    assert.ok(typesSrc.includes('fixedExcerpt'));
    assert.equal(editor.includes('as unknown'), false);
    assert.equal(previewSrc.includes('as unknown'), false);
  });

  await t('story authoring markup stays out of character preview', () => {
    for (const needle of [
      'inject-preview',
      '대화에 적용될 스토리 설정',
      '예상 사용량: 약',
      '명 포함',
      'StartPreview',
      'storyRoom',
      'Modal',
      'BottomSheet',
    ]) {
      assert.equal(previewSrc.includes(needle), false, needle);
    }
  });

  console.log(`\n${passed} passed`);
}

void main();
