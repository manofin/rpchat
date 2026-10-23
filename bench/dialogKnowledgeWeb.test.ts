import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KnowledgeEntryDetails, KnowledgeForm, knowledgeLabel } from '../apps/web/src/components/DialogKnowledgeEditor.js';
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

t('scope wording describes recognition without claiming complete model isolation or guaranteed inclusion', () => {
  const html = form();
  assert.ok(html.includes('인물 인식 범위'));
  assert.ok(html.includes('인식 범위 저장'));
  assert.ok(html.includes('이미 대화에서 공개한 내용은 되돌리지 않습니다.'));
  assert.ok(html.includes('실제 응답 반영은 맥락과 예산에 따라 달라질 수 있습니다.'));
  assert.ok(!html.includes('인물별로 모델 요청을 분리하는 기능은 아닙니다.'));
  assert.ok(!html.includes('비밀'));
});

t('card distinguishes subject, recipient, state, assignment location and original evidence', () => {
  const entry: DialogKnowledgeEntry = { memory_id: memory.id, anchor_message_id: 'assignment', kind: 'promise', known_by: ['a'], status: 'active', subject_id: 'user', target_id: 'b' };
  const html = renderToStaticMarkup(React.createElement(KnowledgeEntryDetails, {
    memory: { ...memory, evidence_message_ids: ['original'] }, view, entry, onOpenSource() {},
  }));
  assert.ok(html.includes('주체: 사용자 → 대상: 세라'));
  assert.ok(html.includes('기억을 아는 인물: 나리 · 인식 상태: 유지'));
  assert.ok(html.includes('인식 범위를 지정한 위치'));
  assert.ok(html.includes('기억 근거 1 원문'));
  assert.ok(!html.includes('assignment')); assert.ok(!html.includes('original'));
});

t('off-branch assignments and missing evidence stay explicit without exposing internal IDs', () => {
  const entry: DialogKnowledgeEntry = { memory_id: memory.id, anchor_message_id: 'assignment', kind: 'fact', known_by: ['deleted-actor'], status: 'active' };
  const html = renderToStaticMarkup(React.createElement(KnowledgeEntryDetails, {
    memory: { ...memory, evidence_message_ids: [] },
    view: { ...view, excluded: [{ memory_id: memory.id, reason: 'assignment-off-branch' }] },
    entry, onOpenSource() {},
  }));
  assert.ok(html.includes('다른 분기에서 지정한 인식 범위입니다.'));
  assert.ok(html.includes('연결된 기억 근거가 없습니다.'));
  assert.ok(html.includes('찾을 수 없는 인물'));
  assert.ok(!html.includes('deleted-actor'));
});
