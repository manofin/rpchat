/** npx tsx bench/summarizeContract.test.ts — summarize 409 / evidence firstId / scene cover 범위 계약 (순수 헬퍼, 서버 기동 없음) */
import assert from 'node:assert/strict';
import { evidenceIdsForSlice, sceneCoverRange, isSummarizeBlocked } from '../apps/server/src/routes/summarizeContract.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

t('evidence_message_ids starts at slice firstId, not lastId', () => {
  const slice = [{ id: 'm10' }, { id: 'm11' }, { id: 'm12' }];
  const ids = evidenceIdsForSlice(slice as Array<{ id: string }>);
  assert.equal(ids[0], 'm10');
  assert.notEqual(ids[0], 'm12');
});

t('scene INSERT covers_from = slice[0].id, covers_until = lastId', () => {
  const r = sceneCoverRange([{ id: 'a' }, { id: 'b' }, { id: 'c' }] as Array<{ id: string }>);
  assert.equal(r.coversFrom, 'a');
  assert.equal(r.coversUntil, 'c');
});

t('second summarize while a job for the same conversation is queued → blocked (409 path)', () => {
  const active = [{ conversationId: 'convX' }, { conversationId: 'convY' }];
  assert.equal(isSummarizeBlocked(active as Array<{ conversationId: string }>, 'convX'), true);
  assert.equal(isSummarizeBlocked(active as Array<{ conversationId: string }>, 'convZ'), false);
});

console.log(`passed ${passed}`);
