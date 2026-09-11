/** npx tsx bench/storyEndingSuggestionUi.test.ts
 * ADR-F8h Slice 4 (story-ending-suggestion-ui): V3 제안형 배너.
 * - 턴 완료 후 GET ending-suggestions 조회, 강제 잠금 없이 노출, 닫기 가능.
 * - 확정은 사용자 클릭 + confirm 경유, POST /end { endingId, turnId }.
 * - 409 stale → 닫고 재조회 유도, 403 → 토스트 후 닫기.
 * Web-only slice: apps/web/src + bench. No server, no migration, no live DB.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  classifyEndError,
  shouldRefetchAfterEndError,
  visibleEndingSuggestions,
} from '../apps/web/src/lib/endingSuggestion.ts';
import type { EndingSuggestionsResponse } from '../apps/web/src/types.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const S = (id: string, title = `T-${id}`) => ({ ending_id: id, title, turn_id: 't1', evaluation_version: 1, rule_count: 1 });
const DOC = (ids: string[]): EndingSuggestionsResponse => ({ turn_id: 't1', evaluation_version: 1, suggestions: ids.map((id) => S(id)) });

async function main() {
  const hookSrc = fs.readFileSync('apps/web/src/lib/endingSuggestion.ts', 'utf8');
  const pageSrc = fs.readFileSync('apps/web/src/pages/ChatPage.tsx', 'utf8');

  await t('classifyEndError: 409 stale, 403 forbidden, else other', () => {
    assert.equal(classifyEndError(409), 'stale');
    assert.equal(classifyEndError(403), 'forbidden');
    assert.equal(classifyEndError(500), 'other');
    assert.equal(classifyEndError(0), 'other');
  });

  await t('visibleEndingSuggestions: null → [], dismissed filtered, order kept', () => {
    assert.deepEqual(visibleEndingSuggestions(null, new Set()), []);
    assert.deepEqual(visibleEndingSuggestions(DOC(['a', 'b']), new Set(['a'])).map((s) => s.ending_id), ['b']);
    assert.deepEqual(visibleEndingSuggestions(DOC(['a']), new Set(['a'])), []);
  });

  await t('shouldRefetchAfterEndError: only stale refetches', () => {
    assert.equal(shouldRefetchAfterEndError({ ok: false, reason: 'stale', message: 'x' }), true);
    assert.equal(shouldRefetchAfterEndError({ ok: false, reason: 'forbidden', message: 'x' }), false);
    assert.equal(shouldRefetchAfterEndError({ ok: false, reason: 'other', message: 'x' }), false);
    assert.equal(shouldRefetchAfterEndError({ ok: true }), false);
  });

  await t('hook fetches GET ending-suggestions and posts turnId on confirm', () => {
    assert.ok(hookSrc.includes('/ending-suggestions'), 'GET path');
    assert.ok(hookSrc.includes('turnId'), 'turnId echoed');
    assert.ok(/\/end`, \{ endingId.*turnId/.test(hookSrc), 'POST /end body carries turnId');
  });

  await t('hook never writes ended_at, never PATCH/PUTs, never auto-confirms', () => {
    const code = hookSrc.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    // ended_at READ is the ended-room skip. What is banned is WRITING it.
    assert.equal(/ended_at\s*=/.test(code), false, 'no ended_at write');
    assert.equal(code.includes('reached_ending_id'), false, 'no reached_ending_id touch');
    assert.equal(/patch\(|put\(/.test(code), false, 'read + confirm-POST only');
    assert.equal(/confirm\(target\)|confirm\(s\)/.test(pageSrc), true, 'confirm invoked from click handler only');
  });

  await t('hook queries only when eligible: story room, not ended, not streaming', () => {
    assert.ok(/!conv\.ended_at/.test(hookSrc), 'ended rooms skip');
    assert.ok(/conv\.story_id/.test(hookSrc), 'story rooms only');
    assert.ok(/was && !generating/.test(hookSrc), 'after turn completes');
  });

  await t('409 clears banner state and refetch path exists; 403 clears too', () => {
    assert.ok(/reason === 'stale'/.test(hookSrc), 'stale branch');
    assert.ok(hookSrc.includes("reason === 'forbidden'"), 'forbidden branch');
    assert.ok(pageSrc.includes('shouldRefetchAfterEndError'), 'page refetches after stale');
    assert.ok(pageSrc.includes('endingBanner.refresh()'), 'refresh 유도');
  });

  await t('ChatPage banner: non-blocking, dismissible, confirm-gated, ended rooms render none', () => {
    assert.ok(pageSrc.includes('도달 가능'), 'suggestion copy');
    assert.ok(pageSrc.includes('제안 닫기'), 'dismiss button');
    assert.ok(pageSrc.includes('endingBanner.dismiss'), 'dismiss wiring');
    assert.ok(pageSrc.includes('ui.confirm'), 'user confirm before POST');
    assert.ok(/!ended && endingBanner\.visible\.length > 0/.test(pageSrc), 'ended rooms show no banner');
    assert.ok(!/disabled=\{ended\}[\s\S]{0,200}endingBanner/.test(pageSrc), 'banner never locks composer');
  });

  await t('manual F8g reach flow untouched (no turnId, still D1 server path)', () => {
    assert.ok(pageSrc.includes('이 결말로 대화를 완결할까요?'), 'manual picker intact');
    assert.ok(/{ endingId: endingPick }/.test(pageSrc), 'manual POST sends endingId only');
  });

  console.log(`PASS=${passed}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
