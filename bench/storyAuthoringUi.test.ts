/** npx tsx bench/storyAuthoringUi.test.ts
 * F8c story-authoring-ui — start sheet preview card + archived 409 copy.
 * Source inventory only. Helper/bench PASS is not a product PASS.
 * No live HTTP / systemd / DB / commit / deploy / restart.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require2 = createRequire(import.meta.url);
try {
  require2('../apps/web/src/pages/StoryPage.tsx');
} catch (e) {
  console.error('RED: StoryPage missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const ROOT = path.resolve('apps/web/src');
const pageSrc = fs.readFileSync(path.join(ROOT, 'pages/StoryPage.tsx'), 'utf8');
const typesSrc = fs.readFileSync(path.join(ROOT, 'types.ts'), 'utf8');
const charPageSrc = fs.readFileSync(path.join(ROOT, 'pages/CharacterPage.tsx'), 'utf8');
const editorSrc = fs.readFileSync(path.join(ROOT, 'components/StoryEditor.tsx'), 'utf8');
const storiesSrc = fs.readFileSync(path.resolve('apps/server/src/routes/stories.ts'), 'utf8');
const convSrc = fs.readFileSync(path.resolve('apps/server/src/routes/conversations.ts'), 'utf8');
const builderSrc = fs.readFileSync(path.resolve('apps/server/src/prompt/builder.ts'), 'utf8');
const configSrc = fs.readFileSync(path.resolve('apps/server/src/config.ts'), 'utf8');

t('AU-01 start sheet fetches inject-preview for the selected character', () => {
  assert.ok(pageSrc.includes('/inject-preview?characterId='), 'must call inject-preview');
  assert.ok(pageSrc.includes('encodeURIComponent(startPick)'), 'characterId is the current pick');
  assert.ok(typesSrc.includes('export interface StoryInjectPreview'));
  assert.ok(typesSrc.includes('settingExcerpt'));
  assert.ok(typesSrc.includes('settingTruncated'));
  assert.ok(typesSrc.includes('estTokens'));
});

t('AU-02 preview card is confirmation UI, not a debugger', () => {
  assert.ok(pageSrc.includes('대화에 적용될 스토리 설정'));
  assert.ok(pageSrc.includes('전체 포함'));
  assert.ok(pageSrc.includes('일부 잘림'));
  assert.ok(pageSrc.includes('명 포함'));
  assert.ok(pageSrc.includes('명 제외'));
  assert.ok(pageSrc.includes('예상 사용량: 약'));
  assert.ok(pageSrc.includes('대화를 시작하면 현재 설정이 이 대화에 동결됩니다.'));
  assert.ok(pageSrc.includes('이후 스토리를 수정해도 이미 시작한 대화에는 반영되지 않습니다.'));
  assert.equal(pageSrc.includes('storyRoom'), false);
  assert.equal(pageSrc.includes('fixedEst'), false);
  assert.equal(pageSrc.includes('budgets.fixed'), false);
  assert.equal(pageSrc.includes('BudgetReport'), false);
  assert.equal(pageSrc.includes('willFreeze'), false);
  assert.equal(pageSrc.includes('STORY_SETTING_SHARE'), false);
});

t('AU-03 stale preview cannot overwrite the current pick', () => {
  assert.ok(pageSrc.includes('previewSeq'), 'generation counter');
  assert.ok(pageSrc.includes('seq !== previewSeq.current'), 'ignore stale responses');
  assert.ok(pageSrc.includes("setPreviewKind('loading')"), 'character change goes to loading first');
  assert.ok(pageSrc.includes('cancelled'), 'effect cleanup cancels in-flight apply');
});

t('AU-04 start stays disabled until preview ok; failure has retry', () => {
  assert.ok(pageSrc.includes("previewKind === 'ok'"));
  assert.ok(pageSrc.includes('disabled={!startReady}'));
  assert.ok(pageSrc.includes('다시 시도'));
  assert.ok(pageSrc.includes("setPreviewKind('missing')"));
  assert.ok(pageSrc.includes("setPreviewKind('error')"));
  assert.ok(pageSrc.includes('미리보기를 불러올 수 없습니다.'));
  assert.ok(pageSrc.includes('미리보기를 불러오지 못했습니다.'));
  assert.ok(pageSrc.includes('role="alert"') || pageSrc.includes("role='alert'"));
  assert.ok(pageSrc.includes('aria-live="polite"') || pageSrc.includes("aria-live='polite'"));
});

t('AU-05 preview 409 and conversation POST 409 share the archived copy', () => {
  assert.ok(pageSrc.includes('보관된 스토리에서는 새 대화를 시작할 수 없습니다.'));
  assert.ok(pageSrc.includes('스토리를 다시 활성화한 뒤 시도해 주세요.'));
  assert.equal(pageSrc.split('보관된 스토리에서는 새 대화를 시작할 수 없습니다.').length - 1, 1, 'one shared constant');
  assert.ok(pageSrc.includes('isArchivedError'));
  assert.ok(pageSrc.includes('e.status !== 409') || pageSrc.includes('e.status === 409'));
  assert.match(pageSrc, /isArchivedError\(e\)[\s\S]*isArchivedError\(e\)/);
  assert.ok(pageSrc.includes("setPreviewKind('archived')"));
  assert.ok(pageSrc.includes('load({ quiet: true })'));
});

t('AU-06 empty setting / empty cast do not assume rows exist', () => {
  assert.ok(pageSrc.includes('설정이 없습니다.'));
  assert.ok(pageSrc.includes('조연: 없음'));
  assert.ok(pageSrc.includes('preview.cast.length === 0') || pageSrc.includes('preview.cast.filter'));
});

t('AU-07 character-tab start, editor, and server contracts stay untouched', () => {
  assert.equal(charPageSrc.includes('storyId'), false);
  assert.equal(charPageSrc.includes('inject-preview'), false);
  assert.equal(editorSrc.includes('inject-preview'), false);
  assert.equal(editorSrc.includes('/api/conversations'), false);
  assert.ok(storiesSrc.includes('/inject-preview'));
  assert.ok(convSrc.includes("error: 'archived'") || convSrc.includes('error: "archived"'));
  assert.ok(builderSrc.includes('computeStoryInjection'));
  assert.ok(configSrc.includes("PROMPT_VERSION = '2026.08.22-r1+story'"));
  assert.equal(pageSrc.includes('default_character_id'), false);
  assert.equal(pageSrc.includes('worlds'), false);
  assert.equal(pageSrc.includes('lore'), false);
});

t('AU-08 single hosted character is preselected for preview', () => {
  assert.ok(pageSrc.includes('hosted.length === 1 ? hosted[0].character_id'));
  assert.ok(pageSrc.includes('hosted.map'));
});

console.log(`passed ${passed}`);
