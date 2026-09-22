/**
 * npx tsx bench/discoveryWeb.test.ts
 * S4 discovery — Home / Character / Search polish contracts (source inventory).
 * Isolated: no systemd, no live DB, no model, no generate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAV_TABS, type NavTab } from '../apps/web/src/lib/navTabs.ts';

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
  assert.ok(home.includes('disc-card--cover'));
  assert.ok(home.includes('DiscCover'));
  assert.ok(home.includes('대화하기'));
  assert.ok(home.includes('shortModelLabel'));
  assert.ok(home.includes('empty-state-hero'));
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

function assertDiscoveryNavigation(tabs: NavTab[]) {
  assert.deepEqual(tabs.map(({ href, label }) => [href, label]), [
    ['/', '홈'], ['/chats', '채팅'], ['/shortcuts', '명령어'], ['/settings', '설정'],
  ]);
  for (const [route, href] of [
    ['/', '/'], ['/character/c1', '/'], ['/story/s1', '/'],
    ['/chats', '/chats'], ['/shortcuts', '/shortcuts'], ['/settings', '/settings'],
  ]) {
    assert.deepEqual(tabs.filter((tab) => tab.match(route)).map((tab) => tab.href), [href], route);
  }
  for (const route of ['/works', '/image', '/search']) {
    assert.deepEqual(tabs.filter((tab) => tab.match(route)), [], route);
  }
}

t('discovery stays under Home while shared tabs reach chats, shortcuts and settings', () => {
  assertDiscoveryNavigation(NAV_TABS);
  const topnav = code('apps/web/src/components/TopNav.tsx');
  assert.ok(topnav.includes('NAV_TABS.map'));
  assert.ok(topnav.includes('aria-label="검색"'));
  assert.ok(topnav.includes('onSubmit={goSearch}'));
  assert.ok(topnav.includes("navigate(query ? `/search?q=${encodeURIComponent(query)}` : '/search')"));
});

t('navigation contract rejects removed discovery routes and unrelated active tabs', () => {
  assert.throws(() => assertDiscoveryNavigation(NAV_TABS.map((tab, i) =>
    i === 0 ? { ...tab, match: (route) => route === '/' } : tab,
  )), /\/character\/c1/);
  assert.throws(() => assertDiscoveryNavigation(NAV_TABS.map((tab, i) =>
    i === 1 ? { ...tab, match: () => true } : tab,
  )));
  assert.throws(() => assertDiscoveryNavigation([
    ...NAV_TABS, { href: '/works', label: '작품', match: (route) => route === '/works' },
  ]));
});

t('S4 CSS ships discovery chips/cards/empty/hero; no Tailwind package', () => {
  const css = src('apps/web/src/app.css');
  assert.ok(css.includes('.filter-chip'));
  assert.ok(css.includes('.disc-card'));
  assert.ok(css.includes('.disc-cover'));
  assert.ok(css.includes('.disc-card--cover'));
  assert.ok(css.includes('.empty-state'));
  assert.ok(css.includes('.empty-state-hero'));
  assert.ok(css.includes('.char-hero'));
  assert.ok(css.includes('.disc-start-cta'));
  assert.ok(css.includes('.theme-toggle'));
  assert.ok(css.includes('.app-logo-mark'));
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


t('S4+ TopNav exposes theme toggle using read/persist/applyTheme', () => {
  const topnav = src('apps/web/src/components/TopNav.tsx');
  assert.ok(topnav.includes("from '../lib/theme'"));
  assert.ok(topnav.includes('ThemeToggleButton'));
  assert.ok(topnav.includes('persistTheme'));
  assert.ok(topnav.includes('applyTheme'));
  assert.ok(topnav.includes('RP Chat'));
  assert.ok(topnav.includes('aria-label="메뉴 열기"'));
});

t('S4+ modelLine never echoes filesystem paths', () => {
  const home = src('apps/web/src/pages/HomePage.tsx');
  assert.ok(home.includes('function shortModelLabel'));
  assert.ok(home.includes('function modelLine'));
  // Path strip: basename after last / or \\
  assert.ok(home.includes('[/\\\\]') || home.includes('[/\\]'));
});

console.log(`passed ${passed}`);
