/** npx tsx bench/settingsBadgeOverflow.test.ts
 * LOCK-TurnTotalDeadline-Followup #95 — long settings-badge at ~240px:
 * no horizontal page shove; amounts not mid-split (ellipsis + title).
 * Same Chrome dump-dom harness as settingsViewport (excluded from default suite).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const outDir = '/tmp/settings-badge-overflow';
const chromeCandidates = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/home/hermes/.hermes/bin/google-chrome',
];
const chrome = chromeCandidates.find((p) => existsSync(p));
if (!chrome) {
  console.error('SKIP: no Chrome binary (settingsBadgeOverflow harness)');
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });

const css = readFileSync(join(root, 'apps/web/src/app.css'), 'utf8').replace(/@font-face\s*\{[\s\S]*?\}\s*/g, '');
const longBadge = 'HP\u00a0100 · ₩\u00a012,000 · 계약 · 침식 · 목표아주긴상태라벨';
const width = 240;

const html = `<!doctype html>
<html lang="ko">
<meta charset="utf-8">
<meta name="viewport" content="width=${width}, initial-scale=1, viewport-fit=cover">
<title>settings-badge-overflow</title>
<style>
${css}
html, body {
  margin: 0;
  width: ${width}px;
  max-width: ${width}px;
  background: var(--bg);
  color: var(--fg);
  font-family: system-ui, sans-serif;
}
.settings-screen { width: ${width}px; max-width: ${width}px; }
</style>
<div class="settings-screen">
  <main class="settings-main">
    <section class="settings-section">
      <h2 class="section-title">채팅방 설정</h2>
      <div class="card settings-section-body">
        <button type="button" class="settings-row" id="long-row" aria-label="비트 상태">
          <span class="settings-row-title">비트 상태</span>
          <span class="settings-badge" id="long-badge" title="${longBadge}">${longBadge}</span>
          <span class="settings-chevron" aria-hidden="true">›</span>
        </button>
      </div>
    </section>
  </main>
</div>
<script>
  const nbsp = String.fromCharCode(0xa0);
  const screen = document.querySelector('.settings-screen');
  const badge = document.getElementById('long-badge');
  const row = document.getElementById('long-row');
  const badgeBox = badge.getBoundingClientRect();
  const rowBox = row.getBoundingClientRect();
  const cs = getComputedStyle(badge);
  const text = badge.textContent || '';
  window.__badge = {
    width: ${width},
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth, screen.scrollWidth),
    screenWidth: screen.getBoundingClientRect().width,
    overflowX: Math.max(screen.scrollWidth, screen.getBoundingClientRect().width) - ${width},
    badgeRight: badgeBox.right,
    rowRight: rowBox.right,
    badgeWidth: badgeBox.width,
    whiteSpace: cs.whiteSpace,
    overflow: cs.overflow,
    textOverflow: cs.textOverflow,
    title: badge.getAttribute('title') || '',
    nbspHpOk: text.includes('HP' + nbsp + '100'),
    nbspWonOk: text.includes('\u20a9' + nbsp + '12') || text.includes('₩' + nbsp + '12'),
    textSample: Array.from(text).slice(0, 40).map(c => c.charCodeAt(0) === 0xa0 ? '<NBSP>' : c).join(''),
  };
  document.title = 'BADGE ' + JSON.stringify(window.__badge);
</script>
</html>`;

const htmlPath = join(outDir, `badge-${width}.html`);
const png = join(outDir, `badge-${width}.png`);
writeFileSync(htmlPath, html);

const dumped = execFileSync(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${width},800`,
    `--screenshot=${png}`,
    '--dump-dom',
    `file://${htmlPath}`,
  ],
  { timeout: 30000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
);
writeFileSync(join(outDir, `badge-${width}.dom.html`), dumped);

const titleMatch = dumped.match(/<title>([\s\S]*?)<\/title>/i);
const metrics = JSON.parse((titleMatch?.[1] ?? '').replace(/^BADGE\s*/, '')) as {
  width: number;
  overflowX: number;
  screenWidth: number;
  badgeRight: number;
  rowRight: number;
  badgeWidth: number;
  whiteSpace: string;
  overflow: string;
  textOverflow: string;
  title: string;
  nbspHpOk?: boolean;
  nbspWonOk?: boolean;
  textSample: string;
};

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

t(`${width}px long settings-badge: no horizontal shove`, () => {
  assert.ok(metrics.overflowX <= 1, JSON.stringify(metrics));
  assert.ok(metrics.screenWidth <= width + 1, JSON.stringify(metrics));
  assert.ok(metrics.rowRight <= width + 2, JSON.stringify(metrics));
  assert.ok(metrics.badgeRight <= width + 2, JSON.stringify(metrics));
});

t(`${width}px badge uses nowrap+ellipsis; title has full text`, () => {
  assert.equal(metrics.whiteSpace, 'nowrap');
  assert.ok(metrics.overflow === 'hidden' || metrics.overflow.includes('hidden'), metrics.overflow);
  assert.equal(metrics.textOverflow, 'ellipsis');
  // dump-dom may serialize NBSP in attributes as &nbsp;
  const titleDecoded = metrics.title.replace(/&nbsp;/g, ' ');
  assert.equal(titleDecoded, longBadge);
  assert.match(metrics.title, /HP/);
  assert.match(metrics.title, /12,000/);
  assert.match(metrics.title, /계약/);
});

t(`${width}px HP/₩ amount pairs stay contiguous (NBSP in text)`, () => {
  assert.ok(metrics.nbspHpOk, `textSample=${metrics.textSample}`);
  assert.ok(metrics.nbspWonOk, `textSample=${metrics.textSample}`);
  assert.ok(readFileSync(png).length > 500, png);
});

console.log(`\n${passed} passed`);
console.log(`EVIDENCE ${png} metrics=${JSON.stringify(metrics)}`);
console.log(`BADGE_DIR ${outDir}`);
