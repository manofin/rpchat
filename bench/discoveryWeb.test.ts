/**
 * npx tsx bench/discoveryWeb.test.ts
 * S4 discovery — Home / Character / Search polish contracts (source inventory).
 * Isolated: no systemd, no live DB, no model, no generate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => fs.readFileSync(path.join(dir, '..', rel), 'utf8');
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

t('S4 home keeps story/character tabs and real character/story APIs', () => {
  const home = src('apps/web/src/pages/HomePage.tsx');
  assert.ok(home.includes('home-tabs'));
  assert.ok(home.includes("setTab('story')"));
  assert.ok(home.includes("setTab('character')"));
  assert.ok(home.includes('/api/characters'));
  assert.ok(home.includes('/api/stories'));
  assert.ok(home.includes('filter-chips'));
  assert.ok(home.includes('disc-card'));
  assert.ok(home.includes('대화하기'));
  assert.equal(home.includes('fixtures'), false);
  assert.equal(home.includes('likes'), false);
});

t('S4 character detail exposes 대화하기 CTA and existing conversation create', () => {
  const page = src('apps/web/src/pages/CharacterPage.tsx');
  assert.ok(page.includes('대화하기'));
  assert.ok(page.includes("post<Conversation>('/api/conversations'"));
  assert.ok(page.includes('characterId: character.id'));
  assert.ok(page.includes('NewConversationSheet') || page.includes('setStarter(true)'));
  assert.equal(page.includes('storyId'), false);
  assert.equal(page.includes('fixtures'), false);
});

t('S4 search uses real APIs only and keeps /story/:id start path', () => {
  const page = code('apps/web/src/pages/SearchPage.tsx');
  assert.ok(page.includes('/api/search?q='));
  assert.ok(page.includes('/api/characters'));
  assert.ok(page.includes('/api/stories'));
  assert.ok(page.includes("navigate(`/story/${"));
  assert.ok(page.includes("navigate(`/character/${"));
  assert.ok(page.includes('filter-chips'));
  assert.equal(page.includes('fixtures'), false);
  assert.equal(page.includes('formatCount'), false);
});

t('S4 TopNav reaches 홈/캐릭터/검색/설정 without works/image', () => {
  const tabs = code('apps/web/src/lib/navTabs.ts');
  assert.ok(tabs.includes("label: '홈'"));
  assert.ok(tabs.includes("label: '캐릭터'"));
  assert.ok(tabs.includes("label: '검색'"));
  assert.ok(tabs.includes("label: '설정'"));
  assert.ok(tabs.includes('/?tab=character'));
  assert.equal(tabs.includes("href: '/works'"), false);
  assert.equal(tabs.includes("href: '/image'"), false);
});

t('S4 CSS ships discovery chips/cards/empty/hero; no Tailwind package', () => {
  const css = src('apps/web/src/app.css');
  assert.ok(css.includes('.filter-chip'));
  assert.ok(css.includes('.disc-card'));
  assert.ok(css.includes('.empty-state'));
  assert.ok(css.includes('.char-hero'));
  assert.ok(css.includes('.disc-start-cta'));
  assert.ok(!/^\s*inset-[xy]\s*:/m.test(css));
  const pkg = src('apps/web/package.json');
  assert.equal(pkg.includes('tailwindcss'), false);
  assert.equal(pkg.includes('"next"'), false);
});

t('S4 leaves apps/server untouched in working tree intent (path inventory)', () => {
  // Contract reminder: this slice must not edit server sources.
  const home = src('apps/web/src/pages/HomePage.tsx');
  assert.ok(home.includes("from '../lib/api'"));
  assert.equal(home.includes('apps/server'), false);
});

console.log(`passed ${passed}`);
