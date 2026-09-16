/** npx tsx bench/shellRoomsNav.test.ts
 * shell-rooms-nav — source locks (no device). Easton verifies real-device keyboard + safe-area.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { showBottomTabBar } from '../apps/web/src/lib/navTabs.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

function main() {
  const app = fs.readFileSync('apps/web/src/App.tsx', 'utf8');
  const nav = fs.readFileSync('apps/web/src/lib/navTabs.ts', 'utf8');
  const bar = fs.readFileSync('apps/web/src/components/BottomTabBar.tsx', 'utf8');
  const chats = fs.readFileSync('apps/web/src/pages/ChatsPage.tsx', 'utf8');
  const rail = fs.readFileSync('apps/web/src/pages/ChatListRail.tsx', 'utf8');
  const chatPage = fs.readFileSync('apps/web/src/pages/ChatPage.tsx', 'utf8');
  const css = fs.readFileSync('apps/web/src/app.css', 'utf8');
  const inputbarBefore = css.includes('.inputbar { flex: 0 0 auto;');

  t('NAV_TABS = 홈 | 채팅 | 설정', () => {
    assert.match(nav, /href: '\/'/);
    assert.match(nav, /href: '\/chats'/);
    assert.match(nav, /href: '\/settings'/);
    assert.match(nav, /label: '채팅'/);
  });

  t('showBottomTabBar hides on /chat/:id', () => {
    assert.equal(showBottomTabBar('/chat/abc'), false);
    assert.equal(showBottomTabBar('/chat/abc/settings'), false);
    assert.equal(showBottomTabBar('/'), true);
    assert.equal(showBottomTabBar('/chats'), true);
    assert.equal(showBottomTabBar('/settings'), true);
  });

  t('BottomTabBar skips desktop and uses showBottomTabBar', () => {
    assert.match(bar, /useDesktopLayout/);
    assert.match(bar, /showBottomTabBar/);
  });

  t('App: ChatPage outside tab-shell; /chats inside with BottomTabBar', () => {
    assert.match(app, /if \(chat\) return <ChatPage/);
    assert.match(app, /<BottomTabBar \/>/);
    assert.match(app, /match\(path, '\/chats'\)/);
    assert.match(app, /className="tab-shell"/);
  });

  t('ChatsPage: GET /api/conversations + story_name_snapshot label', () => {
    assert.ok(chats.includes("get<Conversation[]>('/api/conversations')"));
    assert.ok(chats.includes('story_name_snapshot'));
  });

  t('ChatListRail: optional characterId for global list', () => {
    assert.match(rail, /characterId\?:/);
    assert.ok(rail.includes("'/api/conversations'") || rail.includes('`/api/conversations`'));
  });

  t('Desktop ChatPage: global rail + character-scoped secondary', () => {
    assert.match(chatPage, /전체 대화/);
    assert.match(chatPage, /이 캐릭터/);
    assert.match(chatPage, /<ChatListRail characterId=\{char\.id\}/);
  });

  t('CSS: bottom nav safe-area + list inset; inputbar rule still present (untouched intent)', () => {
    assert.match(css, /\.app-bottom-nav/);
    assert.match(css, /--bottom-nav-offset/);
    assert.match(css, /var\(--safe-bottom\)/);
    assert.equal(inputbarBefore, true);
  });

  console.log(`\n${passed} passed`);
}

main();
