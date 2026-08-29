/** npx tsx bench/storyInjectUi.test.ts
 * F8b story-inject-ui — StoryPage start-chat CTA. Source inventory only.
 * Helper/bench PASS is not a product PASS (helper-vs-live-contract).
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
const homeSrc = fs.readFileSync(path.join(ROOT, 'pages/HomePage.tsx'), 'utf8');
const editorSrc = fs.readFileSync(path.join(ROOT, 'components/StoryEditor.tsx'), 'utf8');
const storiesSrc = fs.readFileSync(path.resolve('apps/server/src/routes/stories.ts'), 'utf8');
const convSrc = fs.readFileSync(path.resolve('apps/server/src/routes/conversations.ts'), 'utf8');
const charPageSrc = fs.readFileSync(path.join(ROOT, 'pages/CharacterPage.tsx'), 'utf8');

t('UI-01 StoryPage CTA is 이 스토리로 대화 시작', () => {
  assert.ok(pageSrc.includes('이 스토리로 대화 시작'), 'missing CTA copy');
});

t('UI-02 CTA POSTs /api/conversations with storyId', () => {
  assert.ok(pageSrc.includes('/api/conversations'), 'StoryPage must POST conversations');
  assert.ok(pageSrc.includes('storyId'), 'payload must tag storyId');
  assert.ok(pageSrc.includes('characterId'), 'payload must pick a hosted main');
  assert.ok(pageSrc.includes('navigate(`/chat/${'), 'after create, open the chat');
});

t('UI-03 hosted main is the only start pick', () => {
  assert.ok(pageSrc.includes('hosted'), 'uses hosted mains');
  assert.ok(pageSrc.includes('character_id'), 'pick from story.characters');
  assert.ok(pageSrc.includes('hosted.length'), 'empty hosted cannot start');
});

t('UI-04 archived stories are not a start option', () => {
  assert.ok(storiesSrc.includes('WHERE s.archived = 0'), 'list API hides archived');
  assert.ok(homeSrc.includes('/api/stories'), 'home story tab uses list API');
  assert.ok(pageSrc.includes('story.archived'), 'detail CTA gated on archived');
  assert.equal(pageSrc.includes('이 스토리로 대화 시작') && !pageSrc.includes('story.archived'), false);
});

t('UI-05 no reapply control on StoryPage', () => {
  assert.equal(pageSrc.includes('재적용'), false);
  assert.equal(pageSrc.includes('story-reapply'), false);
  assert.equal(pageSrc.includes('story_applied_at'), false);
  assert.equal(editorSrc.includes('재적용'), false);
  assert.equal(editorSrc.includes('/api/conversations'), false);
});

t('UI-06 worlds unused; character tab start stays story-less', () => {
  assert.equal(pageSrc.includes('worlds'), false);
  assert.equal(pageSrc.includes('world_id'), false);
  assert.equal(homeSrc.includes('worlds'), false);
  assert.equal(charPageSrc.includes('storyId'), false);
});

t('UI-07 createSchema still accepts optional storyId (schema slice)', () => {
  assert.match(convSrc, /const createSchema = z\.object\(\{[\s\S]*?storyId:/);
});

console.log(`passed ${passed}`);
