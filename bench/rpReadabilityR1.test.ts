/**
 * npx tsx bench/rpReadabilityR1.test.ts
 * R1 — Chat readability (Crack-play roadmap). Web CSS / display only.
 * Isolated: no browser, no DB, no model, no network, no systemd.
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrapSpeechMarks } from '../apps/web/src/lib/speechMarks.ts';

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
const view = src('apps/web/src/components/view.tsx');
const chat = src('apps/web/src/pages/ChatPage.tsx');

function git(args: string): string {
  return execSync(`git ${args}`, { cwd: appRoot, encoding: 'utf8' });
}

function rule(sel: string, from = cssCode): string {
  const re = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*\\}`);
  return re.exec(from)?.[0] ?? '';
}

t('wrapSpeechMarks is display-only: quotes unquoted speech, leaves marked text', () => {
  assert.equal(wrapSpeechMarks('문을 열어요.'), '「문을 열어요.」');
  assert.equal(wrapSpeechMarks('「이미 따옴표」'), '「이미 따옴표」');
  assert.equal(wrapSpeechMarks('『코너』'), '『코너』');
  assert.equal(wrapSpeechMarks('"already"'), '"already"');
  assert.equal(wrapSpeechMarks("already 'quoted'"), "already 'quoted'");
  assert.equal(wrapSpeechMarks(''), '');
  assert.equal(wrapSpeechMarks('   '), '   ');
  assert.equal(wrapSpeechMarks('*문을 연다*'), '*문을 연다*');
  assert.equal(wrapSpeechMarks('  문을 열어요.  '), '「문을 열어요.」');
});

t('ChatPage applies wrapSpeechMarks only on completed beat line bubbles, not 1:1', () => {
  assert.match(chat, /import\s*\{[^}]*wrapSpeechMarks[^}]*\}\s*from\s*['"]\.\.\/lib\/speechMarks['"]/);
  assert.match(chat, /kind\s*===\s*['"]line['"]/);
  assert.match(chat, /lineSpeech && !props\.streaming/);
  assert.match(chat, /wrapSpeechMarks\(/);
  // 1:1 / no-block_kind still renders raw content.
  assert.match(chat, /renderContent\(m\.content\)/);
  // hunter line path does not wrap (script row, not a bubble).
  const hunter = /kind === 'line' && props\.sceneFormat === 'hunter'[\s\S]{0,400}/.exec(chat)?.[0] ?? '';
  assert.ok(hunter, 'hunter line branch must exist');
  assert.ok(!/wrapSpeechMarks/.test(hunter), 'hunter line must not wrapSpeechMarks');
  assert.equal(src('apps/web/src/pages/useChat.ts').includes('wrapSpeechMarks'), false);
});

t('beat-line class marks party/dialog speech bubbles only', () => {
  assert.match(chat, /beat-line/);
  assert.match(cssCode, /\.msg\.beat-line\s+\.bubble\s*\{/);
  const speech = rule('.msg.beat-line .bubble');
  assert.match(speech, /color:\s*var\(--kami-text-strong\)/);
  assert.match(speech, /font-weight:\s*500/);
});

t('.beat-narration is quieter and more open than speech bubbles', () => {
  const n = rule('.beat-narration');
  assert.ok(n, '.beat-narration rule must exist');
  assert.match(n, /color:\s*var\(--kami-text-muted\)/);
  const lh = /line-height:\s*([\d.]+)/.exec(n);
  assert.ok(lh && Number(lh[1]) >= 1.8, `.beat-narration line-height must be >= 1.8, got ${lh?.[1]}`);
  const size = /font-size:\s*(\d+)px/.exec(n);
  assert.ok(size && Number(size[1]) <= 15, `.beat-narration must be smaller than speech, got ${size?.[1]}`);
  assert.ok(!/--role-/.test(n), 'narration stays role-color free');
});

t('day/time BeatHeader has divider breathing, not a caption-sized leftover', () => {
  const h = rule('.beat-header');
  assert.ok(h, '.beat-header rule must exist');
  assert.match(cssCode, /\.beat-header::(before|after)/);
  const mt = /margin:\s*(\d+)px/.exec(h);
  assert.ok(mt && Number(mt[1]) >= 14, `.beat-header top margin must breathe (>=14px), got ${mt?.[1]}`);
});

t('BeatUiPanel is a surface split from body, still bound to ui JSON', () => {
  const p = rule('.beat-ui-panel');
  assert.ok(p, '.beat-ui-panel rule must exist');
  assert.match(p, /background:\s*var\(--panel-1\)/);
  assert.match(cssCode, /\.beat-ui-strip\s*\{/);
  assert.match(view, /function BeatUiPanel/);
  assert.match(view, /className="beat-ui-strip"/);
  assert.match(view, /user_sheet/);
  assert.match(view, /sheet\.hp/);
  assert.match(view, /sheet\.money/);
  assert.match(view, /ui\.roster/);
  assert.equal((view.match(/parseBeatUi/) ?? []).length, 1);
  assert.match(view, /if \(!hasStrip && !hasRoster && !ui\.intent_hint\) return null/);
  assert.match(view, /className="beat-ui beat-ui-panel"/);
  assert.match(cssCode, /\.beat-ui-strip \+ \.beat-ui-roster/);
});

t('chat-topbar is denser than the default topbar so the scroll body gets the height', () => {
  const chatBar = rule('.topbar.chat-topbar') || rule('.chat-topbar');
  assert.ok(chatBar, '.chat-topbar density rule must exist outside the 767px block or as .topbar.chat-topbar');
  assert.ok(/min-height:\s*\d+px/.test(chatBar) || /padding:/.test(chatBar), 'chat-topbar must tighten min-height or padding');
  const base = rule('.topbar');
  const baseMin = /min-height:\s*(\d+)px/.exec(base);
  const chatMin = /min-height:\s*(\d+)px/.exec(chatBar);
  if (baseMin && chatMin) {
    assert.ok(Number(chatMin[1]) < Number(baseMin[1]), 'chat-topbar min-height must be below default topbar');
  }
  assert.match(chat, /className="topbar chat-topbar"/);
});

t('narrow viewport keeps narration readable for party scroll', () => {
  assert.match(cssCode, /@media \(max-width: 767px\)/);
  assert.match(cssCode, /\.beat-narration[^{]*\{[^}]*line-height:\s*1\.9/);
});

t('1:1 bubble rules are byte-stable vs HEAD', () => {
  const headCss = git('show HEAD:apps/web/src/app.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(rule('.msg.assistant .bubble'), rule('.msg.assistant .bubble', headCss));
  assert.equal(rule('.msg.user .bubble'), rule('.msg.user .bubble', headCss));
  assert.equal(rule('.bubble'), rule('.bubble', headCss));
});

t('R1 does not touch server sources, 1:1 prompt files, or useChat SSE', () => {
  assert.equal(git('diff HEAD -- apps/server').trim(), '');
  assert.equal(git('diff HEAD -- apps/web/src/pages/useChat.ts').trim(), '');
  assert.doesNotMatch(chat, /from ['"]\.\.\/\.\.\/server/);
  assert.doesNotMatch(view, /from ['"]\.\.\/\.\.\/server/);
  const marks = src('apps/web/src/lib/speechMarks.ts');
  assert.doesNotMatch(marks, /buildPrompt|HARD_RULES|PROMPT_VERSION/);
});

console.log(`\n${passed} passed`);
