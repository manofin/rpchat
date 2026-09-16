/** npx tsx bench/leakChoicesUi.test.ts
 * leak-choices-ui — P0: stop BeatUi JSON / <choices> echo into 1:1 bubbles.
 * LIVE_NO_TOUCH. No hermes / no live DB sanitize.
 *
 * (b) audit: write path is addBlock('ui', JSON.stringify(plan.ui)) only —
 * no evidence of concat into non-ui content (see chat.ts uiRow).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  extractChoices,
  stripTrailingBeatUiJson,
  isBeatUiShape,
} from '../apps/server/src/prompt/templates.ts';
import {
  isEchoFuelMessage,
  partyContextFromHistory,
} from '../apps/server/src/prompt/builder.ts';
import { sanitizeBubbleContent } from '../apps/web/src/lib/sanitizeBubble.ts';

const FIXTURE_UI = {
  location_badge: '보관소 안쪽',
  user_sheet: { hp: 12, money: 300, gear: [] as string[], inventory: [] as string[], traits: [] as string[] },
  roster: [
    { id: 'char-1', name: '서리', chip: '🙂', locked: false, in_room: true },
    { id: 'char-2', name: '카이', chip: '😐', locked: false, in_room: false },
  ],
  intent_hint: '편지를 꺼낸다',
  focus_id: 'char-1',
};

const FIXTURE_CONTENT =
  '빗소리가 처마를 스쳤다. 서리가 만년필을 내려놓았다.\n\n' +
  '<choices>["*편지를 집어들며* 이건 누구에게 온 거죠?","*한 발 물러서며* 오늘은 이만 가볼게요.","*창밖을 보다가* 비가 그치면 같이 나가요."]</choices>\n' +
  JSON.stringify(FIXTURE_UI);

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

function main() {
  t('(b) audit: ui write is stringify(plan.ui) on ui block only — no concat patch', () => {
    const chat = fs.readFileSync('apps/server/src/routes/chat.ts', 'utf8');
    assert.match(chat, /addBlock\('ui',\s*JSON\.stringify\(plan\.ui\)/);
    // No concat of plan.ui into narration/line content in chat.ts
    assert.equal(/content\s*\+\s*JSON\.stringify\(plan\.ui\)/.test(chat), false);
    assert.equal(/JSON\.stringify\(plan\.ui\)\s*\+/.test(chat), false);
  });

  t('extractChoices: trailing BeatUi JSON — choices chips + body clean', () => {
    const r = extractChoices(FIXTURE_CONTENT);
    assert.deepEqual(r.choices?.length, 3);
    assert.match(r.content, /빗소리/);
    assert.doesNotMatch(r.content, /<choices>/i);
    assert.doesNotMatch(r.content, /location_badge/);
    assert.doesNotMatch(r.content, /user_sheet/);
  });

  t('extractChoices: broken choices JSON still strips tag + trailing BeatUi', () => {
    const raw =
      '본문만 남긴다.\n<choices>[not-valid]</choices>\n' + JSON.stringify(FIXTURE_UI);
    const r = extractChoices(raw);
    assert.equal(r.choices, null);
    assert.equal(r.content, '본문만 남긴다.');
  });

  t('extractChoices: mid-body choices-like text not terminal → untouched', () => {
    const raw = '그는 <choices>["가"]</choices> 라고 중얼했고 이야기는 계속된다.';
    const r = extractChoices(raw);
    assert.equal(r.choices, null);
    assert.equal(r.content, raw);
  });

  t('stripTrailingBeatUiJson / isBeatUiShape', () => {
    assert.equal(isBeatUiShape(FIXTURE_UI), true);
    assert.equal(isBeatUiShape({ foo: 1 }), false);
    const withUi = `서사\n${JSON.stringify(FIXTURE_UI)}`;
    assert.equal(stripTrailingBeatUiJson(withUi), '서사');
  });

  t('builder: ui/header/thought are echo fuel; line/narration are not', () => {
    assert.equal(isEchoFuelMessage({ meta_json: JSON.stringify({ block_kind: 'ui' }) }), true);
    assert.equal(isEchoFuelMessage({ meta_json: JSON.stringify({ block_kind: 'header' }) }), true);
    assert.equal(isEchoFuelMessage({ meta_json: JSON.stringify({ block_kind: 'thought' }) }), true);
    assert.equal(isEchoFuelMessage({ meta_json: JSON.stringify({ block_kind: 'line' }) }), false);
    assert.equal(isEchoFuelMessage({ meta_json: JSON.stringify({ block_kind: 'narration' }) }), false);
    assert.equal(isEchoFuelMessage({ meta_json: '{}' }), false);
  });

  t('builder: partyContextFromHistory preserves roster/place without raw JSON', () => {
    const ctx = partyContextFromHistory([
      { meta_json: JSON.stringify({ block_kind: 'narration' }), content: '서사' },
      { meta_json: JSON.stringify({ block_kind: 'ui' }), content: JSON.stringify(FIXTURE_UI) },
    ]);
    assert.ok(ctx);
    assert.match(ctx!, /현재 장면·파티/);
    assert.match(ctx!, /보관소/);
    assert.match(ctx!, /서리/);
    assert.match(ctx!, /카이/);
    assert.doesNotMatch(ctx!, /location_badge/);
    assert.doesNotMatch(ctx!, /"roster"/);
  });

  t('builder source: recent loop skips echo fuel; partyCtx in systemParts', () => {
    const src = fs.readFileSync('apps/server/src/prompt/builder.ts', 'utf8');
    assert.match(src, /if \(isEchoFuelMessage\(m\)\) continue;/);
    assert.match(src, /partyContextFromHistory\(history\)/);
    assert.match(src, /partyCtx/);
  });

  t('client sanitizeBubbleContent: same fixture cleaned; mid-body left alone', () => {
    const cleaned = sanitizeBubbleContent(FIXTURE_CONTENT);
    assert.match(cleaned, /빗소리/);
    assert.doesNotMatch(cleaned, /<choices>/i);
    assert.doesNotMatch(cleaned, /location_badge/);
    const mid = '그는 <choices>["가"]</choices> 라고 했고 끝.';
    assert.equal(sanitizeBubbleContent(mid), mid);
  });

  t('client: MessageView uses sanitize; ui block_kind path untouched', () => {
    const page = fs.readFileSync('apps/web/src/pages/ChatPage.tsx', 'utf8');
    assert.match(page, /sanitizeBubbleContent/);
    assert.match(page, /block_kind === 'ui'|kind === 'ui'|parseBeatUi/);
    // ui branch still uses BeatUiPanel
    assert.match(page, /BeatUiPanel/);
  });

  console.log(`\n${passed} passed`);
}

main();
