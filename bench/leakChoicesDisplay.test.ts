/** TSX_TSCONFIG_PATH=apps/web/tsconfig.json node --import tsx bench/leakChoicesDisplay.test.ts
 * leak-choices-display — paired <choices> strip even with trailing junk.
 * Legacy helper coverage and server-event-to-renderer regression. LIVE_NO_TOUCH.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { adaptChatEvents } from '../apps/server/src/contracts/chatEventAdapter.ts';
import { MessageEvents } from '../apps/web/src/components/EventRenderer.tsx';
import type { Message } from '../apps/web/src/types.ts';
import {
  displayBubbleContent,
  hideIncompleteChoicesPrefix,
  sanitizeBubbleContent,
  stripPairedChoices,
} from './legacy/sanitizeBubble.ts';
import { visibleChoices } from '../apps/web/src/lib/choices.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const FINLEY_RAW =
  '빗소리가 처마를 스쳤다. 서리가 만년필을 내려놓았다.\n' +
  '<choices>["*편지를 집어들며* 이건 누구에게 온 거죠?","*한 발 물러서며* 오늘은 이만 가볼게요.","*창밖을 보다가* 비가 그치면 같이 나가요."]</choices>\n\n' +
  '★주입확인★';

function main() {
  t('Finley raw tail: paired choices stripped; ★주입확인★ kept', () => {
    const cleaned = sanitizeBubbleContent(FINLEY_RAW);
    assert.match(cleaned, /빗소리/);
    assert.doesNotMatch(cleaned, /<\s*\/?choices>/i);
    assert.match(cleaned, /★주입확인★/);
  });

  t('paired mid-body stripped; surrounding prose kept', () => {
    const mid = '그는 <choices>["가"]</choices> 라고 했고 끝.';
    const cleaned = sanitizeBubbleContent(mid);
    assert.doesNotMatch(cleaned, /<\s*\/?choices>/i);
    assert.match(cleaned, /그는/);
    assert.match(cleaned, /라고 했고 끝/);
  });

  t('정상 강조 ★중요★ 오지움', () => {
    const raw = '이건 ★중요★ 단서다.';
    assert.equal(sanitizeBubbleContent(raw), raw);
  });

  t('orphan </choices> hotfix still drops trailing close + BeatUi', () => {
    const raw =
      '빗소리가 처마를 스쳤다. 서리가 만년필을 내려놓았다.\n</choices>\n' +
      JSON.stringify({ location_badge: '보관소 안쪽', roster: [] });
    const cleaned = sanitizeBubbleContent(raw);
    assert.match(cleaned, /빗소리/);
    assert.doesNotMatch(cleaned, /<\s*\/?choices>/i);
    assert.doesNotMatch(cleaned, /location_badge/);
  });

  t('party narration, header and info consume canonical server events', () => {
    for (const block_kind of ['narration', 'header', 'info']) {
      const events = adaptChatEvents({ id: block_kind, role: 'assistant', content: FINLEY_RAW, meta: { block_kind } });
      const html = renderToStaticMarkup(React.createElement(MessageEvents, { message: { eventVersion: 1, events, status: 'complete' } }));
      assert.match(html, /빗소리/);
      assert.match(html, /★주입확인★/);
      assert.doesNotMatch(html, /choices|편지를 집어들며/i);
    }
  });

  t('saved and streaming surfaces ignore raw content and use the same snapshot', () => {
    const events = adaptChatEvents({ id: 'saved', role: 'assistant', content: FINLEY_RAW });
    for (const streaming of [false, true]) {
      const message = { eventVersion: 1, events, status: streaming ? 'streaming' : 'complete', content: 'RAW_PRIVATE <choices>["]' } as Message;
      const html = renderToStaticMarkup(React.createElement(MessageEvents, { message, streaming }));
      assert.match(html, /빗소리/);
      assert.doesNotMatch(html, /RAW_PRIVATE|choices|편지를 집어들며/i);
    }
  });

  t('streaming partial unmatched <choices> stripped; prose kept', () => {
    const cleaned = sanitizeBubbleContent('빗소리가 처마를 스쳤다.<choices>["편지');
    assert.match(cleaned, /빗소리/);
    assert.doesNotMatch(cleaned, /<\s*\/?choices>/i);
    assert.doesNotMatch(cleaned, /편지/);
  });

  t('stripPairedChoices reused; ★주입확인★ kept after paired strip', () => {
    const stripped = stripPairedChoices(FINLEY_RAW);
    assert.doesNotMatch(stripped, /<\s*\/?choices>/i);
    assert.match(stripped, /★주입확인★/);
    assert.match(sanitizeBubbleContent(FINLEY_RAW), /★주입확인★/);
  });

  t('canonical streaming narration hides unmatched choice payload', () => {
    const events = adaptChatEvents({ id: 'partial', role: 'assistant', content: '빗소리가 처마를 스쳤다.<choices>["편지', meta: { block_kind: 'narration' } }, { streaming: true });
    const html = renderToStaticMarkup(React.createElement(MessageEvents, { message: { eventVersion: 1, events, status: 'streaming' }, streaming: true }));
    assert.match(html, /빗소리/);
    assert.doesNotMatch(html, /choices|편지/);
  });

  t('정상 choices → meta/칩 visibleChoices 회귀', () => {
    assert.deepEqual(
      visibleChoices(['*고개를 들며* 그래서요?', '*물러서며* 알겠어요.', '*마주 보며* 왜죠?']),
      ['*고개를 들며* 그래서요?', '*물러서며* 알겠어요.', '*마주 보며* 왜죠?'],
    );
    const page = fs.readFileSync('apps/web/src/pages/ChatPage.tsx', 'utf8');
    assert.match(page, /host\.meta\.choices/);
    assert.match(page, /m\.meta\.choices/);
    assert.match(page, /ChoiceChips/);
    assert.equal(fs.readFileSync('apps/web/src/lib/choices.ts', 'utf8').includes('sanitizeBubbleContent'), false);
  });

  t('streaming: every proper prefix of <choices> and </choices> is hidden', () => {
    const prose = '빗소리가 처마를 스쳤다.';
    for (const tag of ['<choices>', '</choices>', '<CHOICES>', '</Choices>']) {
      for (let n = 1; n < tag.length; n++) {
        const prefix = tag.slice(0, n);
        const shown = displayBubbleContent(prose + prefix, true);
        assert.equal(shown, prose, JSON.stringify({ tag, n, prefix, shown }));
        assert.equal(shown.includes('<'), false, prefix);
        assert.doesNotMatch(shown, /choices/i);
      }
    }
  });

  t('streaming: suffix that is not a choices prefix is shown again', () => {
    assert.equal(displayBubbleContent('본문<cat', true), '본문<cat');
    assert.equal(displayBubbleContent('본문< x', true), '본문< x');
    assert.equal(displayBubbleContent('3 < 5', true), '3 < 5');
    assert.equal(displayBubbleContent('본문<div>', true), '본문<div>');
  });

  t('completed bubble keeps trailing <; hide is streaming-only', () => {
    assert.equal(sanitizeBubbleContent('본문<'), '본문<');
    assert.equal(displayBubbleContent('본문<', false), '본문<');
    assert.equal(displayBubbleContent('본문<', true), '본문');
    assert.equal(hideIncompleteChoicesPrefix('본문<cho'), '본문');
  });

  t('streaming hide does not strip arbitrary HTML or ★강조★', () => {
    assert.equal(displayBubbleContent('이건 ★중요★ 단서다.', true), '이건 ★중요★ 단서다.');
    assert.equal(displayBubbleContent('메모 <div>ok</div>', true), '메모 <div>ok</div>');
  });

  t('choices chips / status panel stay off this helper', () => {
    assert.equal(fs.readFileSync('apps/web/src/lib/choices.ts', 'utf8').includes('hideIncompleteChoicesPrefix'), false);
    assert.equal(fs.readFileSync('apps/web/src/components/sceneStatus/SceneStatusPanel.tsx', 'utf8').includes('hideIncompleteChoicesPrefix'), false);
  });

  t('1:1 and party event snapshots hide every partial choices delimiter', () => {
    for (const block_kind of [undefined, 'narration', 'line']) {
      for (const tag of ['<choices>', '</choices>']) {
        for (let length = 1; length < tag.length; length++) {
          const events = adaptChatEvents({ id: 'prefix', role: 'assistant', content: '보이는 문장' + tag.slice(0, length), meta: { block_kind } }, { streaming: true });
          const html = renderToStaticMarkup(React.createElement(MessageEvents, { message: { eventVersion: 1, events, status: 'streaming' }, streaming: true }));
          assert.match(html, /보이는 문장/);
          assert.doesNotMatch(html, /&lt;|choices/i);
        }
      }
    }
  });

  t('choice chips keep their own formatting while legacy and canonical display are covered', () => {
    const self = fs.readFileSync('bench/leakChoicesDisplay.test.ts', 'utf8');
    assert.match(self, /sanitizeBubbleContent/);
    assert.match(self, /visibleChoices/);
    assert.match(self, /hideIncompleteChoicesPrefix/);
    assert.doesNotMatch(self, /from ['\"][^'\"]*prompt\/templates/);
  });

  console.log(`\n${passed} passed`);
}

main();
