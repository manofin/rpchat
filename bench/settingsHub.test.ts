/** npx tsx bench/settingsHub.test.ts
 * Gate 2 — hub catalog from existing conversation detail only.
 */
import assert from 'node:assert/strict';
import {
  buildHubItems,
  isRowNavigable,
  outputProfileLabel,
  sceneImageTogglePolicy,
  settingsBackFallback,
  summarizeConversationDetail,
} from '../apps/web/src/lib/conversationSettings.ts';
import type { Character, Conversation, ConversationDetail, Persona } from '../apps/web/src/types.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const conv: Conversation = {
  id: 'c1',
  character_id: 'ch1',
  persona_id: 'p1',
  title: '긴대화방이름테스트용제목입니다정말로깁니다',
  mode: 'chat',
  profile_name: 'rp-balanced',
  scene: { place: '항구', time: '밤' },
  head_message_id: null,
  prompt_version: 'pv-test',
  favorite: false,
  archived: false,
  created_at: '',
  updated_at: '',
  last_message_at: null,
  user_note: 'x'.repeat(326),
};

const character: Character = {
  id: 'ch1',
  name: '서리',
  tagline: '',
  avatar: '/a.png',
  description: '',
  personality: '',
  speech_style: '',
  scenario: '시작 장면 제목',
  first_message: '',
  example_dialogue: '',
  taboos: '',
  tags: [],
  archived: false,
  created_at: '',
  updated_at: '',
};

const persona: Persona = {
  id: 'p1',
  name: '나',
  address_as: '',
  appearance: '',
  personality: '',
  relationship: '',
  is_default: true,
};

const detail: ConversationDetail = {
  conversation: { ...conv, persona_applied_at: '2026-08-25T00:00:00Z' } as Conversation,
  character,
  persona,
  messages: [],
  activeGeneration: null,
};

t('output label maps rp-balanced to 균형 without a new API', () => {
  assert.equal(outputProfileLabel('rp-balanced'), '균형');
  assert.equal(outputProfileLabel('rp-creative'), '창의');
});

t('summary uses existing detail fields only', () => {
  const s = summarizeConversationDetail(detail, '0.1.0');
  assert.equal(s.conversationId, 'c1');
  assert.equal(s.title, conv.title);
  assert.equal(s.subtitle, '서리');
  assert.equal(s.avatar, '/a.png');
  assert.equal(s.profile.label, '나');
  assert.equal(s.profile.hasSnapshot, true);
  assert.equal(s.userNote.configured, true);
  assert.equal(s.userNote.length, 326);
  assert.deepEqual(s.output, { profileName: 'rp-balanced', label: '균형' });
  assert.equal(s.startTitle, '항구 · 밤');
  assert.equal(s.appVersion, '0.1.0');
});

t('hub items hide currency and keep scene-image as disabled toggle', () => {
  const items = buildHubItems(summarizeConversationDetail(detail, '0.1.0'));
  assert.equal(items.find((i) => i.id === 'currency'), undefined);
  const scene = items.find((i) => i.id === 'scene-image');
  assert.ok(scene);
  assert.equal(scene!.state, 'disabled');
  assert.equal(scene!.control, 'toggle');
  assert.equal(isRowNavigable(scene!), false);
});

t('start and about are read-only; room rows are route-shells', () => {
  const items = buildHubItems(summarizeConversationDetail(detail, '0.1.0'));
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(byId.guide.state, 'available');
  assert.equal(byId.profile.state, 'available');
  assert.equal(byId['user-note'].state, 'available');
  assert.equal(byId.output.state, 'available');
  assert.equal(byId.memory.state, 'available');
  assert.equal(byId.style.state, 'available');
  assert.equal(byId.start.state, 'read-only');
  assert.equal(byId.about.state, 'read-only');
  assert.equal(byId.about.value, '0.1.0');
  assert.equal(isRowNavigable(byId.start), false);
  assert.equal(isRowNavigable(byId.guide), true);
  assert.equal(byId.guide.href, '/chat/c1/settings/guide');
});

t('scene image toggle must not persist in Gate 2', () => {
  const policy = sceneImageTogglePolicy();
  assert.equal(policy.persist, false);
  assert.deepEqual(policy.allowedMethods, []);
});

t('back fallback: hub → chat, leaf → hub; does not change global back()', () => {
  assert.equal(settingsBackFallback('c1', 'hub'), '/chat/c1');
  assert.equal(settingsBackFallback('c1', 'leaf'), '/chat/c1/settings');
});

console.log(`passed ${passed}`);
