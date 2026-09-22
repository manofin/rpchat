/** npx tsx bench/oocFuelStrip.test.ts
 * ooc-fuel-strip — (가) HARD_RULES OOC fuel out; (C) assistant leading (OOC strip.
 * LIVE_NO_TOUCH. Extends leak sanitize layer (no parallel strip module).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  OOC_INSTRUCTION,
  renderRules,
  stripLeadingOocFuel,
  sanitizeAssistantContent,
  extractChoices,
} from '../apps/server/src/prompt/templates.ts';
import { isOocMessage } from '../apps/server/src/prompt/builder.ts';
import { sanitizeBubbleContent } from './legacy/sanitizeBubble.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

function main() {
  t('(가) HARD_RULES keeps AI ban; drops OOC literal + always-on writer clause', () => {
    const src = fs.readFileSync('apps/server/src/prompt/templates.ts', 'utf8');
    const rules = renderRules('', '카이', '지명');
    assert.match(rules, /시스템을 언급하지 않는다/);
    assert.doesNotMatch(rules, /작가로서 짧게 답한다/);
    assert.doesNotMatch(rules, /\(OOC\)"로 시작하는/);
    // Source: HARD_RULES entry is AI-only
    assert.match(src, /'AI·모델·프롬프트·시스템을 언급하지 않는다\.',/);
    assert.doesNotMatch(src, /HARD_RULES[\s\S]*작가로서 짧게 답한다/);
  });

  t('(가) isOocMessage + OOC_INSTRUCTION retained; no new negative', () => {
    assert.equal(isOocMessage({ role: 'user', content: '(OOC) 설정?' } as any), true);
    assert.equal(isOocMessage({ role: 'user', content: '안녕' } as any), false);
    assert.match(OOC_INSTRUCTION, /서사 본문을 쓰지 않는다/);
    assert.match(OOC_INSTRUCTION, /작가\/진행자로서/);
    const builder = fs.readFileSync('apps/server/src/prompt/builder.ts', 'utf8');
    assert.match(builder, /if \(isOoc\) systemParts\.push\(OOC_INSTRUCTION\)/);
    // No new "never write OOC" negative in HARD_RULES / templates export for rules
    const rules = renderRules('', 'A', 'B');
    assert.doesNotMatch(rules, /OOC를 쓰지 말/);
    assert.doesNotMatch(rules, /절대 \(OOC\)/);
  });

  t('(C) Easton: blank-line delimiter strips OOC block, keeps body', () => {
    const raw = '(OOC) 작가 메모: 비가 온다.\n\n서리가 만년필을 내려놓았다.';
    assert.equal(stripLeadingOocFuel(raw), '서리가 만년필을 내려놓았다.');
    assert.equal(sanitizeBubbleContent(raw), '서리가 만년필을 내려놓았다.');
  });

  t('(C) Easton: *** delimiter strips OOC block', () => {
    const raw = '(OOC: 설정 확인)\n***\n본문이 이어진다.';
    assert.equal(stripLeadingOocFuel(raw), '본문이 이어진다.');
    assert.equal(sanitizeAssistantContent(raw), '본문이 이어진다.');
  });

  t('(C) Easton: leading whitespace before (OOC:', () => {
    const raw = '  (OOC: note)\n\n장면 시작.';
    assert.equal(stripLeadingOocFuel(raw), '장면 시작.');
  });

  t('(C) Easton: stage direction (웃으며 — not OOC keyword → unchanged', () => {
    const raw = '(웃으며) 문을 열었다.';
    assert.equal(stripLeadingOocFuel(raw), raw);
    assert.equal(sanitizeBubbleContent(raw), raw);
  });

  t('(C) Easton: (그는 stage paren unchanged', () => {
    const raw = '(그는 창밖을 보았다.) 빗소리가 났다.';
    assert.equal(stripLeadingOocFuel(raw), raw);
  });

  t('(C) mid-body (OOC) untouched', () => {
    const raw = '서사 중간 (OOC) 언급은 남긴다.';
    assert.equal(stripLeadingOocFuel(raw), raw);
  });

  t('(C) chat persist uses sanitizeAssistantContent; archived client comparison chains OOC', () => {
    const chat = fs.readFileSync('apps/server/src/routes/chat.ts', 'utf8');
    assert.match(chat, /sanitizeAssistantContent\(parsed\.content\)/);
    const bub = fs.readFileSync('bench/legacy/sanitizeBubble.ts', 'utf8');
    assert.match(bub, /stripLeadingOocFuel/);
  });

  t('compose: extractChoices + leading OOC still yields clean body', () => {
    const ui = JSON.stringify({
      location_badge: 'x',
      roster: [],
      focus_id: null,
      intent_hint: null,
      user_sheet: null,
    });
    const raw =
      '(OOC) leak fuel\n\n서사.\n<choices>["a","b","c"]</choices>\n' + ui;
    const parsed = extractChoices(raw);
    const out = sanitizeAssistantContent(parsed.content);
    assert.deepEqual(parsed.choices?.length, 3);
    assert.equal(out, '서사.');
    assert.doesNotMatch(out, /\(OOC/i);
    assert.doesNotMatch(out, /location_badge/);
  });

  console.log(`\n${passed} passed`);
}

main();
