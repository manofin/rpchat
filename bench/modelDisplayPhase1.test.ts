/**
 * Model display phase 1 — labels and guidance only. No picker, no default_model write.
 * Run: node --import tsx bench/modelDisplayPhase1.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shortModelLabel } from '../apps/web/src/pages/HomePage.tsx';
import {
  SINGLE_ENDPOINT_GUIDANCE,
  chatModelSubtitle,
  partyCertainty,
  profileModelAsymmetry,
  settingsModelLines,
} from '../apps/web/src/lib/modelDisplay.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

const GUIDANCE = '다른 모델을 사용하려면 별도 엔드포인트 설정 또는 서버 재기동이 필요합니다.';
const PATH_ID = '/Users/llm/models/Gemma-4-Dark-Thoughts-V2-31B-Q4.gguf';
const label = shortModelLabel(PATH_ID);

const soloReady = {
  resolvedModel: PATH_ID,
  resolvedKnown: true,
  profileName: 'rp-balanced',
  profileModel: null as string | null,
  profileModelState: 'ready' as const,
  party: 'solo' as const,
};

assert.equal(SINGLE_ENDPOINT_GUIDANCE, GUIDANCE);
assert.equal(label.includes('/'), false);
assert.equal(label.includes('\\'), false);
assert.equal(label.endsWith('.gguf'), false);

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

t('single-endpoint guidance is the exact Korean sentence', () => {
  assert.equal(SINGLE_ENDPOINT_GUIDANCE, GUIDANCE);
});

t('short labels drop paths and the gguf suffix', () => {
  assert.equal(label.includes('/'), false);
  assert.equal(label.includes('\\'), false);
  assert.equal(label.endsWith('.gguf'), false);
});

t('one listed model shows the guidance and no raw path', () => {
  const one = settingsModelLines({ resolvedModel: PATH_ID, models: [PATH_ID] });
  assert.equal(one.current, label);
  assert.equal(one.list, label);
  assert.equal(one.guidance, GUIDANCE);
  assert.equal(one.current.includes(PATH_ID), false);
});

t('empty or multi model lists do not show the single-endpoint guidance', () => {
  const none = settingsModelLines({ resolvedModel: null, models: [] });
  assert.equal(none.guidance, null);
  assert.equal(none.list, '');
  const two = settingsModelLines({ resolvedModel: PATH_ID, models: [PATH_ID, 'other-model'] });
  assert.equal(two.guidance, null);
  assert.equal(two.list.includes('/'), false);
});

t('party certainty follows the snapshot length gate', () => {
  assert.equal(partyCertainty({ story_id: null, story_participant_ids_snapshot: null }), 'solo');
  assert.equal(partyCertainty({ story_id: 's', story_participant_ids_snapshot: JSON.stringify(['a']) }), 'solo');
  assert.equal(partyCertainty({ story_id: 's', story_participant_ids_snapshot: JSON.stringify(['a', 'b']) }), 'party');
  assert.equal(partyCertainty({ story_id: 's', story_participant_ids_snapshot: null }), 'unknown');
  assert.equal(partyCertainty({ story_id: 's', story_participant_ids_snapshot: 'not-json' }), 'unknown');
});

t('profile.model asymmetry is a non-empty id that differs from resolvedModel', () => {
  assert.equal(profileModelAsymmetry(null, PATH_ID), false);
  assert.equal(profileModelAsymmetry('  ', PATH_ID), false);
  assert.equal(profileModelAsymmetry(PATH_ID, PATH_ID), false);
  assert.equal(profileModelAsymmetry('other-model', PATH_ID), true);
});

t('chat subtitle names the model only when the effective id is confirmed', () => {
  assert.equal(chatModelSubtitle(soloReady), `모델: ${label} · 출력/톤: 균형`);
  assert.equal(chatModelSubtitle({ ...soloReady, profileName: 'rp-creative' }), `모델: ${label} · 출력/톤: 창의`);
  assert.equal(chatModelSubtitle({ ...soloReady, party: 'party' }), `서버 기본 모델: ${label} · 출력/톤: 균형`);
  assert.equal(chatModelSubtitle({ ...soloReady, party: 'unknown' }), `서버 기본 모델: ${label} · 출력/톤: 균형`);
  assert.equal(chatModelSubtitle({ ...soloReady, profileModel: 'other-model' }), `서버 기본 모델: ${label} · 출력/톤: 균형`);
  assert.equal(chatModelSubtitle({ ...soloReady, profileModelState: 'failed' }), `서버 기본 모델: ${label} · 출력/톤: 균형`);
  assert.equal(chatModelSubtitle({ ...soloReady, resolvedKnown: false, profileModelState: 'pending' }), '모델: … · 출력/톤: 균형');
  assert.equal(
    chatModelSubtitle({ ...soloReady, profileModelState: 'pending' }),
    '모델: … · 출력/톤: 균형',
  );
});

t('Settings status card has no picker and does not render the raw path', () => {
  const settings = read('apps/web/src/pages/SettingsPage.tsx');
  const statusStart = settings.indexOf('export function SettingsModelStatus');
  const statusEnd = settings.indexOf('function ThemeSection');
  assert.ok(statusStart > 0 && statusEnd > statusStart);
  const statusBlock = settings.slice(statusStart, statusEnd);
  assert.equal(statusBlock.includes('<select'), false);
  assert.equal(statusBlock.includes('settingsModelLines'), true);
  assert.equal(statusBlock.includes('data-test="settings-model-guidance"'), true);
  assert.equal(statusBlock.includes('view.guidance'), true);
  assert.equal(statusBlock.includes('resolvedModel ||'), false);
  assert.equal(settings.includes('default_model'), false);
  assert.equal(settings.includes('setResolvedModel'), false);
  assert.equal(settings.includes('/api/settings/default_model'), false);
});

t('chat subtitle is the helper output; the sheet stays an output control', () => {
  const chat = read('apps/web/src/pages/ChatPage.tsx');
  assert.match(chat, /const modelSubtitle = chatModelSubtitle\(/);
  assert.match(chat, /data-test="chat-model-subtitle"[\s\S]{0,120}\{modelSubtitle\}/);
  assert.match(chat, /<label>출력\/톤<\/label>/);
  assert.match(chat, /select value=\{conv\.profile_name\}/);
  assert.equal(chat.includes('다른 모델을 사용하려면'), false);
  assert.equal(chat.includes('default_model'), false);
  assert.equal(chat.includes('setResolvedModel'), false);
  assert.equal(chat.includes('/api/settings/default_model'), false);
});

t('Home short health label is unchanged', () => {
  const home = read('apps/web/src/pages/HomePage.tsx');
  assert.match(home, /function modelLine\(h: Health \| null\): string \{/);
  assert.match(home, /return `\$\{shortModelLabel\(h\.model\.resolvedModel\)\} · \$\{k\}K`;/);
  assert.equal(home.includes('서버 기본 모델'), false);
  assert.equal(home.includes(GUIDANCE), false);
  assert.match(home, /function shortModelLabel/);
});

t('chat subtitle may wrap; other topbar subs stay one line', () => {
  const css = read('apps/web/src/app.css');
  assert.match(css, /\.topbar \.title \.sub\.chat-model-sub \{ white-space: normal;/);
  assert.match(css, /\.topbar \.title \.sub \{[^}]*white-space: nowrap;/);
});

t('display helper does not grow a picker or a default_model write', () => {
  const lib = read('apps/web/src/lib/modelDisplay.ts');
  assert.equal(lib.includes('<select'), false);
  assert.equal(lib.includes('default_model'), false);
  assert.equal(lib.includes('setResolvedModel'), false);
  assert.equal(lib.includes(GUIDANCE), true);
});
