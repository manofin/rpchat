/** npx tsx bench/storyDetail.test.ts
 * F8 story-detail — StoryPage + StoryEditor. Source inventory only.
 * Helper/bench PASS is not a product PASS (helper-vs-live-contract).
 * No live HTTP / systemd / DB / inject / commit / deploy / restart.
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
try {
  require2('../apps/web/src/components/StoryEditor.tsx');
} catch (e) {
  console.error('RED: StoryEditor missing —', (e as Error).message.split('\n')[0]);
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
const editorSrc = fs.readFileSync(path.join(ROOT, 'components/StoryEditor.tsx'), 'utf8');
const homeSrc = fs.readFileSync(path.join(ROOT, 'pages/HomePage.tsx'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8');
const typesSrc = fs.readFileSync(path.join(ROOT, 'types.ts'), 'utf8');
const builderSrc = fs.readFileSync(path.resolve('apps/server/src/prompt/builder.ts'), 'utf8');
const charSrc = fs.readFileSync(path.resolve('apps/server/src/routes/characters.ts'), 'utf8');

t('DET-01 App routes /story/:id to StoryPage', () => {
  assert.ok(appSrc.includes("match(path, '/story/:id')"));
  assert.ok(appSrc.includes('StoryPage'));
  assert.ok(appSrc.includes("from './pages/StoryPage'"));
});

t('DET-02 StoryPage loads GET /api/stories/:id; PUT; DELETE archive', () => {
  assert.ok(pageSrc.includes('`/api/stories/${id}`') || pageSrc.includes('/api/stories/${id}'));
  assert.ok(pageSrc.includes('put(') || pageSrc.includes('StoryEditor'));
  assert.ok(pageSrc.includes('del(`/api/stories/${id}`)') || pageSrc.includes('del(`/api/stories/${id}`)'));
  assert.ok(pageSrc.includes('보관') || pageSrc.includes('archive'));
});

t('DET-03 StoryPage shows setting + minor_cast; hosts mains via mapping routes', () => {
  assert.ok(pageSrc.includes('setting'));
  assert.ok(pageSrc.includes('minor_cast'));
  assert.ok(pageSrc.includes('`/api/stories/${id}/characters`') || pageSrc.includes('/api/stories/${id}/characters'));
  assert.ok(pageSrc.includes('`/api/stories/${id}/characters/${') || pageSrc.includes('/api/stories/${id}/characters/${'));
  assert.ok(pageSrc.includes("navigate(`/character/${"));
});

t('DET-04 StoryEditor create/edit fields; no nested .sheet tabs; no cover', () => {
  assert.ok(editorSrc.includes("post('/api/stories'") || editorSrc.includes('post<') && editorSrc.includes('/api/stories'));
  assert.ok(editorSrc.includes('put<') && editorSrc.includes('/api/stories/'));
  assert.ok(editorSrc.includes('name'));
  assert.ok(editorSrc.includes('tagline'));
  assert.ok(editorSrc.includes('setting'));
  assert.ok(editorSrc.includes('minor_cast'));
  assert.equal(editorSrc.includes('className="sheet tabs"'), false);
  assert.equal(editorSrc.includes("className='sheet tabs'"), false);
  assert.equal(editorSrc.includes('cover'), false);
});

t('DET-05 HomePage story tab creates and opens detail', () => {
  assert.ok(homeSrc.includes('StoryEditor'));
  assert.ok(homeSrc.includes("navigate(`/story/${"));
  assert.ok(homeSrc.includes('첫 스토리를 만드세요'));
  assert.ok(homeSrc.includes("aria-label=\"새 스토리\"") || homeSrc.includes('aria-label="새 스토리"'));
  assert.equal(homeSrc.includes('className="tabs"'), false);
});

t('DET-06 types include StoryCharacter; no worlds', () => {
  assert.ok(typesSrc.includes('export interface StoryCharacter'));
  assert.ok(typesSrc.includes('character_id'));
  assert.equal(pageSrc.includes('worlds'), false);
  assert.equal(pageSrc.includes('world_id'), false);
  assert.equal(editorSrc.includes('worlds'), false);
  assert.equal(editorSrc.includes('world_id'), false);
  assert.equal(homeSrc.includes('worlds'), false);
});

t('DET-07 UI has no inject; characters list unfiltered', () => {
  assert.equal(/\bFROM\s+stories\b/i.test(builderSrc), false);
  assert.equal(builderSrc.includes('story_characters'), false);
  assert.equal(pageSrc.includes('buildPrompt'), false);
  assert.equal(pageSrc.includes('PROMPT_VERSION'), false);
  assert.equal(charSrc.includes('story_characters'), false);
  assert.equal(pageSrc.includes('conversations.story_id'), false);
  assert.equal(editorSrc.includes('/api/conversations'), false);
});

console.log(`passed ${passed}`);
