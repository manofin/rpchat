/** npx tsx bench/storyTabs.test.ts
 * F8 story-tabs — HomePage 스토리/캐릭터 2탭. Source inventory only.
 * Helper/bench PASS is not a product PASS (helper-vs-live-contract).
 * No live HTTP / systemd / DB / inject / story-detail.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require2 = createRequire(import.meta.url);
try {
  require2('../apps/web/src/pages/HomePage.tsx');
} catch (e) {
  console.error('RED: HomePage missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const ROOT = path.resolve('apps/web/src');
const homeSrc = fs.readFileSync(path.join(ROOT, 'pages/HomePage.tsx'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8');
const appCss = fs.readFileSync(path.join(ROOT, 'app.css'), 'utf8');
const builderSrc = fs.readFileSync(path.resolve('apps/server/src/prompt/builder.ts'), 'utf8');
const charSrc = fs.readFileSync(path.resolve('apps/server/src/routes/characters.ts'), 'utf8');

t('TAB-01 HomePage has 스토리 and 캐릭터 tab labels', () => {
  assert.ok(homeSrc.includes('스토리'));
  assert.ok(homeSrc.includes('캐릭터'));
  assert.ok(homeSrc.includes('home-tabs'));
  assert.ok(homeSrc.includes("setTab('story')") || homeSrc.includes('setTab("story")') || homeSrc.includes("setTab('story')"));
  assert.ok(homeSrc.includes("tab === 'story'") || homeSrc.includes('tab === "story"'));
  assert.ok(homeSrc.includes("tab === 'character'") || homeSrc.includes('tab === "character"'));
});

t('TAB-02 tab chrome is home-tabs, not className="tabs"', () => {
  assert.equal(homeSrc.includes('className="tabs"'), false);
  assert.equal(homeSrc.includes("className='tabs'"), false);
  assert.ok(appCss.includes('.home-tabs {'));
  assert.ok(appCss.includes('.home-tabs button.active'));
  assert.equal(appCss.includes('.sheet .home-tabs'), false);
});

t('TAB-03 story tab lists GET /api/stories; empty copy present', () => {
  assert.ok(homeSrc.includes("/api/stories"));
  assert.ok(homeSrc.includes('첫 스토리를 만드세요'));
  assert.ok(homeSrc.includes('StoryEditor'));
  assert.ok(homeSrc.includes('/story/'));
});

t('TAB-04 character tab keeps GET /api/characters grid + CharacterEditor', () => {
  assert.ok(homeSrc.includes("/api/characters"));
  assert.ok(homeSrc.includes('CharacterEditor'));
  assert.ok(homeSrc.includes('첫 캐릭터를 만들어'));
  assert.ok(homeSrc.includes('navigate(`/character/${'));
  assert.equal(homeSrc.includes('story_characters'), false);
});

t('TAB-05 home tabs stay inject-free; worlds unused; characters unfiltered', () => {
  assert.ok(appSrc.includes('StoryPage'));
  assert.ok(appSrc.includes('/story/:id'));
  assert.equal(/\bFROM\s+stories\b/i.test(builderSrc), false);
  assert.equal(homeSrc.includes('worlds'), false);
  assert.equal(homeSrc.includes('world_id'), false);
  assert.equal(charSrc.includes('story_characters'), false);
});

console.log(`passed ${passed}`);
