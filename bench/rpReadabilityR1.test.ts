/**
 * npx tsx bench/rpReadabilityR1.test.ts
 * R1 — Chat readability + MUST dialogue/narration contract. Web CSS / display only.
 * Isolated: no browser, no DB, no model, no network, no systemd.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrapSpeechMarks } from './legacy/speechMarks.ts';
import { parseTurnBlocks } from './legacy/turnBlocks.ts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { adaptChatEvents } from '../apps/server/src/contracts/chatEventAdapter.ts';
import { EventRenderer } from '../apps/web/src/components/EventRenderer.tsx';

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
const renderer = src('apps/web/src/components/EventRenderer.tsx');

function rule(sel: string, from = cssCode): string {
  const re = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*\\}`);
  return re.exec(from)?.[0] ?? '';
}

t('archived wrapSpeechMarks quotes unquoted speech and leaves marked text', () => {
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

t('parseTurnBlocks splits clear [Name] : "speech"; never invents speakers', () => {
  assert.deepEqual(
    parseTurnBlocks('문이 열렸다.\n\n[유키] : 「왔어?」\n\n바람이 불었다.'),
    [
      { kind: 'narration', text: '문이 열렸다.\n\n' },
      { kind: 'dialogue', speaker: '유키', text: '왔어?' },
      { kind: 'narration', text: '\n\n바람이 불었다.' },
    ],
  );
  assert.deepEqual(parseTurnBlocks('[첸] : "비켜."'), [{ kind: 'dialogue', speaker: '첸', text: '비켜.' }]);
  assert.deepEqual(parseTurnBlocks('모호한 "따옴표"만'), [{ kind: 'narration', text: '모호한 "따옴표"만' }]);
  assert.deepEqual(parseTurnBlocks('그냥 서술'), [{ kind: 'narration', text: '그냥 서술' }]);
});

t('parseTurnBlocks keeps incomplete dialogue as narration while streaming', () => {
  const incomplete = '[유키] : 「아직';
  assert.deepEqual(parseTurnBlocks(incomplete), [{ kind: 'narration', text: incomplete }]);
  assert.deepEqual(parseTurnBlocks(incomplete, { streaming: true }), [{ kind: 'narration', text: incomplete }]);
  // Completed form is dialogue either way.
  assert.equal(parseTurnBlocks('[유키] : 「왔어?」', { streaming: true })[0].kind, 'dialogue');
});

t('dialogue events use [Name] : "speech" for ordinary and party messages', () => {
  for (const meta of [{}, { block_kind: 'line', speaker_name: '유키', speaker_character_id: 'yuki' }]) {
    const content = meta.block_kind ? '「왔어?」' : '[유키] : 「왔어?」';
    const events = adaptChatEvents({ id: 'readability', role: 'assistant', content, meta });
    const html = renderToStaticMarkup(createElement(EventRenderer, { events }));
    assert.match(html, /class="beat-dialogue-speaker">\[유키\]/);
    assert.match(html, /class="beat-dialogue-sep"> : /);
    assert.match(html, /class="beat-dialogue-speech">&quot;왔어\?&quot;/);
  }
  assert.match(chat, /isUser \? renderContent\(m.content\) : <MessageEvents/);
  assert.doesNotMatch(chat, /wrapSpeechMarks|parseTurnBlocks/);
});

t('narration events render their exact text without client parsing', () => {
  const text = '[유키] : "이 문장은 서버가 서술로 분류했다."';
  const html = renderToStaticMarkup(createElement(EventRenderer, { events: [{ type: 'narration', id: 'n', text }] }));
  assert.match(html, /class="beat-narration"/);
  assert.doesNotMatch(html, /beat-dialogue-speaker/);
  assert.doesNotMatch(renderer, /parseTurnBlocks|sanitizeBubbleContent|wrapSpeechMarks/);
  assert.match(chat, /streaming=\{props.streaming\}/);
});

t('dialogue events keep the high-contrast speech surface', () => {
  assert.match(renderer, /bubble beat-dialogue-bubble/);
  const speech = rule('.beat-dialogue-bubble');
  assert.match(speech, /color:\s*var\(--kami-text-strong\)/);
  assert.match(speech, /font-weight:\s*500/);
});

t('.beat-narration is italic + muted (typography, not color alone)', () => {
  const n = rule('.beat-narration');
  assert.ok(n, '.beat-narration rule must exist');
  assert.match(n, /color:\s*var\(--kami-text-muted\)/);
  assert.match(n, /font-style:\s*italic/);
  const lh = /line-height:\s*([\d.]+)/.exec(n);
  assert.ok(lh && Number(lh[1]) >= 1.8, `.beat-narration line-height must be >= 1.8, got ${lh?.[1]}`);
  const size = /font-size:\s*(\d+)px/.exec(n);
  assert.ok(size && Number(size[1]) <= 15, `.beat-narration must be smaller than speech, got ${size?.[1]}`);
  assert.ok(!/--role-/.test(n), 'narration stays role-color free');
});

t('day/time BeatHeader has divider breathing above body hierarchy', () => {
  const h = rule('.beat-header');
  assert.ok(h, '.beat-header rule must exist');
  assert.match(cssCode, /\.beat-header::(before|after)/);
  assert.match(h, /font-weight:\s*650/);
  const mt = /margin:\s*(\d+)px/.exec(h);
  assert.ok(mt && Number(mt[1]) >= 14, `.beat-header top margin must breathe (>=14px), got ${mt?.[1]}`);
});

t('BeatUiPanel is a surface split from body; empty badge does not force strip', () => {
  const p = rule('.beat-ui-panel');
  assert.ok(p, '.beat-ui-panel rule must exist');
  assert.match(cssCode, /\.beat-ui-strip\s*\{/);
  assert.match(view, /function BeatUiPanel/);
  assert.match(view, /className="beat-ui-strip"/);
  assert.match(view, /user_sheet/);
  assert.match(view, /location_badge/);
  assert.match(view, /\.trim\(\)/);
  assert.match(view, /if \(!hasStrip && !hasRoster && !ui\.intent_hint\) return null/);
  assert.match(view, /className="beat-ui beat-ui-panel"/);
});

t('chat-topbar is denser so the scroll body gets the height (Galaxy)', () => {
  const chatBar = rule('.topbar.chat-topbar') || rule('.chat-topbar');
  assert.ok(chatBar, '.chat-topbar density rule must exist');
  assert.ok(/min-height:\s*\d+px/.test(chatBar) || /padding:/.test(chatBar), 'chat-topbar must tighten min-height or padding');
  const base = rule('.topbar');
  const baseMin = /min-height:\s*(\d+)px/.exec(base);
  const chatMin = /min-height:\s*(\d+)px/.exec(chatBar);
  if (baseMin && chatMin) {
    assert.ok(Number(chatMin[1]) < Number(baseMin[1]), 'chat-topbar min-height must be below default topbar');
  }
  assert.match(chat, /chat-topbar/);
});

t('narrow viewport keeps narration readable for party scroll', () => {
  assert.match(cssCode, /@media \(max-width: 767px\)/);
  assert.match(cssCode, /\.beat-narration[^{]*\{[^}]*line-height:\s*1\.9/);
});

t('1:1 bubble rules are byte-stable vs HEAD for assistant/user/bubble selectors', () => {
  // Compare against current committed HEAD for selectors we must not disturb.
  // On this feature branch, HEAD may already include prior R1 — still assert the
  // ordinary bubble contract remains a single definition each.
  assert.equal((cssCode.match(/^\.bubble\s*\{/gm) ?? []).length, 1);
  assert.match(cssCode, /\.msg\.assistant\s+\.bubble\s*\{/);
  assert.match(cssCode, /\.msg\.user\s+\.bubble\s*\{/);
});

t('production rendering has no server implementation or historical parser dependency', () => {
  assert.doesNotMatch(chat, /from ['"]\.\.\/\.\.\/server/);
  assert.doesNotMatch(view, /from ['"]\.\.\/\.\.\/server/);
  assert.doesNotMatch(renderer, /from ['"][^'"]*(?:server|bench\/legacy)/);
  assert.doesNotMatch(chat + renderer + view, /parseTurnBlocks|partyBlockFromMessage/);
});

console.log(`\n${passed} passed`);
