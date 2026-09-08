/**
 * npx tsx bench/summaryBannerTrigger.test.ts
 * summary-banner-trigger-suppress — web-only banner trigger + later-suppress.
 * Isolated: no systemd, no live DB, no model, no generate, no server import.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require2 = createRequire(import.meta.url);
let banner: typeof import('../apps/web/src/lib/summaryBanner.ts');
try {
  banner = require2('../apps/web/src/lib/summaryBanner.ts');
} catch (e) {
  console.error('RED: helper module missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

const {
  SUMMARY_BANNER_NEW_MESSAGE_THRESHOLD,
  resolveBannerWatermarkId,
  countMessagesAfterWatermark,
  shouldShowSummaryBanner,
  summaryBannerStorageKey,
  isSummaryBannerSuppressed,
  suppressSummaryBanner,
} = banner;

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

type Kv = { getItem(key: string): string | null; setItem(key: string, value: string): void };

function mem(init?: Record<string, string>): Kv {
  const m = new Map<string, string>(Object.entries(init ?? {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => {
      m.set(k, v);
    },
  };
}

function pathIds(n: number, prefix = 'm') {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}${String(i + 1).padStart(2, '0')}` }));
}

function sum(partial: {
  status?: string;
  covers_until_message_id: string | null;
  covers_from_message_id?: string | null;
  conversation_id?: string;
}) {
  return {
    status: partial.status ?? 'approved',
    covers_until_message_id: partial.covers_until_message_id,
    covers_from_message_id: partial.covers_from_message_id ?? null,
    conversation_id: partial.conversation_id ?? 'c1',
  };
}

const T = SUMMARY_BANNER_NEW_MESSAGE_THRESHOLD;
assert.ok(Number.isInteger(T) && T > 0);

t('1 below threshold — banner hidden', () => {
  const path = pathIds(T - 1);
  const shown = shouldShowSummaryBanner({
    path,
    summaries: [],
    conversationId: 'c1',
    storage: mem(),
  });
  assert.equal(shown, false);
});

t('2 at threshold — banner shown', () => {
  const path = pathIds(T);
  const shown = shouldShowSummaryBanner({
    path,
    summaries: [],
    conversationId: 'c1',
    storage: mem(),
  });
  assert.equal(shown, true);
});

t('3 dropped_messages > 0 but new messages short — hidden', () => {
  const path = pathIds(T + 5);
  const wm = 'm' + String(T).padStart(2, '0');
  const shown = shouldShowSummaryBanner({
    path,
    summaries: [sum({ covers_until_message_id: wm })],
    conversationId: 'c1',
    droppedMessages: 40,
    storage: mem(),
  });
  assert.equal(countMessagesAfterWatermark(path, wm), 5);
  assert.equal(shown, false);
});

t('4 later then next message — still suppressed', () => {
  const path0 = pathIds(T);
  const storage = mem();
  assert.equal(shouldShowSummaryBanner({ path: path0, summaries: [], conversationId: 'c1', storage }), true);
  const wm = resolveBannerWatermarkId(path0, [], 'c1');
  suppressSummaryBanner('c1', wm, storage);
  const path1 = pathIds(T + 1);
  assert.equal(shouldShowSummaryBanner({ path: path1, summaries: [], conversationId: 'c1', storage }), false);
});

t('5 head change, same watermark — still suppressed', () => {
  const path = pathIds(T + 8);
  const until = 'm08';
  const summaries = [sum({ covers_until_message_id: until })];
  const storage = mem();
  const wm = resolveBannerWatermarkId(path, summaries, 'c1');
  assert.equal(wm, until);
  suppressSummaryBanner('c1', wm, storage);
  const longer = [...path, { id: 'm-head-b' }];
  assert.equal(resolveBannerWatermarkId(longer, summaries, 'c1'), until);
  assert.equal(shouldShowSummaryBanner({ path: longer, summaries, conversationId: 'c1', storage }), false);
});

t('6 new approved watermark — suppress expires', () => {
  const path = pathIds(T + 10);
  const storage = mem();
  const first = [sum({ covers_until_message_id: 'm08' })];
  const wm1 = resolveBannerWatermarkId(path, first, 'c1');
  suppressSummaryBanner('c1', wm1, storage);
  assert.equal(shouldShowSummaryBanner({ path, summaries: first, conversationId: 'c1', storage }), false);
  const second = [sum({ covers_until_message_id: 'm08' }), sum({ covers_until_message_id: 'm10' })];
  assert.equal(resolveBannerWatermarkId(path, second, 'c1'), 'm10');
  assert.equal(shouldShowSummaryBanner({ path, summaries: second, conversationId: 'c1', storage }), true);
});

t('7 other conversation suppress does not mix', () => {
  const path = pathIds(T);
  const storage = mem();
  suppressSummaryBanner('c1', null, storage);
  assert.equal(shouldShowSummaryBanner({ path, summaries: [], conversationId: 'c1', storage }), false);
  assert.equal(shouldShowSummaryBanner({ path, summaries: [], conversationId: 'c2', storage }), true);
});

t('8 no approved summary — count from start', () => {
  const path = pathIds(T);
  assert.equal(resolveBannerWatermarkId(path, [], 'c1'), null);
  assert.equal(countMessagesAfterWatermark(path, null), T);
  assert.equal(
    shouldShowSummaryBanner({ path: pathIds(T - 1), summaries: [], conversationId: 'c1', storage: mem() }),
    false,
  );
});

t('9 draft/rejected/deleted are not watermarks', () => {
  const path = pathIds(T + 10);
  const summaries = [
    sum({ status: 'draft', covers_until_message_id: 'm30' }),
    sum({ status: 'rejected', covers_until_message_id: 'm30' }),
    sum({ status: 'deleted', covers_until_message_id: 'm30' }),
  ];
  assert.equal(resolveBannerWatermarkId(path, summaries, 'c1'), null);
  assert.equal(countMessagesAfterWatermark(path, null), path.length);
});

t('10 off-path summary is not a watermark', () => {
  const path = pathIds(T + 4);
  const summaries = [sum({ covers_until_message_id: 'branch-leaf' })];
  assert.equal(resolveBannerWatermarkId(path, summaries, 'c1'), null);
});

t('11 legacy localStorage suppress values do not throw', () => {
  const path = pathIds(T);
  const local = mem({
    'rpchat.summarySuggest.c1.old-head': '99',
    'rpchat.summarySuggest.c1': '{',
  });
  local.setItem('not-json', '%%%');
  assert.doesNotThrow(() => {
    shouldShowSummaryBanner({
      path,
      summaries: [],
      conversationId: 'c1',
      storage: mem(),
      localStorage: local,
    });
  });
  const shown = shouldShowSummaryBanner({
    path,
    summaries: [],
    conversationId: 'c1',
    storage: mem(),
    localStorage: local,
  });
  assert.equal(shown, true);
});

t('12 ChatPage wires helper and keeps swipe; trigger is not dropped_messages', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const page = fs.readFileSync(path.join(dir, '../apps/web/src/pages/ChatPage.tsx'), 'utf8');
  const stripped = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(page, /from '\.\.\/lib\/summaryBanner'/);
  assert.match(page, /shouldShowSummaryBanner/);
  assert.match(page, /suppressSummaryBanner/);
  assert.match(page, /selectSibling|swipe|touchstart|onTouchStart/);
  assert.doesNotMatch(stripped, /triggered = dropped > 0/);
  assert.doesNotMatch(stripped, /suggestKey\(convId, headId\)/);
  assert.doesNotMatch(stripped, /lastBudget\.dropped_messages/);
  assert.equal(summaryBannerStorageKey('c1', null).includes('c1'), true);
  assert.ok(!summaryBannerStorageKey('c1', 'm08').includes('head'));
});

console.log(`passed ${passed}`);
