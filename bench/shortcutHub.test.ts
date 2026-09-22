/**
 * npx tsx bench/shortcutHub.test.ts
 * shortcut-hub — /shortcuts CRUD UI + 4th tab + StoryEditor tab gone (same slice).
 * Isolated: no DB, no model, no live HTTP. LIVE_NO_TOUCH.
 * Galaxy safe-area/IME is Out (next release).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { NAV_TABS, showBottomTabBar } from '../apps/web/src/lib/navTabs.ts';

const require2 = createRequire(import.meta.url);
const {
  SHORTCUT_MAX,
  SHORTCUT_STORAGE_KEY,
  INJECT_INSTRUCTION_MAX,
  persistShortcuts,
  readShortcuts,
  removeShortcut,
  upsertShortcut,
} = require2('../apps/web/src/lib/shortcutMacro.ts') as typeof import('../apps/web/src/lib/shortcutMacro.ts');

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(dir, '..');
const src = (rel: string) => fs.readFileSync(path.join(appRoot, rel), 'utf8');
const hubSrc = src('apps/web/src/pages/ShortcutsPage.tsx');
const editorSrc = src('apps/web/src/components/StoryEditor.tsx');
const appSrc = src('apps/web/src/App.tsx');
const navSrc = src('apps/web/src/lib/navTabs.ts');
const barSrc = src('apps/web/src/components/BottomTabBar.tsx');
const topSrc = src('apps/web/src/components/TopNav.tsx');
const css = src('apps/web/src/app.css');
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');

function ruleBlock(selector: string): string {
  const re = new RegExp(
    selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}',
  );
  const m = cssCode.match(re);
  assert.ok(m, `missing rule ${selector}`);
  return m![1];
}

function memKv(init: Record<string, string> = {}) {
  const store = { ...init };
  const keys = () => Object.keys(store);
  return {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    get length() {
      return keys().length;
    },
    key: (i: number) => keys()[i] ?? null,
  };
}

t('hub reuses readShortcuts/persistShortcuts/upsert/remove — no new storage key', () => {
  assert.match(hubSrc, /readShortcuts\(\)/);
  assert.match(hubSrc, /persistShortcuts\(/);
  assert.match(hubSrc, /upsertShortcut\(/);
  assert.match(hubSrc, /removeShortcut\(/);
  assert.equal(hubSrc.includes('localStorage'), false);
  assert.equal(hubSrc.includes('getItem'), false);
  assert.equal(hubSrc.includes('setItem'), false);
  assert.equal(hubSrc.includes('rpchat.shortcuts.'), false);
  assert.equal(SHORTCUT_STORAGE_KEY, 'rpchat.shortcuts');
});

t('hub lists whatever is already on the global key (data move = same key)', () => {
  const kv = memKv({
    [SHORTCUT_STORAGE_KEY]: JSON.stringify([
      { name: '요약', text: '한줄' },
      { name: '지침', text: '주입', mode: 'inject' },
    ]),
  });
  const entries = readShortcuts(kv);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, '요약');
  assert.equal(entries[1].name, '지침');
  assert.equal(kv.getItem('rpchat.shortcuts.hub'), null);
});

t('inject save enforces INJECT_INSTRUCTION_MAX; new name only hits SHORTCUT_MAX', () => {
  assert.equal(INJECT_INSTRUCTION_MAX, 800);
  assert.equal(SHORTCUT_MAX, 20);
  const tooLong = 'x'.repeat(INJECT_INSTRUCTION_MAX + 1);
  const inj = upsertShortcut([], '긴지침', tooLong, 'inject');
  assert.equal(inj.ok, false);
  if (!inj.ok) assert.equal(inj.reason, 'inject_too_long');

  const full = Array.from({ length: SHORTCUT_MAX }, (_, i) => ({
    name: `n${i}`,
    text: 't',
  }));
  const add = upsertShortcut(full, '새이름', '본문', 'insert');
  assert.equal(add.ok, false);
  if (!add.ok) assert.equal(add.reason, 'full');

  const overwrite = upsertShortcut(full, 'n0', '덮어쓰기', 'insert');
  assert.equal(overwrite.ok, true);
  const removed = removeShortcut(full, 'n0');
  assert.equal(removed.length, SHORTCUT_MAX - 1);
  persistShortcuts(removed, memKv());
});

t('NAV_TABS is 홈|채팅|명령어|설정; BottomTabBar + TopNav share NAV_TABS', () => {
  assert.equal(NAV_TABS.map((x) => x.label).join('|'), '홈|채팅|명령어|설정');
  assert.equal(NAV_TABS[2].href, '/shortcuts');
  assert.equal(NAV_TABS[2].match('/shortcuts'), true);
  assert.equal(NAV_TABS[0].match('/shortcuts'), false);
  assert.match(barSrc, /NAV_TABS\.map/);
  assert.match(topSrc, /NAV_TABS\.map/);
  assert.match(navSrc, /label: '명령어'/);
});

t('App routes /shortcuts inside tab-shell; /chat/:id still hides the bar', () => {
  assert.match(appSrc, /match\(path, '\/shortcuts'\)/);
  assert.match(appSrc, /<ShortcutsPage/);
  assert.match(appSrc, /if \(chat\) return <ChatPage/);
  assert.equal(showBottomTabBar('/chat/abc'), false);
  assert.equal(showBottomTabBar('/shortcuts'), true);
});

t('StoryEditor shortcuts tab gone in the same slice as the hub', () => {
  assert.equal(editorSrc.includes("key: 'shortcuts'"), false);
  assert.equal(editorSrc.includes("label: '단축어'"), false);
  assert.equal(editorSrc.includes('persistShortcuts'), false);
  assert.equal(hubSrc.includes('upsertShortcut'), true);
  assert.ok(fs.existsSync(path.join(appRoot, 'apps/web/src/pages/ShortcutsPage.tsx')));
});

t('4-tab clip: min-width:0 on bar/items/labels; no overflow-x:hidden on the bar', () => {
  const nav = ruleBlock('.app-bottom-nav');
  const item = ruleBlock('.app-bottom-nav-item');
  const label = ruleBlock('.app-bottom-nav-label');
  assert.match(nav, /min-width:\s*0/);
  assert.match(item, /min-width:\s*0/);
  assert.match(item, /flex:\s*1\s+1\s+0/);
  assert.match(label, /min-width:\s*0/);
  assert.doesNotMatch(nav, /overflow-x:\s*hidden/);
  assert.doesNotMatch(item, /overflow-x:\s*hidden/);
  assert.doesNotMatch(label, /overflow-x:\s*hidden/);
  assert.doesNotMatch(label, /text-overflow:\s*ellipsis/);
});

t('shell regression: overflow-y / --app-height unchanged vs origin/master', () => {
  const baseCss = execFileSync('git', ['show', 'origin/master:apps/web/src/app.css'], {
    cwd: appRoot,
    encoding: 'utf8',
  }).replace(/\/\*[\s\S]*?\*\//g, '');
  const baseOy = [...baseCss.matchAll(/overflow-y:\s*[^;]+;/g)].map((m) => m[0]);
  const nowOy = [...cssCode.matchAll(/overflow-y:\s*[^;]+;/g)].map((m) => m[0]);
  assert.deepEqual(nowOy, baseOy, 'overflow-y declarations must be unchanged');
  const baseAppH = [...baseCss.matchAll(/--app-height:\s*[^;]+;/g)].map((m) => m[0]);
  const nowAppH = [...cssCode.matchAll(/--app-height:\s*[^;]+;/g)].map((m) => m[0]);
  assert.deepEqual(nowAppH, baseAppH, '--app-height assignments must be unchanged');
});

const chromeCandidates = [
  '/usr/bin/google-chrome',
  '/home/hermes/.hermes/bin/google-chrome',
  'google-chrome',
];
const chrome = process.argv.includes('--no-browser') ? undefined : chromeCandidates.find((c) => {
  try {
    if (c.includes('/')) return fs.existsSync(c);
    execFileSync(c, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
});

if (chrome) {
  t('390px 4-tab bar: scrollWidth<=innerWidth and all labels visible (not clipped)', () => {
    const outDir = '/tmp/shortcut-hub-clip';
    fs.mkdirSync(outDir, { recursive: true });
    const cssInline = css.replace(/@font-face\s*\{[\s\S]*?\}\s*/g, '');
    const html = `<!doctype html>
<html lang="ko">
<meta charset="utf-8">
<meta name="viewport" content="width=390, initial-scale=1, viewport-fit=cover">
<title>shortcut-hub-clip</title>
<style>
${cssInline}
html, body { margin: 0; width: 390px; max-width: 390px; }
:root { --safe-left: 0px; --safe-right: 0px; --safe-bottom: 0px; --safe-top: 0px; --app-height: 844px; --bottom-nav-h: 56px; --bottom-nav-offset: 56px; }
/* headless dump-dom window is often 500; pin the bar to the 390 frame (same lesson as fix-mobile-clip). */
.app-bottom-nav { position: static; width: 390px; max-width: 390px; left: auto; right: auto; }
.screen { width: 390px; max-width: 390px; }
</style>
<div class="tab-shell">
  <div class="tab-shell-body">
    <div class="screen">
      <div class="topbar"><div class="title"><h1>명령어</h1></div></div>
      <div class="content"><div class="section-title">명령어</div></div>
    </div>
  </div>
  <nav class="app-bottom-nav" aria-label="하단 탭">
    <button type="button" class="app-bottom-nav-item"><span class="app-bottom-nav-label">홈</span></button>
    <button type="button" class="app-bottom-nav-item"><span class="app-bottom-nav-label">채팅</span></button>
    <button type="button" class="app-bottom-nav-item is-active"><span class="app-bottom-nav-label">명령어</span></button>
    <button type="button" class="app-bottom-nav-item"><span class="app-bottom-nav-label">설정</span></button>
  </nav>
</div>
<script>
  const nav = document.querySelector('.app-bottom-nav');
  const screen = document.querySelector('.screen');
  const labels = [...document.querySelectorAll('.app-bottom-nav-label')];
  const items = [...document.querySelectorAll('.app-bottom-nav-item')];
  const csNav = getComputedStyle(nav);
  const csItem = getComputedStyle(items[0]);
  window.__hub = {
    innerWidth: window.innerWidth,
    navScrollWidth: nav.scrollWidth,
    navClientWidth: nav.clientWidth,
    screenScrollWidth: screen.scrollWidth,
    screenClientWidth: screen.clientWidth,
    navOverflowX: csNav.overflowX,
    itemMinWidth: csItem.minWidth,
    labels: labels.map((el) => ({
      text: el.textContent,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      offsetWidth: el.offsetWidth,
    })),
    labelCount: labels.length,
  };
  const labelsOk = window.__hub.labels.every((l) => l.clientWidth > 0 && l.scrollWidth <= l.clientWidth + 1);
  const barOk = nav.scrollWidth <= 390 + 1 && nav.scrollWidth <= nav.clientWidth + 1;
  const screenOk = screen.scrollWidth <= 390 + 1;
  window.__hub.ok = labelsOk && barOk && screenOk && window.__hub.labelCount === 4 && csNav.overflowX !== 'hidden';
  document.title = 'HUB ' + JSON.stringify(window.__hub);
</script>
</html>`;
    const htmlPath = path.join(outDir, 'hub-390.html');
    fs.writeFileSync(htmlPath, html);
    const dumped = execFileSync(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--window-size=390,844',
        '--dump-dom',
        `file://${htmlPath}`,
      ],
      { timeout: 30000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    );
    fs.writeFileSync(path.join(outDir, 'hub-390.dom.html'), dumped);
    const titleMatch = dumped.match(/<title>([\s\S]*?)<\/title>/i);
    const raw = (titleMatch?.[1] ?? '').replace(/^HUB\s*/, '');
    const metrics = JSON.parse(raw) as {
      navScrollWidth: number;
      navClientWidth: number;
      navOverflowX: string;
      itemMinWidth: string;
      labelCount: number;
      labels: Array<{ text: string; scrollWidth: number; clientWidth: number }>;
      ok: boolean;
    };
    console.log(`EVIDENCE 4tab 390 ${JSON.stringify(metrics)}`);
    assert.equal(metrics.labelCount, 4);
    assert.equal(metrics.itemMinWidth, '0px');
    assert.notEqual(metrics.navOverflowX, 'hidden');
    assert.ok(metrics.navScrollWidth <= 390 + 1, JSON.stringify(metrics));
    assert.ok(metrics.navScrollWidth <= metrics.navClientWidth + 1, JSON.stringify(metrics));
    assert.deepEqual(
      metrics.labels.map((l) => l.text),
      ['홈', '채팅', '명령어', '설정'],
    );
    for (const l of metrics.labels) {
      assert.ok(l.clientWidth > 0, JSON.stringify(l));
      assert.ok(l.scrollWidth <= l.clientWidth + 1, JSON.stringify(l));
    }
    assert.ok(metrics.ok, JSON.stringify(metrics));
  });
} else {
  console.log('note: optional 390px browser geometry check skipped; only core checks ran');
}

console.log(`\n${passed} passed`);
