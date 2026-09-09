/**
 * npx tsx bench/sceneStateSheet.test.ts
 * R3 — Living world state sheet. Web + existing conversation PATCH.
 * Isolated: no systemd, no live DB, no model, no 1:1 prompt rewrite.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSceneStatePatch,
  draftFromScene,
  hasLivingState,
  livingStateLabel,
  parseSheetInt,
  SCENE_PROMPT_KEYS,
} from '../apps/web/src/lib/sceneState.ts';
import { resolveSettingsRoute } from '../apps/web/src/lib/conversationSettings.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(dir, '..');
const src = (rel: string) => fs.readFileSync(path.join(appRoot, rel), 'utf8');

t('hasLivingState is true only when user_sheet / info / hunter exist', () => {
  assert.equal(hasLivingState({}), false);
  assert.equal(hasLivingState({ user_sheet: { hp: 100 } }), true);
  assert.equal(hasLivingState({ info: { contract: '핏빛' } }), true);
  assert.equal(hasLivingState({ hunter: { quest: '입구' } }), true);
  assert.equal(livingStateLabel({}), '없음');
  assert.equal(livingStateLabel({ user_sheet: { hp: 100, money: 0 } }), 'HP 100 · ₩ 0');
});

t('patch sends nested living keys only — never 1:1 renderScene keys', () => {
  const draft = draftFromScene({
    user_sheet: { hp: 80, money: 12, gear: ['검'], inventory: ['약'], traits: [] },
    info: { contract: '핏빛 계약', status: ['검사'] },
  });
  const body = buildSceneStatePatch(draft);
  assert.ok(body);
  assert.equal(body!.scene.user_sheet?.hp, 80);
  assert.equal(body!.scene.user_sheet?.money, 12);
  assert.deepEqual(body!.scene.user_sheet?.gear, ['검']);
  assert.equal(body!.scene.info?.contract, '핏빛 계약');
  for (const k of SCENE_PROMPT_KEYS) {
    assert.equal(Object.prototype.hasOwnProperty.call(body!.scene, k), false, k);
  }
  assert.equal(JSON.stringify(body!.scene).includes('호감'), false);
});

t('invalid HP blocks the patch; empty HP becomes null', () => {
  assert.deepEqual(parseSheetInt(''), { ok: true, value: null });
  assert.deepEqual(parseSheetInt('12'), { ok: true, value: 12 });
  assert.equal(parseSheetInt('1.5').ok, false);
  const draft = draftFromScene({ user_sheet: { hp: 1 } });
  draft.hp = 'nope';
  assert.equal(buildSceneStatePatch(draft), null);
  draft.hp = '';
  const cleared = buildSceneStatePatch(draft);
  assert.equal(cleared?.scene.user_sheet?.hp, null);
});

t('1:1 scene with only place/time does not grow living keys', () => {
  const draft = draftFromScene({} as never);
  assert.equal(draft.showSheet, false);
  assert.equal(draft.showInfo, false);
  assert.equal(draft.showHunter, false);
  assert.equal(buildSceneStatePatch(draft), null);
});

t('leaf route and tools/settings wire the page; PATCH goes to conversations', () => {
  assert.deepEqual(resolveSettingsRoute('/chat/c1/settings/state'), {
    kind: 'leaf', conversationId: 'c1', leaf: 'state',
  });
  const page = src('apps/web/src/pages/ConversationSceneStatePage.tsx');
  assert.match(page, /patch\(`\/api\/conversations\/\$\{conversationId\}`, body\)/);
  assert.doesNotMatch(page, /set\('place'|set\('time'|set\('goal'|set\('genre'|set\('conflict'|set\('mood'/);
  const tools = src('apps/web/src/pages/ConversationTools.tsx');
  assert.match(tools, /leaf === 'state'/);
  assert.match(tools, /id === 'state'/);
  assert.match(tools, /ConversationSceneStatePage/);
  const settings = src('apps/web/src/pages/ConversationSettingsPage.tsx');
  assert.match(settings, /route\.leaf === 'state'/);
});

t('R3 sheet does not import server prompt or change 1:1 renderScene keys', () => {
  const sheet = src('apps/web/src/lib/sceneState.ts');
  const page = src('apps/web/src/pages/ConversationSceneStatePage.tsx');
  assert.doesNotMatch(sheet, /applySceneDelta|buildPrompt|HARD_RULES|PROMPT_VERSION/);
  assert.doesNotMatch(page, /applySceneDelta|buildPrompt/);
  const templates = src('apps/server/src/prompt/templates.ts');
  assert.match(templates, /export function renderScene\(s: Scene\): string \| null \{[\s\S]*?field\('장소', s\.place\)/);
});

console.log(`\n${passed} passed`);
