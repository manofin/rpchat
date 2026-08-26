/** npx tsx bench/conversationUserNotePage.test.ts
 * Gate 4 conversation-user-note-ui — static markup + pure helpers.
 * No live HTTP / QA PATCH / prompt-preview / generation.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { resolveSettingsRoute } from '../apps/web/src/lib/conversationSettings.ts';
import type { Conversation } from '../apps/web/src/types.ts';

const require2 = createRequire(import.meta.url);
let page: typeof import('../apps/web/src/pages/ConversationUserNotePage.tsx');
try {
  page = require2('../apps/web/src/pages/ConversationUserNotePage.tsx');
} catch (e) {
  console.error('RED: ConversationUserNotePage missing —', (e as Error).message.split('\n')[0]);
  process.exit(1);
}

const {
  USER_NOTE_MAX_CHARS,
  loadedUserNote,
  formatUserNoteCount,
  buildUserNotePatch,
  userNoteSaveDisabled,
  UserNoteView,
} = page;

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const ROOT = path.resolve('apps/web/src');
const settingsPage = fs.readFileSync(path.join(ROOT, 'pages/ConversationSettingsPage.tsx'), 'utf8');
const noteSrc = fs.readFileSync(path.join(ROOT, 'pages/ConversationUserNotePage.tsx'), 'utf8');
const hubSrc = fs.readFileSync(path.join(ROOT, 'components/settings.tsx'), 'utf8');
const chat = fs.readFileSync(path.join(ROOT, 'pages/ChatPage.tsx'), 'utf8');

function fixtureConversation(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c-qa',
    character_id: 'ch1',
    persona_id: null,
    title: 'qa-note',
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
    user_note: null,
    persona_name_snapshot: null,
    persona_address_snapshot: null,
    persona_appearance_snapshot: null,
    persona_personality_snapshot: null,
    persona_relationship_snapshot: null,
    persona_applied_at: null,
    ...over,
  };
}

function viewHtml(over: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    createElement(UserNoteView, {
      conversationId: 'c-qa',
      draft: '',
      pending: false,
      conversationError: false,
      statusMessage: null,
      onBack: () => undefined,
      onDraftChange: () => undefined,
      onSave: () => undefined,
      onRetry: () => undefined,
      ...over,
    }),
  );
}

t('UN-01 user-note href already exists; hub page does not PATCH', () => {
  const route = resolveSettingsRoute('/chat/c-qa/settings/user-note');
  assert.deepEqual(route, { kind: 'leaf', conversationId: 'c-qa', leaf: 'user-note' });
  assert.match(settingsPage, /ConversationUserNotePage/);
  assert.match(settingsPage, /route\.leaf === 'user-note'/);
  assert.doesNotMatch(settingsPage, /\bpatch\(/);
  assert.doesNotMatch(settingsPage, /userNote/);
  assert.doesNotMatch(hubSrc, /\bpatch\(/);
});

t('UN-02 cap constant is server 4000 only — no 500/2000 UX policy', () => {
  assert.equal(USER_NOTE_MAX_CHARS, 4000);
  assert.doesNotMatch(noteSrc, /500|2,?000/);
  assert.doesNotMatch(noteSrc, /userContextBudget|토큰 예산/);
});

t('UN-03 load maps null/missing note to empty draft without truncating a long note', () => {
  assert.equal(loadedUserNote(fixtureConversation({ user_note: null })), '');
  assert.equal(loadedUserNote(fixtureConversation({ user_note: undefined })), '');
  const long = '가'.repeat(4000);
  assert.equal(loadedUserNote(fixtureConversation({ user_note: long })), long);
});

t('UN-04 empty draft omits PATCH; non-empty within cap is { userNote } only', () => {
  assert.equal(buildUserNotePatch(''), null);
  assert.deepEqual(buildUserNotePatch('hello'), { userNote: 'hello' });
  assert.deepEqual(buildUserNotePatch('x'.repeat(4000)), { userNote: 'x'.repeat(4000) });
  const over = buildUserNotePatch('x'.repeat(4001));
  assert.equal(over, null);
  const body = buildUserNotePatch('note');
  assert.deepEqual(Object.keys(body ?? {}), ['userNote']);
});

t('UN-05 empty or over-cap disables save; pending also disables', () => {
  assert.equal(userNoteSaveDisabled('', false), true);
  assert.equal(userNoteSaveDisabled('ok', false), false);
  assert.equal(userNoteSaveDisabled('ok', true), true);
  assert.equal(userNoteSaveDisabled('x'.repeat(4001), false), true);
});

t('UN-06 view shows 4000 counter, explicit save, loaded draft; no CLEAR', () => {
  const empty = viewHtml();
  assert.match(empty, /유저노트/);
  assert.match(empty, /0 \/ 4000/);
  assert.match(empty, /저장/);
  assert.match(empty, /<textarea/);
  assert.doesNotMatch(empty, /노트 지우기|적용 해제|CLEAR|userNote":null|userNote:\s*null/);

  const filled = viewHtml({ draft: '기존노트' });
  assert.match(filled, /기존노트/);
  assert.match(filled, /4 \/ 4000/);

  const joined = empty + filled + noteSrc;
  assert.doesNotMatch(joined, /userNote:\s*null|userNote:\s*undefined/);
  assert.doesNotMatch(noteSrc, /userNote:\s*null/);
});

t('UN-07 ChatPage still has no user_note editor', () => {
  assert.doesNotMatch(chat, /user_note|userNote/);
});

console.log(`passed ${passed}`);
