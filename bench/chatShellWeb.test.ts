/**
 * npx tsx bench/chatShellWeb.test.ts
 * RPChat UI 확장 — overlay drawers + desktop rails, source contracts.
 * Isolated: no systemd, no live DB, no model, no generate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OverlayDrawer } from '../apps/web/src/components/OverlayDrawer.tsx';
import { DESKTOP_MQ, drawerKeydown } from '../apps/web/src/lib/chatLayout.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => fs.readFileSync(path.join(dir, '..', rel), 'utf8');
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

t('desktop breakpoint is 768px', () => {
  assert.equal(DESKTOP_MQ, '(min-width: 768px)');
  assert.ok(src('apps/web/src/app.css').includes('@media (min-width: 768px)'));
});

t('OverlayDrawer overlay has dialog, backdrop close, labelled close, and stays mounted when closed', () => {
  const closed = renderToStaticMarkup(createElement(OverlayDrawer, {
    open: false, onClose: () => undefined, side: 'right', title: '대화 도구',
  }, createElement('input', { defaultValue: 'keep-me' })));
  assert.match(closed, /role="dialog"/);
  assert.match(closed, /aria-label="닫기"/);
  assert.match(closed, /keep-me/);
  assert.ok(!closed.includes('is-open'));

  const open = renderToStaticMarkup(createElement(OverlayDrawer, {
    open: true, onClose: () => undefined, side: 'left', title: '대화',
  }, createElement('p', null, '목록')));
  assert.match(open, /is-open/);
  assert.match(open, /aria-modal="true"/);
  assert.match(open, /목록/);
});

t('ChatPage wires rails on desktop and overlays on mobile without navigating the hub away', () => {
  const page = src('apps/web/src/pages/ChatPage.tsx');
  assert.ok(page.includes('OverlayDrawer'));
  assert.ok(page.includes('ConversationTools'));
  assert.ok(page.includes('ChatListRail'));
  assert.ok(page.includes("mode={desktop ? 'rail' : 'overlay'}"));
  assert.ok(page.includes('setToolsOpen(true)'));
  assert.ok(!code('apps/web/src/pages/ChatPage.tsx').includes("navigate(`/chat/${id}/settings`)"));
});

t('mobile hunter/dialog turn paints body then INFO then persist-last choices', () => {
  const page = code('apps/web/src/pages/ChatPage.tsx');
  assert.ok(page.includes('shouldReorderTurn'));
  assert.ok(page.includes('visualAssistantOrder'));
  assert.ok(page.includes('hideChoices: true'));
  assert.ok(page.includes('ChoiceChips'));
  assert.ok(page.includes('turnChoicesHost'));
});

t('settings hub still lives on its own routes; tools reuse the same leaves', () => {
  const tools = src('apps/web/src/pages/ConversationTools.tsx');
  assert.ok(tools.includes('buildHubItems'));
  assert.ok(tools.includes('ConversationGuidePage'));
  assert.ok(tools.includes('ConversationMemoryPage'));
  const app = src('apps/web/src/App.tsx');
  assert.ok(app.includes('ConversationSettingsPage'));
  assert.ok(app.includes('resolveSettingsRoute'));
});

t('no Tailwind/Next and CSS fences stay unique for .msg/.bubble', () => {
  const css = src('apps/web/src/app.css');
  assert.equal((css.match(/^\.bubble \{/gm) ?? []).length, 1);
  assert.equal((css.match(/^\.msg \{/gm) ?? []).length, 1);
  assert.ok(css.includes('.overlay-drawer'));
  assert.ok(css.includes('.chat-shell'));
  // Tailwind utility *names* are not CSS properties: `inset-y-0` is a class, and
  // `inset-y: 0` is a declaration every browser drops — which silently costs the
  // slide-in panel its full height.
  assert.ok(!/^\s*inset-[xy]\s*:/m.test(css), 'no Tailwind-shaped declarations in plain CSS');
  const panel = /\.overlay-drawer-panel \{[^}]*\}/.exec(css)?.[0] ?? '';
  assert.match(panel, /position: absolute/);
  assert.match(panel, /top: 0/);
  assert.match(panel, /bottom: 0/);
  assert.match(panel, /width: min\(320px, 75vw\)/);
  // The overlay is a containing block for the panel. A 0-width overlay makes
  // max-width:100% resolve to 0px, so CJK titles stack as a vertical strip
  // and translateX(±100%) is a no-op — the "closed" drawer stays on screen.
  const drawer = /\.overlay-drawer \{[^}]*\}/.exec(css)?.[0] ?? '';
  assert.match(drawer, /position: fixed/);
  assert.match(drawer, /inset: 0/);
  assert.ok(!/width:\s*0/.test(drawer), 'overlay width:0 collapses the slide-in panel');
  const pkg = src('apps/web/package.json');
  assert.equal(pkg.includes('tailwindcss'), false);
  assert.equal(pkg.includes('"next"'), false);
});

t('drawerKeydown: Escape closes, Tab wraps at both ends, middle Tab is the browser\'s', () => {
  const mid = { focusables: 3, activeIndex: 1 };
  assert.deepEqual(drawerKeydown({ key: 'Escape' }, mid), { type: 'close' });
  assert.deepEqual(drawerKeydown({ key: 'Escape', shiftKey: true }, { focusables: 0, activeIndex: -1 }), { type: 'close' });
  assert.equal(drawerKeydown({ key: 'Tab' }, mid), null);
  assert.equal(drawerKeydown({ key: 'Tab', shiftKey: true }, mid), null);
  assert.equal(drawerKeydown({ key: 'a' }, mid), null);
  assert.deepEqual(drawerKeydown({ key: 'Tab' }, { focusables: 3, activeIndex: 2 }), { type: 'wrap', to: 'first' });
  assert.deepEqual(drawerKeydown({ key: 'Tab', shiftKey: true }, { focusables: 3, activeIndex: 0 }), { type: 'wrap', to: 'last' });
});

t('drawerKeydown: focus that already escaped the panel is pulled back, not let go', () => {
  // What a backdrop click leaves behind. An `activeElement === first || === last`
  // check returns null here, which is how focus walks out of an open drawer.
  assert.deepEqual(drawerKeydown({ key: 'Tab' }, { focusables: 2, activeIndex: -1 }), { type: 'wrap', to: 'first' });
  assert.deepEqual(drawerKeydown({ key: 'Tab', shiftKey: true }, { focusables: 2, activeIndex: -1 }), { type: 'wrap', to: 'last' });
  // Nothing to focus: swallow the Tab rather than hand focus to the page behind.
  assert.deepEqual(drawerKeydown({ key: 'Tab' }, { focusables: 0, activeIndex: -1 }), { type: 'block' });
});

t('OverlayDrawer carries out the rules and restores the opener on close', () => {
  const d = code('apps/web/src/components/OverlayDrawer.tsx');
  assert.ok(d.includes('drawerKeydown('), 'the component must not re-implement the rules');
  assert.match(d, /document\.addEventListener\('keydown', onKey\)/);
  assert.match(d, /document\.removeEventListener\('keydown', onKey\)/);
  assert.match(d, /if \(action\.type === 'close'\) onClose\(\)/);
  // Opened from a button, closed by Escape or backdrop: focus goes back where it was.
  assert.match(d, /openerRef\.current = document\.activeElement/);
  assert.match(d, /openerRef\.current\?\.focus\?\.\(\)/);
  // The page behind must not scroll under an open overlay.
  assert.match(d, /document\.body\.style\.overflow = 'hidden'/);
  assert.match(d, /document\.body\.style\.overflow = prevOverflow/);
  // Overlay only — a desktop rail is page furniture and traps nothing.
  assert.match(d, /if \(mode !== 'overlay' \|\| !open\) return;/);
});

t('overlay backdrop is a real control wired to onClose; the rail has none', () => {
  const overlay = renderToStaticMarkup(createElement(OverlayDrawer, {
    open: true, onClose: () => undefined, side: 'right', title: '대화 도구',
  }, createElement('button', null, '항목')));
  assert.match(overlay, /overlay-drawer-backdrop/);
  assert.match(overlay, /<button[^>]*overlay-drawer-backdrop[^>]*>/);
  assert.ok(code('apps/web/src/components/OverlayDrawer.tsx')
    .includes('className="overlay-drawer-backdrop"'));

  const rail = renderToStaticMarkup(createElement(OverlayDrawer, {
    open: true, onClose: () => undefined, side: 'left', mode: 'rail' as const, title: '대화',
  }, createElement('p', null, '목록')));
  assert.ok(!rail.includes('overlay-drawer-backdrop'), 'a desktop rail must not dim the page');
  assert.ok(!rail.includes('role="dialog"'), 'a desktop rail is not modal');
  assert.match(rail, /chat-rail chat-rail-left/);
  assert.match(rail, /목록/);
});

t('a closed overlay is inert and out of the tab order', () => {
  const closed = renderToStaticMarkup(createElement(OverlayDrawer, {
    open: false, onClose: () => undefined, side: 'right', title: '대화 도구',
  }, createElement('button', null, '항목')));
  assert.match(closed, /aria-hidden="true"/);
  assert.match(closed, /tabindex="-1"/);
  assert.ok(code('apps/web/src/components/OverlayDrawer.tsx').includes('inert: true'));
});

console.log(`\n${passed} passed`);
