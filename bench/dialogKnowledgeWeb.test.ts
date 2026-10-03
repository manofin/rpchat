import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KnowledgeForm, knowledgeLabel } from '../apps/web/src/components/DialogKnowledgeEditor.js';
import { ConversationMemoryPage } from '../apps/web/src/pages/ConversationMemoryPage.js';
import { UiProvider } from '../apps/web/src/components/ui.js';
import type { DialogKnowledgeEntry, DialogKnowledgeView, Memory } from '../apps/web/src/types.js';

const memory: Memory = { id: 'memory', conversation_id: 'room', character_id: 'a', content: '<script>TEST</script> 사용자가 나리에게 수첩을 돌려준다.', source: 'user', status: 'pinned', importance: 5, scope: 'conversation', created_at: '' };
const view: DialogKnowledgeView = { enabled: true, headMessageId: 'head', userName: '사용자', actors: [{ id: 'a', name: '나리' }, { id: 'b', name: '세라' }], memories: [memory], entries: [], excluded: [], invalidContract: false };
let checks = 0;
function t(name: string, fn: () => void) { fn(); console.log(`ok ${++checks} ${name}`); }
function form(entry?: DialogKnowledgeEntry, busy = false, override = {}) {
  return renderToStaticMarkup(React.createElement(KnowledgeForm, { memory, view: { ...view, ...override }, entry, busy, onSave() {}, onCancel() {} }));
}
t('memory page offers explicit knowledge authoring alongside original tabs', () => {
  const html = renderToStaticMarkup(React.createElement(UiProvider, null, React.createElement(ConversationMemoryPage, { conversationId: 'room' })));
  assert.ok(html.includes('인물별 기억')); assert.ok(html.includes('>기억<')); assert.ok(html.includes('>요약<'));
});
t('unassigned memory defaults to narrator only, never public', () => {
  const html = form();
  assert.ok(html.includes('value="narrator" selected=""')); assert.ok(!html.includes('value="public" selected=""'));
  assert.ok(html.includes('&lt;script&gt;TEST&lt;/script&gt;')); assert.ok(!html.includes('<script>'));
  assert.equal(knowledgeLabel(undefined, view.actors), '범위 미지정');
});
t('private checkbox roster and user→NPC direction remain explicit', () => {
  const e: DialogKnowledgeEntry = { memory_id: memory.id, anchor_message_id: 'head', kind: 'promise', known_by: ['a'], status: 'active', subject_id: 'user', target_id: 'a' };
  const html = form(e);
  assert.ok(html.includes('기억을 아는 인물')); assert.ok(html.includes('나리')); assert.ok(html.includes('세라'));
  assert.ok(html.includes('주체 (누가)')); assert.ok(html.includes('대상 (누구에게)'));
  assert.ok(html.includes('value="user" selected=""')); assert.ok(html.includes('value="a" selected=""'));
  assert.equal(knowledgeLabel(e, view.actors), '약속 · 나리');
  assert.equal(knowledgeLabel({ ...e, known_by: 'public', status: 'resolved' }, view.actors), '약속 · 모두 · 종료');
});
t('a fact can retain its explicit subject without assigning every generic fact to the user', () => {
  const e: DialogKnowledgeEntry = { memory_id: memory.id, anchor_message_id: 'head', kind: 'fact', known_by: 'public', status: 'active', subject_id: 'user' };
  const html = form(e);
  assert.ok(html.includes('관련 인물 (선택)'));
  assert.ok(html.includes('value="user" selected=""'));
  assert.ok(form().includes('value="" selected=""'));
});
t('empty private recipients and missing stored head cannot be submitted', () => {
  const e: DialogKnowledgeEntry = { memory_id: memory.id, anchor_message_id: 'head', kind: 'fact', known_by: [], status: 'active' };
  // Empty list is deliberately narrator-only; it does not silently turn public.
  assert.ok(form(e).includes('value="narrator" selected=""'));
  const html = form(undefined, false, { headMessageId: null });
  assert.ok(html.includes('type="submit" class="btn primary" disabled=""'));
  assert.ok(html.includes('첫 대화를 저장한 뒤'));
});
t('saving disables the whole form; labels never expose internal IDs', () => {
  assert.ok(form(undefined, true).includes('<fieldset disabled=""'));
  assert.equal(knowledgeLabel({ memory_id: 'secret-internal-id', anchor_message_id: 'head', kind: 'injury', known_by: ['a'], subject_id: 'user', status: 'active' }, view.actors), '부상 · 나리');
});
