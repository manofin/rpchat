/** npx tsx bench/settingsViewport.test.ts
 * Gate 2 — non-device 360/390/412/430 render evidence. No live PWA deploy.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const outDir = '/tmp/gate2-viewport';
const chrome = '/home/hermes/.hermes/bin/google-chrome';
const widths = [360, 390, 412, 430] as const;

mkdirSync(outDir, { recursive: true });

const css = readFileSync(join(root, 'apps/web/src/app.css'), 'utf8').replace(/@font-face\s*\{[\s\S]*?\}\s*/g, '');

function fixture(width: number): string {
  return `<!doctype html>
<html lang="ko">
<meta charset="utf-8">
<meta name="viewport" content="width=${width}, initial-scale=1, viewport-fit=cover">
<title>gate2-settings-viewport</title>
<style>
${css}
html, body {
  margin: 0;
  width: ${width}px;
  max-width: ${width}px;
  background: var(--bg);
  color: var(--fg);
  font-family: system-ui, sans-serif;
  overflow-x: hidden;
}
.settings-screen { width: ${width}px; max-width: ${width}px; }
</style>
<div class="settings-screen">
  <header class="settings-header">
    <button type="button" class="btn ghost icon" aria-label="뒤로">‹</button>
    <div class="avatar" style="width:32px;height:32px;border-radius:50%;background:#444;flex:0 0 auto"></div>
    <div class="title">
      <h1 class="settings-title">아주아주긴대화방이름테스트용제목입니다정말로길어서잘리면안됨</h1>
      <div class="sub">서리</div>
    </div>
  </header>
  <main class="settings-main">
    <section class="settings-section">
      <h2 class="section-title">채팅방 설정</h2>
      <div class="card settings-section-body">
        <button type="button" class="settings-row" aria-label="플레이 가이드"><span class="settings-row-title">플레이 가이드</span><span class="settings-chevron" aria-hidden="true">›</span></button>
        <button type="button" class="settings-row" aria-label="대화 프로필, 나"><span class="settings-row-title">대화 프로필</span><span class="settings-badge">나</span><span class="settings-chevron" aria-hidden="true">›</span></button>
        <button type="button" class="settings-row" aria-label="유저노트, 326자"><span class="settings-row-title">유저노트</span><span class="settings-badge">326자</span><span class="settings-chevron" aria-hidden="true">›</span></button>
        <button type="button" class="settings-row" aria-label="최대 출력량 조절, 균형"><span class="settings-row-title">최대 출력량 조절</span><span class="settings-badge">균형</span><span class="settings-chevron" aria-hidden="true">›</span></button>
        <button type="button" class="settings-row" aria-label="요약 메모리"><span class="settings-row-title">요약 메모리</span><span class="settings-chevron" aria-hidden="true">›</span></button>
      </div>
    </section>
    <section class="settings-section">
      <h2 class="section-title">전체 설정</h2>
      <div class="card settings-section-body">
        <button type="button" class="settings-row" aria-label="글꼴"><span class="settings-row-title">글꼴</span><span class="settings-chevron" aria-hidden="true">›</span></button>
        <button type="button" class="settings-row settings-row-disabled" role="switch" aria-checked="false" disabled aria-label="상황 이미지 보기"><span class="settings-row-title">상황 이미지 보기</span><span class="settings-switch" aria-hidden="true"></span><span class="settings-row-status">미연결</span></button>
      </div>
    </section>
    <section class="settings-section">
      <h2 class="section-title">시작 설정</h2>
      <div class="card settings-section-body">
        <div class="settings-row"><span class="settings-row-title">시작 설정</span><span class="settings-row-value">폐관 · 밤 · 기록을 남긴다</span></div>
      </div>
    </section>
    <section class="settings-section">
      <h2 class="section-title">업데이트 정보</h2>
      <div class="card settings-section-body">
        <div class="settings-row" id="version-row"><span class="settings-row-title">앱 버전</span><span class="settings-row-value">0.1.0</span></div>
      </div>
    </section>
  </main>
</div>
<script>
  const screen = document.querySelector('.settings-screen');
  const version = document.getElementById('version-row');
  const titleBox = document.querySelector('.settings-title').getBoundingClientRect();
  const headerBox = document.querySelector('.settings-header').getBoundingClientRect();
  const last = version.getBoundingClientRect();
  window.__gate2 = {
    width: ${width},
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth, screen.scrollWidth),
    screenWidth: screen.getBoundingClientRect().width,
    titleBottom: titleBox.bottom,
    headerBottom: headerBox.bottom,
    versionBottom: last.bottom,
    versionRight: last.right,
    overflowX: Math.max(screen.scrollWidth, screen.getBoundingClientRect().width) - ${width},
  };
  document.title = 'GATE2 ' + JSON.stringify(window.__gate2);
</script>
</html>`;
}

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

function pngSize(path: string): { w: number; h: number } {
  const buf = readFileSync(path);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

for (const width of widths) {
  const htmlPath = join(outDir, `hub-${width}.html`);
  const png = join(outDir, `hub-${width}.png`);
  writeFileSync(htmlPath, fixture(width));
  const dumped = execFileSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--window-size=${width},1100`,
      `--screenshot=${png}`,
      '--dump-dom',
      `file://${htmlPath}`,
    ],
    { timeout: 30000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  writeFileSync(join(outDir, `hub-${width}.dom.html`), dumped);
  const titleMatch = dumped.match(/<title>([\s\S]*?)<\/title>/i);
  const metrics = JSON.parse((titleMatch?.[1] ?? '').replace(/^GATE2\s*/, '')) as {
    width: number;
    scrollWidth: number;
    screenWidth: number;
    titleBottom: number;
    headerBottom: number;
    versionBottom: number;
    versionRight: number;
    overflowX: number;
  };

  t(`${width}px no horizontal overflow and version row present`, () => {
    assert.ok(metrics.overflowX <= 1, JSON.stringify(metrics));
    assert.ok(metrics.screenWidth <= width + 1, JSON.stringify(metrics));
    assert.ok(metrics.versionRight <= width + 1, JSON.stringify(metrics));
    assert.ok(metrics.titleBottom <= metrics.headerBottom + 1, 'title overflows header');
    assert.match(dumped, /앱 버전/);
    assert.match(dumped, /0\.1\.0/);
    assert.doesNotMatch(dumped, /재화/);
    assert.ok(readFileSync(png).length > 1000, png);
    const size = pngSize(png);
    assert.equal(size.w, width);
    console.log(`EVIDENCE ${width} ${png} png=${JSON.stringify(size)} metrics=${JSON.stringify(metrics)}`);
  });
}

console.log(`passed ${passed}`);
console.log(`VIEWPORT_DIR ${outDir}`);
