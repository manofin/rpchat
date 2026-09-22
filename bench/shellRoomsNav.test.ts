/** npx tsx bench/shellRoomsNav.test.ts
 * shell-rooms-nav — source locks (no device). Easton verifies real-device keyboard + safe-area.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { showBottomTabBar } from '../apps/web/src/lib/navTabs.ts';
import { conversationMetaLabel, conversationTitleLabel, conversationTitleMatchesMeta } from '../apps/web/src/lib/conversationTitleLabel.ts';

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

  t('NAV_TABS = 홈 | 채팅 | 명령어 | 설정', () => {
    assert.match(nav, /href: '\/'/);
    assert.match(nav, /href: '\/chats'/);
    assert.match(nav, /href: '\/shortcuts'/);
    assert.match(nav, /href: '\/settings'/);
    assert.match(nav, /label: '채팅'/);
    assert.match(nav, /label: '명령어'/);
  });

  t('showBottomTabBar hides on /chat/:id', () => {
    assert.equal(showBottomTabBar('/chat/abc'), false);
    assert.equal(showBottomTabBar('/chat/abc/settings'), false);
    assert.equal(showBottomTabBar('/'), true);
    assert.equal(showBottomTabBar('/chats'), true);
    assert.equal(showBottomTabBar('/shortcuts'), true);
    assert.equal(showBottomTabBar('/settings'), true);
  });

  t('BottomTabBar skips desktop and uses showBottomTabBar', () => {
    assert.match(bar, /useDesktopLayout/);
    assert.match(bar, /showBottomTabBar/);
  });

  t('App: ChatPage outside tab-shell; /chats and /shortcuts inside with BottomTabBar', () => {
    assert.match(app, /if \(chat\) return <ChatPage/);
    assert.match(app, /<BottomTabBar \/>/);
    assert.match(app, /match\(path, '\/chats'\)/);
    assert.match(app, /match\(path, '\/shortcuts'\)/);
    assert.match(app, /className="tab-shell"/);
  });

  t('ChatsPage: GET /api/conversations + story_name_snapshot label', () => {
    assert.ok(chats.includes("get<Conversation[]>('/api/conversations')"));
    const source = ts.createSourceFile('ChatsPage.tsx', chats, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const functions = source.statements.filter((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === 'ChatsPage');
    assert.equal(functions.length, 1);
    const compiled = ts.transpileModule(functions[0].getText(source), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
    }).outputText;
    const rows = [
      { id: 'story-room', title: '', character_name: '동료', story_name_snapshot: '모험', preview: '저장된 대화', created_at: 't' },
      { id: 'solo-room', title: '내 제목', character_name: '사서', story_name_snapshot: null, created_at: 't' },
    ];
    const navigations: string[] = [];
    const deps = { React, exports: {}, useState: () => [rows, () => {}], useEffect: () => {},
      useUi: () => ({ toast: () => assert.fail('unexpected toast') }), TopNav: () => null,
      Spinner: () => null, relTime: () => '방금', navigate: (href: string) => navigations.push(href),
      conversationMetaLabel, conversationTitleLabel, conversationTitleMatchesMeta };
    const render = new Function(...Object.keys(deps), `${compiled}\nreturn ChatsPage;`)(...Object.values(deps));
    const tree = render();
    const html = renderToStaticMarkup(tree);
    assert.match(html, /동료 · 모험/);
    assert.equal((html.match(/동료 · 모험/g) ?? []).length, 1, 'fallback title is not duplicated as metadata');
    assert.match(html, /내 제목/);
    assert.match(html, /사서/);
    assert.match(html, /저장된 대화/);
    const cards: React.ReactElement<any>[] = [];
    function visit(node: React.ReactNode) {
      React.Children.forEach(node, (child) => {
        if (!React.isValidElement<any>(child)) return;
        if (child.props.role === 'button') cards.push(child);
        visit(child.props.children);
      });
    }
    visit(tree);
    assert.equal(cards.length, 2);
    cards[0].props.onClick();
    let prevented = false;
    cards[1].props.onKeyDown({ key: 'Enter', preventDefault: () => { prevented = true; } });
    cards[1].props.onKeyDown({ key: 'Escape', preventDefault: () => assert.fail('unrelated key captured') });
    assert.equal(prevented, true);
    assert.deepEqual(navigations, ['/chat/story-room', '/chat/solo-room']);
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
