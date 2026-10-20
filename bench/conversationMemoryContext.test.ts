import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConversationMemoryContextView, memoryContextVersion, memoryMessageHref } from '../apps/web/src/components/ConversationMemoryContext.js';
import type { ConversationDetail, PromptPreview } from '../apps/web/src/types.js';

const detail = {
  conversation: {
    id: 'room', head_message_id: 'head-a', updated_at: '2026-10-20T00:00:00Z',
    profile_name: 'rp-default', persona_id: 'persona', persona_applied_at: '2026-10-19T00:00:00Z',
    persona_name_snapshot: '이든', scene: {
      location: 'inn', day_index: 2, clock_minutes: 540, response_length: 'short',
      adventure: {
        version: 1, revision: 2, currency: '은화', balance: 19, registration: null, rank: '', experience: 0, skills: [],
        items: [{ id: 'key', name: '203호 열쇠', quantity: 1, ownership: 'loan', owner: '여관', terms: '반납', source: '수령' }],
        quests: [{ id: 'map', title: '지도 제작', terms: '미수락', reward: 30, stage: 'offered' }],
      },
    },
  },
  persona: { name: '새 카탈로그 이름' },
  scene_places: [{ id: 'inn', name: '여관' }],
  messages: [
    { id: 'action', role: 'user', status: 'complete', content: '상태 확인', meta: { adventure_receipt: { key: 'k' } } },
    { id: 'receipt', role: 'assistant', status: 'complete', content: '확인 기록\n숙박비 지급 1 은화', meta: { adventure_receipt: { key: 'k' } } },
    { id: 'head-a', role: 'assistant', status: 'complete', content: '가상의 서술 999 은화', meta: {} },
  ],
} as unknown as ConversationDetail;
let checks = 0;
function t(name: string, fn: () => void) { fn(); console.log(`ok ${++checks} ${name}`); }
const render = (d = detail, preview?: PromptPreview) => renderToStaticMarkup(React.createElement(ConversationMemoryContextView, { detail: d, preview }));

t('confirmed resources and offered quest are shown separately from scene facts and prose', () => {
  const html = render();
  assert.ok(html.includes('장소: 여관 · 시간: 2일차 09:00'));
  assert.ok(html.includes('소지금 19 은화'));
  assert.ok(html.includes('지도 제작 · 제안 · 제안 보수 30 은화'));
  assert.ok(html.includes('203호 열쇠 × 1 · 대여 · 소유자 여관'));
  assert.ok(!html.includes('999 은화'));
  assert.ok(html.includes('자유문 요약의 승인만으로 금액·물품·의뢰가 바뀌지 않습니다.'));
  assert.ok(html.includes('현재 분기의 확인 기록 1건'));
  assert.ok(html.includes('숙박비 지급 1 은화'));
});

t('an unconfirmed branch never promotes legacy HUD amounts to confirmed money', () => {
  const html = render({ ...detail, conversation: { ...detail.conversation, head_message_id: 'head-b', scene: { user_sheet: { money: 999 } } }, messages: [] });
  assert.ok(html.includes('이 분기에는 확인된 모험 상태가 없습니다.'));
  assert.ok(html.includes('장소: 미기록 · 시간: 미기록'));
  assert.ok(!html.includes('999'));
  assert.ok(!html.includes('숙박비 지급'));
  assert.ok(!html.includes('memory-confirmed-state'));
});

t('applied persona uses the frozen room snapshot and response length stays distinct from output profile', () => {
  const html = render();
  assert.ok(html.includes('대화 프로필: 이든 · 적용 당시 정보'));
  assert.ok(!html.includes('새 카탈로그 이름'));
  assert.ok(html.includes('출력/톤 프로필: rp-default · 응답 길이: 짧게'));
  assert.ok(!html.includes('미리보기 모델:'));
});

t('preview labels show estimates, never an exact next-request size or price', () => {
  const preview = { model: 'fixture-model', budget: { est_total: 123, available: 2000, context_tokens: 4096, reply_reserve: 2096 } } as PromptPreview;
  const html = render(detail, preview);
  assert.ok(html.includes('미리보기 모델: fixture-model'));
  assert.ok(html.includes('맥락 예상 123 / 2,000 토큰'));
  assert.ok(html.includes('입력 전 예상치'));
  assert.ok(!html.includes('가격'));
});

t('preview identity changes on branch, same-head scene edits and applied persona changes', () => {
  const original = memoryContextVersion(detail);
  assert.notEqual(memoryContextVersion({ ...detail, conversation: { ...detail.conversation, head_message_id: 'b' } }), original);
  assert.notEqual(memoryContextVersion({ ...detail, conversation: { ...detail.conversation, scene: { ...detail.conversation.scene, response_length: 'long' } } }), original);
  assert.notEqual(memoryContextVersion({ ...detail, conversation: { ...detail.conversation, persona_name_snapshot: '다른 이름' } }), original);
});

t('stored values are escaped and source IDs remain URL data', () => {
  const html = render({ ...detail, conversation: { ...detail.conversation, persona_name_snapshot: '<script>fixture</script>' } });
  assert.ok(html.includes('&lt;script&gt;fixture&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.equal(memoryMessageHref('room/a', 'id?b#c'), '/chat/room%2Fa?jump=id%3Fb%23c');
});
