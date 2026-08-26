/** npx tsx bench/conversationProfilePage.test.ts
 * Gate 3 U1/U2 — ConversationProfilePage contract bench.
 * Static markup + pure helpers only. Does not replace U6 browser QA smoke
 * (navigation · PATCH · refresh are U6 evidence).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { resolveSettingsRoute } from '../apps/web/src/lib/conversationSettings.ts';
import type { Conversation, Persona } from '../apps/web/src/types.ts';

const require2 = createRequire(import.meta.url);
let page: typeof import('../apps/web/src/pages/ConversationProfilePage.tsx');
try {
  page = require2('../apps/web/src/pages/ConversationProfilePage.tsx');
} catch (e) {
  console.error('RED: ConversationProfilePage missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

const {
  deriveAppliedSnapshot,
  profileActionFor,
  buildPersonaPatch,
  applyMutationOutcome,
  personaActionsDisabled,
  AppliedProfileCard,
  CandidateProfileList,
  ProfileEmptyState,
  ProfileView,
} = page;

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const ROOT = path.resolve('apps/web/src');
const settingsPage = fs.readFileSync(path.join(ROOT, 'pages/ConversationSettingsPage.tsx'), 'utf8');
const chat = fs.readFileSync(path.join(ROOT, 'pages/ChatPage.tsx'), 'utf8');
const typesSrc = fs.readFileSync(path.join(ROOT, 'types.ts'), 'utf8');
const profileSrc = fs.readFileSync(path.join(ROOT, 'pages/ConversationProfilePage.tsx'), 'utf8');
const serverSrc = fs.readFileSync(path.resolve('apps/server/src/routes/conversations.ts'), 'utf8');

function fixtureConversation(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c-qa',
    character_id: 'ch1',
    persona_id: 'p-snap',
    title: 'qa-profile',
    mode: 'chat',
    profile_name: 'rp-balanced',
    scene: {},
    head_message_id: null,
    prompt_version: 'pv',
    favorite: false,
    archived: true,
    created_at: '2026-08-26T00:00:00Z',
    updated_at: '2026-08-26T00:00:00Z',
    last_message_at: null,
    persona_name_snapshot: '스냅샷이름',
    persona_address_snapshot: '스냅호칭',
    persona_appearance_snapshot: '스냅외형',
    persona_personality_snapshot: '스냅성격',
    persona_relationship_snapshot: '스냅관계',
    persona_applied_at: '2026-08-26T01:00:00.000Z',
    ...over,
  };
}

const catalogCurrent: Persona = {
  id: 'p-snap',
  name: '카탈로그최신이름',
  address_as: '카탈로그호칭',
  appearance: '카탈로그외형',
  personality: '카탈로그성격',
  relationship: '카탈로그관계',
  is_default: false,
};

const catalogOther: Persona = {
  id: 'p-other',
  name: '다른후보',
  address_as: '후보호칭',
  appearance: '',
  personality: '',
  relationship: '',
  is_default: true,
};

t('UI-P-01 profile href only; hub does not open old sheet', () => {
  const route = resolveSettingsRoute('/chat/c-qa/settings/profile');
  assert.deepEqual(route, { kind: 'leaf', conversationId: 'c-qa', leaf: 'profile' });
  assert.match(settingsPage, /ConversationProfilePage/);
  assert.doesNotMatch(settingsPage, /setSettings\(true\)/);
  assert.equal((chat.match(/setSettings\(true\)/g) || []).length, 0);
  assert.match(chat, /<ConversationSettings open=\{settings\}/);
});

t('UI-P-02 current card is snapshot-only; catalog name stays off the card', () => {
  const snap = deriveAppliedSnapshot(fixtureConversation());
  assert.ok(snap);
  assert.equal(snap.name, '스냅샷이름');
  assert.equal(snap.addressAs, '스냅호칭');
  assert.equal(snap.appearance, '스냅외형');
  assert.equal(snap.personality, '스냅성격');
  assert.equal(snap.relationship, '스냅관계');
  assert.equal(snap.appliedAt, '2026-08-26T01:00:00.000Z');
  const html = renderToStaticMarkup(
    createElement(AppliedProfileCard, {
      snapshot: snap,
      pending: false,
      onReapply: () => undefined,
    }),
  );
  assert.match(html, /현재 적용 중/);
  assert.match(html, /스냅샷이름/);
  assert.match(html, /스냅호칭/);
  assert.doesNotMatch(html, /카탈로그최신이름/);
  assert.doesNotMatch(html, /카탈로그외형/);
});

t('UI-P-03 null applied_at is not a current badge, even with live/default persona', () => {
  const conv = fixtureConversation({
    persona_id: catalogOther.id,
    persona_applied_at: null,
    persona_name_snapshot: null,
    persona_address_snapshot: null,
    persona_appearance_snapshot: null,
    persona_personality_snapshot: null,
    persona_relationship_snapshot: null,
  });
  assert.equal(deriveAppliedSnapshot(conv), null);
  const html = renderToStaticMarkup(
    createElement(ProfileView, {
      conversationId: conv.id,
      conversation: conv,
      candidates: [catalogOther],
      pendingPersonaId: null,
      contractError: false,
      catalogError: false,
      conversationError: false,
      statusMessage: null,
      onBack: () => undefined,
      onApply: () => undefined,
      onReapply: () => undefined,
      onRetry: () => undefined,
    }),
  );
  assert.match(html, /적용된 대화 프로필 없음/);
  assert.doesNotMatch(html, /현재 적용 중/);
  assert.doesNotMatch(html, new RegExp(`현재 적용 중[\\s\\S]*${catalogOther.name}`));
});

t('UI-P-04 apply PATCH body is exactly { personaId: candidateId }', () => {
  const current = deriveAppliedSnapshot(fixtureConversation());
  assert.equal(profileActionFor(current, catalogOther.id), 'apply');
  assert.deepEqual(buildPersonaPatch(catalogOther.id), { personaId: catalogOther.id });
});

t('UI-P-05 same current ID is reapply and still PATCHes that id', () => {
  const current = deriveAppliedSnapshot(fixtureConversation());
  assert.ok(current);
  assert.equal(profileActionFor(current, current.id), 'reapply');
  assert.deepEqual(buildPersonaPatch(current.id), { personaId: current.id });
});

t('UI-P-06 blank id does not build a PATCH; no clear control', () => {
  assert.equal(buildPersonaPatch(''), null);
  assert.equal(buildPersonaPatch('   '), null);
  const empty = renderToStaticMarkup(createElement(ProfileEmptyState));
  const list = renderToStaticMarkup(
    createElement(CandidateProfileList, {
      candidates: [catalogOther],
      currentId: null,
      pending: false,
      disabled: false,
      onApply: () => undefined,
      onReapply: () => undefined,
    }),
  );
  const joined = empty + list + profileSrc;
  assert.doesNotMatch(joined, /프로필 해제|적용 해제|CLEAR|personaId:\s*null/);
  assert.doesNotMatch(profileSrc, /personaId:\s*null/);
});

t('UI-P-07 failed mutation keeps last authoritative conversation', () => {
  const last = fixtureConversation();
  const newer = fixtureConversation({
    persona_id: catalogOther.id,
    persona_name_snapshot: '새스냅샷',
    persona_applied_at: '2026-08-26T02:00:00.000Z',
  });
  for (const outcome of [
    { kind: 'http' as const, status: 400 as const },
    { kind: 'http' as const, status: 404 as const },
    { kind: 'network' as const },
    { kind: 'refetch-fail' as const },
  ]) {
    const next = applyMutationOutcome(last, outcome);
    assert.equal(next.conversation, last);
    assert.notEqual(next.conversation.persona_name_snapshot, newer.persona_name_snapshot);
  }
  const ok = applyMutationOutcome(last, { kind: 'ok', conversation: newer });
  assert.equal(ok.conversation, newer);
});

t('UI-P-08 pending disables every persona action', () => {
  assert.equal(personaActionsDisabled(null), false);
  assert.equal(personaActionsDisabled('p-other'), true);
  const html = renderToStaticMarkup(
    createElement(ProfileView, {
      conversationId: 'c-qa',
      conversation: fixtureConversation(),
      candidates: [catalogCurrent, catalogOther],
      pendingPersonaId: 'p-other',
      contractError: false,
      catalogError: false,
      conversationError: false,
      statusMessage: null,
      onBack: () => undefined,
      onApply: () => undefined,
      onReapply: () => undefined,
      onRetry: () => undefined,
    }),
  );
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /적용 중/);
  assert.doesNotMatch(html, /<button(?![^>]*disabled)[^>]*>[^<]*(이 대화에 적용|최신 값 다시 적용)/);
});

t('UI-P-09 scope inventory: no user_note / profiles API / server edit / old-sheet delete', () => {
  assert.match(typesSrc, /persona_name_snapshot:\s*string\s*\|\s*null;/);
  assert.match(typesSrc, /persona_address_snapshot:\s*string\s*\|\s*null;/);
  assert.match(typesSrc, /persona_appearance_snapshot:\s*string\s*\|\s*null;/);
  assert.match(typesSrc, /persona_personality_snapshot:\s*string\s*\|\s*null;/);
  assert.match(typesSrc, /persona_relationship_snapshot:\s*string\s*\|\s*null;/);
  assert.match(typesSrc, /persona_applied_at:\s*string\s*\|\s*null;/);
  assert.doesNotMatch(typesSrc, /persona_name_snapshot\?:/);
  assert.doesNotMatch(profileSrc, /userNote|user_note/);
  assert.doesNotMatch(profileSrc, /\/api\/profiles/);
  assert.doesNotMatch(profileSrc, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(profileSrc, /useChat/);
  assert.match(serverSrc, /persona_applied_at/);
  assert.match(chat, /<ConversationSettings open=\{settings\}/);
});

console.log(`passed ${passed}`);
