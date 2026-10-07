import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConversationRecency } from '../apps/web/src/components/ConversationRecency.js';

function render(preview: string, last_message_at: string | null, created_at = '2026-09-05T04:15:03.059Z') {
  return renderToStaticMarkup(createElement(ConversationRecency, { conversation: { preview, last_message_at, created_at } }));
}
const empty = render('', null);
assert.ok(empty.includes('아직 대화 없음'));
assert.ok(empty.includes('만든 날짜'));
assert.ok(empty.includes('dateTime="2026-09-05T04:15:03.059Z"'));
assert.ok(!empty.includes('마지막 플레이'));
console.log('ok 1 empty historical room shows no-play state and real creation date');
const played = render('한소연 | 마지막 대사\n다음 줄', '2026-09-07T22:50:34.489Z');
assert.ok(played.includes('최근 장면 · 한소연 | 마지막 대사 다음 줄'));
assert.ok(played.includes('마지막 플레이'));
assert.ok(played.includes('dateTime="2026-09-07T22:50:34.489Z"'));
assert.ok(!played.includes('만든 날짜'));
console.log('ok 2 recent scene preserves actual speaker and keeps play time on a separate line');
assert.ok(render('', '2026-09-07T22:50:34.489Z').includes('표시할 최근 장면 없음'));
assert.ok(!render('', '2026-09-07T22:50:34.489Z').includes('아직 대화 없음'));
assert.ok(render('', null, 'invalid').includes('기록 없음'));
assert.ok(!render('', null, 'invalid').includes('Invalid Date'));
console.log('ok 3 unavailable preview and missing date do not invent play history');
