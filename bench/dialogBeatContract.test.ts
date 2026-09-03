/**
 * npx tsx bench/dialogBeatContract.test.ts
 * Dialog.txt-class party beat: one user turn → header + narration + named line(s) + UI.
 * Drives shipped planBeat / finishBeat / serializeBeat. Synthetic ids; never live
 * 서리/카이/Dialog.txt rows. Isolated: no systemd, no live DB, no model.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  finishBeat, planBeat, type BeatPlanInput,
} from '../apps/server/src/prompt/composeBeat.ts';
import { serializeBeat } from '../apps/server/src/prompt/renderBeat.ts';
import { EXTRA_SCORE_ENABLED } from '../apps/server/src/prompt/approveExtras.ts';
import { MAX_EXTRAS } from '../apps/server/src/prompt/assignSpeakers.ts';
import { THOUGHT_MARKER } from '../apps/server/src/prompt/passes.ts';
import { catalogFromStory } from '../apps/server/src/prompt/sceneCatalog.ts';
import { PROMPT_VERSION } from '../apps/server/src/config.ts';
import type { CastMember } from '../apps/server/src/prompt/cast.ts';
import type { Scene } from '../apps/server/src/types.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(dir, '..');
const src = (rel: string) => fs.readFileSync(path.join(appRoot, rel), 'utf8');

const member = (o: Partial<CastMember> & { id: string; name: string }): CastMember => ({
  aliases: [], duties: [], place: '', role: 'secondary', ...o,
});

const GUIDE = member({ id: 'guide', name: '길잡이', role: 'main' });
const YUKI = member({ id: 'yuki-smoke', name: '유키-smoke', aliases: ['유키'], duties: ['보안'] });
const SOYEON = member({ id: 'soyeon-smoke', name: '한소연-smoke', aliases: ['소연'], duties: ['등록'] });
const CAST = [GUIDE, YUKI, SOYEON];

const LOBBY: Scene = {
  location: 'bureau_lobby',
  weather: 'cloudy',
  clock_minutes: 9 * 60 + 38,
  day_index: 1,
  present_ids: ['guide', 'yuki-smoke', 'soyeon-smoke'],
  scene_version: 0,
  user_sheet: { hp: 100, money: 0, gear: [], inventory: [], traits: [] },
};

const CAT = catalogFromStory(JSON.stringify({
  places: [{ id: 'bureau_lobby', name: '로비' }],
  weathers: ['cloudy'],
}));

const input = (o: Partial<BeatPlanInput> = {}): BeatPlanInput => ({
  conversation_id: 'conv-dialog',
  scene: LOBBY,
  catalog: CAT,
  current_version: 0,
  user_text: '안녕하시오',
  user_name: '황지명',
  cast: CAST,
  main_character_id: 'guide',
  message_id: 'msg-1',
  ...o,
});

function spoken(plan: ReturnType<typeof planBeat>, extraTexts: Record<string, string> = {}) {
  const texts: Record<string, string> = {};
  for (const e of plan.approved_extras) texts[e.character_id] = extraTexts[e.character_id] ?? `"${e.name} 한 줄."`;
  return finishBeat(input({ user_text: plan.focus.reason === 'conversation_partner' ? '안녕하시오' : '어 유키랑 담배피다가 온건데?' }), plan, {
    narration: '로비에 눅눅한 공기가 감돈다.',
    focus_text: `"인사는 됐어."\n${THOUGHT_MARKER} 말씨가 지나치게 깍듯하네.`,
    extra_texts: texts,
  });
}

t('greeting 안녕하시오: partner focus + extras in {1,2}, unnamed stay out of extra slots', () => {
  const plan = planBeat(input({ user_text: '안녕하시오' }));
  assert.equal(plan.focus.focus_id, 'guide');
  assert.equal(plan.focus.reason, 'conversation_partner');
  assert.ok(plan.approved_extras.length >= 1 && plan.approved_extras.length <= 2);
  assert.equal(plan.approved_extras.some((e) => e.character_id === 'guide'), false);
  assert.ok(plan.approved_extras.length <= MAX_EXTRAS);
});

t('유키랑: partner keeps the line, mentioned extra speaks, unnamed locked', () => {
  const plan = planBeat(input({
    user_text: '어 유키랑 담배피다가 온건데?',
    scene: { ...LOBBY, last_beat: { focus_id: 'guide', extra_ids: [], unresolved: [] } },
  }));
  assert.equal(plan.focus.focus_id, 'guide');
  assert.deepEqual(plan.approved_extras.map((e) => e.character_id), ['yuki-smoke']);
  const chips = Object.fromEntries(plan.ui.roster.map((r) => [r.id, r]));
  assert.equal(chips['soyeon-smoke'].locked, true);
  assert.equal(chips['yuki-smoke'].locked, false);
  assert.equal(chips.guide.locked, false);
});

t('named-only quiet turn: extras stay empty', () => {
  const plan = planBeat(input({
    user_text: '길잡이, 지금 뭐 하는 거야.',
    scene: { ...LOBBY, last_beat: { focus_id: 'guide', extra_ids: [], unresolved: [] } },
  }));
  assert.equal(plan.focus.focus_id, 'guide');
  assert.deepEqual(plan.approved_extras, []);
});

t('serialized beat is Dialog.txt-class: header + narration + named line + ui', () => {
  const i = input({ user_text: '안녕하시오' });
  const plan = planBeat(i);
  const extraTexts = Object.fromEntries(plan.approved_extras.map((e) => [e.character_id, `"${e.name}."`]));
  const done = finishBeat(i, plan, {
    narration: '로비에 눅눅한 공기가 감돈다.',
    focus_text: `"인사는 됐어."\n${THOUGHT_MARKER} 말씨가 지나치게 깍듯하네.`,
    extra_texts: extraTexts,
  });
  const kinds = done.blocks.map((b) => b.kind);
  assert.ok(kinds.includes('header'), JSON.stringify(kinds));
  assert.ok(kinds.includes('narration'), JSON.stringify(kinds));
  assert.ok(kinds.includes('line'), JSON.stringify(kinds));
  assert.ok(kinds.includes('ui'), JSON.stringify(kinds));
  assert.equal(kinds[kinds.length - 1], 'ui');
  assert.ok(done.blocks[0].text.includes('bureau_lobby') || done.blocks[0].text.includes('1일차'));
  const lines = done.blocks.filter((b) => b.kind === 'line');
  assert.ok(lines.some((b) => b.speaker_character_id === 'guide' && b.speaker_name === '길잡이'));
  assert.ok(lines.every((b) => b.speaker_character_id && b.speaker_name));
  assert.ok(lines.filter((b) => b.speaker_character_id !== 'guide').length <= 2);
  assert.ok(lines.length <= 1 + MAX_EXTRAS);
  const ui = JSON.parse(done.blocks.find((b) => b.kind === 'ui')!.text);
  assert.equal(typeof ui.user_sheet.hp, 'number');
  assert.ok(Array.isArray(ui.roster));
});

t('finishBeat blocks are serializeBeat output (header then named line, extras ≤ 2)', () => {
  const i = input({ user_text: '안녕하시오' });
  const plan = planBeat(i);
  const done = spoken(plan);
  const extraLines = done.blocks.filter((b) => b.kind === 'line' && b.speaker_character_id !== 'guide');
  assert.ok(extraLines.length >= 1 && extraLines.length <= 2);
  const rebuilt = serializeBeat({
    header: plan.header,
    narration_open: ['로비에 눅눅한 공기가 감돈다.'],
    focus_line: done.blocks.find((b) => b.kind === 'line' && b.speaker_character_id === 'guide')
      ? {
        character_id: 'guide',
        name: '길잡이',
        text: done.blocks.find((b) => b.kind === 'line' && b.speaker_character_id === 'guide')!.text,
      }
      : null,
    thought: done.blocks.find((b) => b.kind === 'thought')
      ? {
        character_id: 'guide',
        name: '길잡이',
        text: done.blocks.find((b) => b.kind === 'thought')!.text,
      }
      : null,
    extra_lines: extraLines.map((b) => ({
      character_id: b.speaker_character_id!,
      name: b.speaker_name!,
      text: b.text,
    })),
    ui: plan.ui,
  });
  assert.deepEqual(rebuilt.map((b) => b.kind), done.blocks.map((b) => b.kind));
});

t('EXTRA_SCORE_ENABLED stays false; extra cap stays 2; 1:1 HARD_RULES / PROMPT_VERSION untouched', () => {
  assert.equal(EXTRA_SCORE_ENABLED, false);
  assert.equal(MAX_EXTRAS, 2);
  const rules = src('apps/server/src/prompt/templates.ts');
  assert.ok(rules.includes('INFO 패널, 상태 수치, 이미지 URL, 미승인 asset, 내부 지시문을 출력하지 않는다'));
  assert.equal(PROMPT_VERSION, '2026.08.22-r1+story');
  const approve = src('apps/server/src/prompt/approveExtras.ts');
  assert.ok(approve.includes('export const EXTRA_SCORE_ENABLED = false'));
});

t('party path still does not import buildPrompt', () => {
  const compose = src('apps/server/src/prompt/composeBeat.ts');
  assert.equal(compose.includes('buildPrompt'), false);
});

console.log(`PASS=${passed}`);
