/** npx tsx bench/summaryDiff.test.ts
 * summary-diff-ui — pure word-diff + baseline-selection helpers behind the SummaryTab diff highlight.
 * No DB, no server, no UI. Diff is display-only: this file never touches approve/PATCH/restore payloads.
 */
import assert from 'node:assert/strict';
import { currentApprovedState, diffWords, priorApprovedWhole } from '../apps/web/src/lib/summaryDiff.ts';
import type { Summary } from '../apps/web/src/types.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

function joined(before: string, after: string) {
  return diffWords(before, after).map((s) => s.text).join('');
}

t('identical text — all same, nothing added or removed', () => {
  const segs = diffWords('오늘은 맑았다', '오늘은 맑았다');
  assert.ok(segs.every((s) => s.type === 'same'));
  assert.equal(joined('오늘은 맑았다', '오늘은 맑았다'), '오늘은 맑았다');
});

t('word added', () => {
  const segs = diffWords('그는 떠났다', '그는 조용히 떠났다');
  assert.ok(segs.some((s) => s.type === 'add' && s.text.includes('조용히')));
  assert.ok(!segs.some((s) => s.type === 'del'));
});

t('word removed', () => {
  const segs = diffWords('그는 조용히 떠났다', '그는 떠났다');
  assert.ok(segs.some((s) => s.type === 'del' && s.text.includes('조용히')));
  assert.ok(!segs.some((s) => s.type === 'add'));
});

t('word replaced (del + add, not a same-length coincidence)', () => {
  const segs = diffWords('그는 화가 났다', '그는 슬퍼졌다');
  assert.ok(segs.some((s) => s.type === 'del' && s.text.includes('화가')));
  assert.ok(segs.some((s) => s.type === 'add' && s.text.includes('슬퍼졌다')));
});

t('multiple sentences changed — every changed word surfaces, unchanged words stay same', () => {
  const before = '첫 문장이다. 둘째 문장도 있다. 셋째는 그대로다.';
  const after = '첫 문장이 바뀌었다. 둘째 문장도 있다. 셋째는 그대로다.';
  const segs = diffWords(before, after);
  assert.ok(segs.some((s) => s.type === 'same' && s.text.includes('그대로다')));
  assert.ok(segs.some((s) => s.type === 'del' || s.type === 'add'));
});

t('empty before — entire text is an addition', () => {
  const segs = diffWords('', '전부 새 내용');
  assert.ok(segs.every((s) => s.type === 'add'));
  assert.equal(joined('', '전부 새 내용'), '전부 새 내용');
});

t('empty after — entire text is a deletion', () => {
  const segs = diffWords('전부 지워짐', '');
  assert.ok(segs.every((s) => s.type === 'del'));
});

t('both empty — no segments', () => {
  assert.deepEqual(diffWords('', ''), []);
});

function row(id: string, tier: Summary['tier'], status: Summary['status'], created_at: string, content = id): Summary {
  return { id, conversation_id: 'c1', content, covers_until_message_id: null, tier, status, created_at };
}

t('currentApprovedState — no approved state row exists yet', () => {
  const rows = [row('d1', 'state', 'draft', '2026-09-01T00:00:00Z')];
  assert.equal(currentApprovedState(rows), null);
});

t('currentApprovedState — picks the latest approved state by created_at, ignores other tiers/status', () => {
  const rows = [
    row('s1', 'state', 'approved', '2026-09-01T00:00:00Z'),
    row('s2', 'state', 'approved', '2026-09-03T00:00:00Z'),
    row('s3', 'state', 'draft', '2026-09-05T00:00:00Z'),
    row('w1', 'whole', 'approved', '2026-09-04T00:00:00Z'),
  ];
  assert.equal(currentApprovedState(rows)?.id, 's2');
});

t('priorApprovedWhole — no earlier approved whole exists (first whole ever)', () => {
  const target = row('w1', 'whole', 'draft', '2026-09-01T00:00:00Z');
  assert.equal(priorApprovedWhole([target], target), null);
});

t('priorApprovedWhole — picks the nearest earlier approved whole, not the furthest', () => {
  const target = row('w3', 'whole', 'draft', '2026-09-05T00:00:00Z');
  const rows = [
    row('w1', 'whole', 'approved', '2026-09-01T00:00:00Z'),
    row('w2', 'whole', 'approved', '2026-09-03T00:00:00Z'),
    target,
  ];
  assert.equal(priorApprovedWhole(rows, target)?.id, 'w2');
});

t('priorApprovedWhole regression — never selects the target row itself, even if it is approved and shares its own timestamp', () => {
  const target = row('w1', 'whole', 'approved', '2026-09-01T00:00:00Z');
  assert.equal(priorApprovedWhole([target], target), null);
});

t('priorApprovedWhole — later approved wholes (same or after target) are not candidates', () => {
  const target = row('w1', 'whole', 'draft', '2026-09-01T00:00:00Z');
  const rows = [target, row('w2', 'whole', 'approved', '2026-09-02T00:00:00Z')];
  assert.equal(priorApprovedWhole(rows, target), null);
});

console.log(`${passed} passed`);
