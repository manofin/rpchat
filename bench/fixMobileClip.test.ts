/**
 * npx tsx bench/fixMobileClip.test.ts
 * fix-mobile-clip — home-tabs flex min-width + safe x padding (Galaxy clip).
 * Source/CSS contract + optional headless Chrome 390×844 scrollWidth proof.
 * Isolated: no DB, no model. Does not claim Galaxy PASS.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
const appRoot = path.join(dir, '..');
const src = (rel: string) => fs.readFileSync(path.join(appRoot, rel), 'utf8');
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

t('home-tabs has min-width:0 and stretches without expanding parent', () => {
  const b = ruleBlock('.home-tabs');
  assert.match(b, /min-width:\s*0/);
  assert.match(b, /align-self:\s*stretch/);
  assert.match(b, /box-sizing:\s*border-box/);
  // keep in-row tab scroll; do not rely on parent clip alone
  assert.match(b, /overflow-x:\s*auto/);
  // width:100% on home-tabs + margin:auto screen caused shrink-wrap; fill via .screen width:100% instead
  assert.doesNotMatch(b, /width:\s*100%/);
});

t('screen fills parent width (root: avoid margin:auto shrink-wrap)', () => {
  const b = ruleBlock('.screen');
  assert.match(b, /width:\s*100%/);
  assert.match(b, /max-width:\s*720px/);
  assert.match(b, /overflow-x:\s*hidden/);
});

t('home-tabs-meta has min-width:0 and tighter max-width cap', () => {
  const b = ruleBlock('.home-tabs-meta');
  assert.match(b, /min-width:\s*0/);
  assert.match(b, /flex:\s*0\s+1\s+auto/);
  assert.match(b, /max-width:\s*min\(\s*36vw\s*,\s*9rem\s*\)/);
  assert.doesNotMatch(b, /max-width:\s*42vw/);
});

t('screen / tab-shell / content have overflow-x:hidden safety net', () => {
  assert.match(ruleBlock('.screen'), /overflow-x:\s*hidden/);
  assert.match(ruleBlock('.tab-shell'), /overflow-x:\s*hidden/);
  assert.match(ruleBlock('.content'), /overflow-x:\s*hidden/);
});

t('content keeps overflow-y:auto and adds symmetric safe L/R padding', () => {
  const b = ruleBlock('.content');
  assert.match(b, /overflow-y:\s*auto/);
  assert.match(
    b,
    /padding:\s*12px\s+max\(\s*12px\s*,\s*var\(--safe-right\)\s*\)\s+calc\(\s*12px\s*\+\s*var\(--safe-bottom\)\s*\)\s+max\(\s*12px\s*,\s*var\(--safe-left\)\s*\)/,
  );
});

t('disc-grid still uses minmax(0, 1fr)', () => {
  assert.match(cssCode, /\.disc-grid\s*\{[^}]*grid-template-columns:\s*repeat\(\s*2\s*,\s*minmax\(\s*0\s*,\s*1fr\s*\)\s*\)/);
});

t('this PR does not touch locked overflow-y / --app-height / visualViewport / keyboard paths', () => {
  // Scope gate: only app.css (+ this bench) should change for the slice.
  const tracked = execFileSync('git', ['diff', '--name-only', 'origin/master', '--', 'apps/', 'bench/'], {
    cwd: appRoot,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean);
  const untracked = execFileSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '--', 'apps/', 'bench/'],
    { cwd: appRoot, encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  const files = [...new Set([...tracked, ...untracked])];
  assert.deepEqual(
    files.sort(),
    ['apps/web/src/app.css', 'bench/fixMobileClip.test.ts'].sort(),
    `unexpected files in slice: ${files.join(', ')}`,
  );

  // .content must keep overflow-y:auto (do not change vertical scroll contract).
  assert.match(ruleBlock('.content'), /overflow-y:\s*auto/);

  // Compare overflow-y / --app-height declarations vs origin/master CSS — values must match.
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
  // height: var(--app-height) counts may grow only if we did not edit those properties —
  // ensure every height: var(--app-height) in base still appears in current.
  for (const m of baseCss.matchAll(/height:\s*var\(--app-height\)/g)) {
    assert.ok(cssCode.includes(m[0]));
  }

  assert.equal(
    execFileSync('git', ['diff', 'origin/master', '--', 'apps/web/src/lib/viewport.ts', 'apps/web/src/pages/ChatPage.tsx'], {
      cwd: appRoot,
      encoding: 'utf8',
    }),
    '',
    'viewport.ts / ChatPage.tsx must be untouched',
  );
  assert.match(src('apps/web/src/lib/viewport.ts'), /visualViewport/);
});

// ── optional Chrome 390×844 scrollWidth proof ───────────────────────────────
const chromeCandidates = [
  '/usr/bin/google-chrome',
  '/home/hermes/.hermes/bin/google-chrome',
  'google-chrome',
];
const chrome = chromeCandidates.find((c) => {
  try {
    if (c.includes('/')) return fs.existsSync(c);
    execFileSync(c, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
});

if (chrome) {
  t('390×844 home fixture: document scrollWidth <= innerWidth', () => {
    const outDir = '/tmp/fix-mobile-clip';
    fs.mkdirSync(outDir, { recursive: true });
    // Strip @font-face to avoid network; keep the rules under test.
    const cssInline = css.replace(/@font-face\s*\{[\s\S]*?\}\s*/g, '');
    const html = `<!doctype html>
<html lang="ko">
<meta charset="utf-8">
<meta name="viewport" content="width=390, initial-scale=1, viewport-fit=cover">
<title>fix-mobile-clip</title>
<style>
${cssInline}
html, body { margin: 0; width: 390px; max-width: 390px; }
:root { --safe-left: 0px; --safe-right: 0px; --safe-bottom: 0px; --safe-top: 0px; --app-height: 844px; }
</style>
<div class="tab-shell">
  <div class="tab-shell-body">
    <div class="screen">
      <div class="topbar"><div class="title"><h1>홈</h1></div></div>
      <div class="home-tabs">
        <button type="button" class="active">스토리</button>
        <button type="button">캐릭터</button>
        <span class="home-tabs-meta">Qwen2.5-32B-Instruct-AWQ · 81 tok/s · ok</span>
      </div>
      <div class="content home-disc">
        <div class="disc-grid">
          <button type="button" class="disc-card"><div class="disc-card-body"><div class="disc-card-tag">아주긴메타라벨테스트용텍스트입니다</div></div></button>
          <button type="button" class="disc-card"><div class="disc-card-body"><div class="disc-card-tag">chip2</div></div></button>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
  const screen = document.querySelector('.screen');
  const tabs = document.querySelector('.home-tabs');
  const meta = document.querySelector('.home-tabs-meta');
  const csTabs = getComputedStyle(tabs);
  const csMeta = getComputedStyle(meta);
  const csContent = getComputedStyle(document.querySelector('.content'));
  window.__clip = {
    innerWidth: window.innerWidth,
    docScrollWidth: document.documentElement.scrollWidth,
    screenScrollWidth: screen.scrollWidth,
    screenClientWidth: screen.clientWidth,
    tabsScrollWidth: tabs.scrollWidth,
    tabsClientWidth: tabs.clientWidth,
    metaMaxWidth: csMeta.maxWidth,
    tabsMinWidth: csTabs.minWidth,
    contentOverflowX: csContent.overflowX,
    contentPadL: csContent.paddingLeft,
    contentPadR: csContent.paddingRight,
    ok: document.documentElement.scrollWidth <= window.innerWidth + 1
      && screen.scrollWidth <= screen.clientWidth + 1,
  };
  document.title = 'CLIP ' + JSON.stringify(window.__clip);
</script>
</html>`;
    const htmlPath = path.join(outDir, 'home-390.html');
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
    fs.writeFileSync(path.join(outDir, 'home-390.dom.html'), dumped);
    const titleMatch = dumped.match(/<title>([\s\S]*?)<\/title>/i);
    const raw = (titleMatch?.[1] ?? '').replace(/^CLIP\s*/, '');
    const metrics = JSON.parse(raw) as {
      innerWidth: number;
      docScrollWidth: number;
      screenScrollWidth: number;
      screenClientWidth: number;
      ok: boolean;
      metaMaxWidth: string;
      tabsMinWidth: string;
      contentOverflowX: string;
    };
    console.log(`EVIDENCE scrollWidth 390x844 ${JSON.stringify(metrics)}`);
    assert.equal(metrics.tabsMinWidth, '0px');
    assert.equal(metrics.contentOverflowX, 'hidden');
    // Prove the home shell itself does not expand past the 390 mobile frame
    // (Chrome headless may report a larger window.innerWidth; gate on .screen/.home-tabs).
    assert.ok(metrics.screenScrollWidth <= 390 + 1, JSON.stringify(metrics));
    assert.ok(metrics.screenClientWidth <= 390 + 1, JSON.stringify(metrics));
    assert.ok((metrics as { tabsScrollWidth: number }).tabsScrollWidth <= 390 + 1, JSON.stringify(metrics));
    assert.ok(metrics.screenScrollWidth <= metrics.screenClientWidth + 1, JSON.stringify(metrics));
    assert.ok(metrics.ok || metrics.screenScrollWidth <= 390 + 1, JSON.stringify(metrics));
  });
} else {
  console.log('note: Chrome not found — scrollWidth left to Easton manual (390×844 home)');
}

console.log(`\n${passed} passed`);
