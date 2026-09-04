/**
 * npx tsx bench/chatLayout.test.ts
 * RPChat UI 확장 — turn grouping / INFO-after-body display permutation.
 * Isolated: no systemd, no live DB, no model, no generate.
 */
import assert from 'node:assert/strict';
import {
  groupChatTurns, shouldReorderTurn, turnChoicesHost, visualAssistantOrder,
} from '../apps/web/src/lib/chatLayout.ts';
import type { Message } from '../apps/web/src/types.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

function msg(partial: Partial<Message> & Pick<Message, 'id' | 'role'>): Message {
  return {
    conversation_id: 'c',
    parent_id: null,
    content: partial.content ?? '',
    status: 'complete',
    meta: partial.meta ?? {},
    bookmarked: false,
    created_at: '',
    siblings: { index: 0, count: 1, ids: [partial.id] },
    ...partial,
  };
}

t('shouldReorderTurn is hunter/dialog only', () => {
  assert.equal(shouldReorderTurn('hunter'), true);
  assert.equal(shouldReorderTurn('dialog'), true);
  assert.equal(shouldReorderTurn('beat'), false);
  assert.equal(shouldReorderTurn(undefined), false);
});

t('groupChatTurns splits on user rows and keeps persist assistant order', () => {
  const turns = groupChatTurns([
    msg({ id: 'u1', role: 'user', content: '가' }),
    msg({ id: 'info', role: 'assistant', meta: { block_kind: 'info' }, content: 'INFO' }),
    msg({ id: 'n1', role: 'assistant', meta: { block_kind: 'narration' }, content: '서술' }),
    msg({ id: 'l1', role: 'assistant', meta: { block_kind: 'line', choices: ['계속'] }, content: '대사' }),
    msg({ id: 'u2', role: 'user', content: '나' }),
    msg({ id: 'p1', role: 'assistant', meta: { block_kind: 'panel', choices: ['A', 'B'] }, content: 'INFO' }),
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].user?.id, 'u1');
  assert.deepEqual(turns[0].assistants.map((m) => m.id), ['info', 'n1', 'l1']);
  assert.equal(turns[1].user?.id, 'u2');
  assert.deepEqual(turns[1].assistants.map((m) => m.id), ['p1']);
});

t('visualAssistantOrder on mobile dialog paints body then INFO, persist last still hosts choices', () => {
  const assistants = [
    msg({ id: 'info', role: 'assistant', meta: { block_kind: 'info' }, content: 'INFO' }),
    msg({ id: 'n1', role: 'assistant', meta: { block_kind: 'narration' }, content: '서술' }),
    msg({ id: 'l1', role: 'assistant', meta: { block_kind: 'line', choices: ['계속'] }, content: '대사' }),
  ];
  const visual = visualAssistantOrder(assistants, true);
  assert.deepEqual(visual.map((m) => m.meta.block_kind), ['narration', 'line', 'info']);
  const host = turnChoicesHost(assistants);
  assert.equal(host?.id, 'l1');
  assert.deepEqual(host?.meta.choices, ['계속']);
  assert.equal(visualAssistantOrder(assistants, false).map((m) => m.id).join(','), 'info,n1,l1');
});

t('hunter persist-last panel still hosts choices after body-then-panel paint', () => {
  const assistants = [
    msg({ id: 'n', role: 'assistant', meta: { block_kind: 'narration' } }),
    msg({ id: 'line', role: 'assistant', meta: { block_kind: 'line' } }),
    msg({ id: 'panel', role: 'assistant', meta: { block_kind: 'panel', choices: ['근원'] } }),
  ];
  assert.deepEqual(visualAssistantOrder(assistants, true).map((m) => m.meta.block_kind), ['narration', 'line', 'panel']);
  assert.equal(turnChoicesHost(assistants)?.id, 'panel');
});

console.log(`\n${passed} passed`);
