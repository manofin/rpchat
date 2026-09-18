/**
 * npx tsx bench/partyTurn.test.ts
 * B-2 S1 — PartyTurn mapper. Pure. No live DB, no model, no SSE, no persist.
 *
 * Ensemble cases reuse parseScript + serializeDialogBeat confirmed outputs
 * (the same blocks finishDialogBeat already returns). No new parser policy.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { partyTurnFromBlocks, type PartyBlock, type PartyTurn } from '../apps/server/src/prompt/partyTurn.ts';
import type { BeatBlock } from '../apps/server/src/prompt/renderBeat.ts';
import { serializeDialogBeat } from '../apps/server/src/prompt/renderDialog.ts';
import { parseScript, PASS_S_MAX_LINES, type SpeakerSlot } from '../apps/server/src/prompt/dialogScript.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(dir, '..');
const src = (rel: string) => fs.readFileSync(path.join(appRoot, rel), 'utf8');

const blank = {
  speaker_character_id: null as string | null,
  speaker_name: null as string | null,
  asset_path: null as string | null,
  emotion: null as string | null,
  outfit: null as string | null,
};

function blk(kind: BeatBlock['kind'], text: string, extra: Partial<BeatBlock> = {}, seq = 0): BeatBlock {
  return {
    seq,
    kind,
    ...blank,
    text,
    ...extra,
  };
}

function line(id: string, name: string, text: string, seq = 0): BeatBlock {
  return blk('line', text, { speaker_character_id: id, speaker_name: name }, seq);
}

function thought(id: string, name: string, text: string, seq = 0): BeatBlock {
  return blk('thought', text, { speaker_character_id: id, speaker_name: name }, seq);
}

const UI = { next_focus: 'nari', extras: ['sera', 'hayeon'], choices: ['A', 'B'] };

const FOCUSED: BeatBlock[] = [
  blk('header', '[T-1] 교실 · 오전', {}, 0),
  blk('narration', '창가에 먼지가 떠 있다.', {}, 1),
  line('nari', '나리', '"시비냐."', 2),
  thought('nari', '나리', '어떻게 알았지.', 3),
  line('sera', '세라', '교칙이다.', 4),
  line('hayeon', '하연', '수업 시작한다.', 5),
  blk('ui', JSON.stringify(UI), {}, 6),
];

function invert(p: PartyBlock): {
  kind: BeatBlock['kind'];
  speaker_character_id: string | null;
  speaker_name: string | null;
  text: string;
} {
  switch (p.kind) {
    case 'header':
    case 'narration':
    case 'info':
    case 'panel':
    case 'system':
      return { kind: p.kind, speaker_character_id: null, speaker_name: null, text: p.text };
    case 'dialogue':
      return { kind: 'line', speaker_character_id: p.speakerId, speaker_name: p.speakerName, text: p.text };
    case 'thought':
      return { kind: 'thought', speaker_character_id: p.speakerId, speaker_name: p.speakerName, text: p.text };
    case 'ui':
      return { kind: 'ui', speaker_character_id: null, speaker_name: null, text: JSON.stringify(p.payload) };
  }
}

function assertLossless(blocks: readonly BeatBlock[], turn: PartyTurn) {
  assert.equal(turn.blocks.length, blocks.length);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const inv = invert(turn.blocks[i]);
    assert.equal(inv.kind, b.kind, `kind @${i}`);
    assert.equal(inv.text, b.text, `text @${i}`);
    if (b.kind === 'line' || b.kind === 'thought') {
      assert.equal(inv.speaker_character_id, b.speaker_character_id, `id @${i}`);
      assert.equal(inv.speaker_name, b.speaker_name, `name @${i}`);
    }
  }
}

const ALLOWED: SpeakerSlot[] = [
  { id: 'slk', name: '설록' },
  { id: 'str', name: '낯선 여자', aliases: ['여자'] },
];

const THREE: SpeakerSlot[] = [
  ...ALLOWED,
  { id: 'th3', name: '제3자' },
];

/** finishDialogBeat blocks = serializeDialogBeat(parseScript items). */
function ensembleBlocks(script: string, allowed: SpeakerSlot[] = ALLOWED, sheet: { header: string | null; info: string | null } = { header: null, info: null }): BeatBlock[] {
  const parsed = parseScript(script, allowed);
  return serializeDialogBeat({ header: sheet.header, info: sheet.info, script: parsed.items });
}

function ensembleTurn(script: string, allowed: SpeakerSlot[] = ALLOWED, sheet?: { header: string | null; info: string | null }): { blocks: BeatBlock[]; turn: PartyTurn } {
  const blocks = ensembleBlocks(script, allowed, sheet ?? { header: null, info: null });
  return { blocks, turn: partyTurnFromBlocks('ensemble', blocks) };
}

function dialogueOf(turn: PartyTurn) {
  return turn.blocks.filter((b): b is Extract<PartyBlock, { kind: 'dialogue' }> => b.kind === 'dialogue');
}

// ---- focused --------------------------------------------------------------

t('focused fixture: count, order, text, speaker id/name, ui payload, mode, input frozen', () => {
  const snapshot = structuredClone(FOCUSED);
  Object.freeze(FOCUSED);
  for (const b of FOCUSED) Object.freeze(b);
  const turn = partyTurnFromBlocks('focused', FOCUSED);
  assert.equal(turn.mode, 'focused');
  assert.equal(turn.blocks.length, 7);
  assert.deepEqual(turn.blocks.map((b) => b.kind), [
    'header', 'narration', 'dialogue', 'thought', 'dialogue', 'dialogue', 'ui',
  ]);
  assert.equal(turn.blocks[0].kind === 'header' && turn.blocks[0].text, '[T-1] 교실 · 오전');
  assert.equal(turn.blocks[1].kind === 'narration' && turn.blocks[1].text, '창가에 먼지가 떠 있다.');
  const focusLine = turn.blocks[2];
  assert.equal(focusLine.kind, 'dialogue');
  if (focusLine.kind === 'dialogue') {
    assert.equal(focusLine.speakerId, 'nari');
    assert.equal(focusLine.speakerName, '나리');
    assert.equal(focusLine.text, '"시비냐."');
  }
  const focusThought = turn.blocks[3];
  assert.equal(focusThought.kind, 'thought');
  if (focusThought.kind === 'thought') {
    assert.equal(focusThought.speakerId, 'nari');
    assert.equal(focusThought.speakerName, '나리');
    assert.equal(focusThought.text, '어떻게 알았지.');
  }
  const extra1 = turn.blocks[4];
  assert.equal(extra1.kind, 'dialogue');
  if (extra1.kind === 'dialogue') {
    assert.equal(extra1.speakerId, 'sera');
    assert.equal(extra1.speakerName, '세라');
    assert.equal(extra1.text, '교칙이다.');
  }
  const extra2 = turn.blocks[5];
  assert.equal(extra2.kind, 'dialogue');
  if (extra2.kind === 'dialogue') {
    assert.equal(extra2.speakerId, 'hayeon');
    assert.equal(extra2.speakerName, '하연');
    assert.equal(extra2.text, '수업 시작한다.');
  }
  const ui = turn.blocks[6];
  assert.equal(ui.kind, 'ui');
  if (ui.kind === 'ui') assert.deepEqual(ui.payload, UI);
  assert.deepEqual(FOCUSED, snapshot, 'input array/objects must be unchanged');
  assertLossless(FOCUSED, turn);
});

t('panel/system are kept (hunter leftover, not dropped)', () => {
  const blocks = [
    blk('panel', 'PANEL leftover', {}, 0),
    blk('system', 'SYSTEM leftover', {}, 1),
  ];
  const turn = partyTurnFromBlocks('focused', blocks);
  assert.deepEqual(turn.blocks.map((b) => b.kind), ['panel', 'system']);
  assertLossless(blocks, turn);
});

t('empty text is not filtered', () => {
  const blocks = [blk('narration', '', {}, 0), line('nari', '나리', '', 1)];
  const turn = partyTurnFromBlocks('focused', blocks);
  assert.equal(turn.blocks.length, 2);
  assert.equal(turn.blocks[0].kind === 'narration' && turn.blocks[0].text, '');
});

// ---- ensemble 14 ----------------------------------------------------------

t('ensemble 1: 1인', () => {
  const { blocks, turn } = ensembleTurn('설록 | 하나만.');
  assert.equal(turn.mode, 'ensemble');
  const d = dialogueOf(turn);
  assert.equal(d.length, 1);
  assert.equal(d[0].speakerId, 'slk');
  assert.equal(d[0].speakerName, '설록');
  assert.equal(d[0].text, '하나만.');
  assertLossless(blocks, turn);
});

t('ensemble 2: 2인', () => {
  const { blocks, turn } = ensembleTurn('설록 | 하나.\n낯선 여자 | 둘.');
  const d = dialogueOf(turn);
  assert.equal(d.length, 2);
  assert.deepEqual(d.map((x) => x.speakerId), ['slk', 'str']);
  assert.deepEqual(d.map((x) => x.speakerName), ['설록', '낯선 여자']);
  assertLossless(blocks, turn);
});

t('ensemble 3: 3인', () => {
  const { blocks, turn } = ensembleTurn('설록 | a\n낯선 여자 | b\n제3자 | c', THREE);
  const d = dialogueOf(turn);
  assert.equal(d.length, 3);
  assert.deepEqual(d.map((x) => [x.speakerId, x.speakerName]), [
    ['slk', '설록'], ['str', '낯선 여자'], ['th3', '제3자'],
  ]);
  assertLossless(blocks, turn);
});

t('ensemble 4: 연속동일화자', () => {
  const { blocks, turn } = ensembleTurn('설록 | 첫.\n설록 | 둘째.');
  const d = dialogueOf(turn);
  assert.equal(d.length, 2);
  assert.deepEqual(d.map((x) => x.speakerId), ['slk', 'slk']);
  assert.deepEqual(d.map((x) => x.text), ['첫.', '둘째.']);
  assertLossless(blocks, turn);
});

t('ensemble 5: narration-only', () => {
  const { blocks, turn } = ensembleTurn('문이 열렸다.');
  assert.equal(turn.blocks.length, 1);
  assert.equal(turn.blocks[0].kind, 'narration');
  assert.equal(turn.blocks[0].kind === 'narration' && turn.blocks[0].text, '문이 열렸다.');
  assert.equal(dialogueOf(turn).length, 0);
  assertLossless(blocks, turn);
});

t('ensemble 6: INFO선행', () => {
  const { blocks, turn } = ensembleTurn('설록 | 말.', ALLOWED, {
    header: '[T-29] 제3검사실',
    info: '민간인 · 비전투',
  });
  assert.equal(turn.blocks[0].kind, 'info');
  assert.equal(turn.blocks[0].kind === 'info' && turn.blocks[0].text, '[T-29] 제3검사실\n민간인 · 비전투');
  assert.equal(turn.blocks[1].kind, 'dialogue');
  assertLossless(blocks, turn);
});

t('ensemble 7: 미지화자 강등결과', () => {
  const parsed = parseScript('유키 | 내가 말할게.', ALLOWED);
  assert.equal(parsed.items[0].kind, 'narration');
  assert.deepEqual(parsed.rejected_names, ['유키']);
  const { blocks, turn } = ensembleTurn('유키 | 내가 말할게.');
  assert.equal(dialogueOf(turn).length, 0);
  assert.equal(turn.blocks[0].kind, 'narration');
  assert.ok(turn.blocks[0].kind === 'narration' && turn.blocks[0].text.includes('유키 | 내가 말할게.'));
  assertLossless(blocks, turn);
});

t('ensemble 8: 빈대사', () => {
  const parsed = parseScript('설록 |', ALLOWED);
  assert.equal(parsed.items[0].kind, 'narration');
  const { blocks, turn } = ensembleTurn('설록 |');
  assert.equal(dialogueOf(turn).length, 0);
  assert.equal(turn.blocks[0].kind, 'narration');
  assertLossless(blocks, turn);
});

t('ensemble 9: 본문 |', () => {
  const parsed = parseScript('A | B 구간은 막혀 있다.', ALLOWED);
  assert.equal(parsed.items[0].kind, 'narration');
  const { blocks, turn } = ensembleTurn('A | B 구간은 막혀 있다.');
  assert.equal(turn.blocks[0].kind, 'narration');
  assert.equal(dialogueOf(turn).length, 0);
  assertLossless(blocks, turn);
});

t('ensemble 10: 연속narration 병합결과', () => {
  const parsed = parseScript('첫 줄.\n둘째 줄.', ALLOWED);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].kind, 'narration');
  const { blocks, turn } = ensembleTurn('첫 줄.\n둘째 줄.');
  assert.equal(turn.blocks.length, 1);
  assert.equal(turn.blocks[0].kind, 'narration');
  assert.equal(turn.blocks[0].kind === 'narration' && turn.blocks[0].text, '첫 줄.\n둘째 줄.');
  assertLossless(blocks, turn);
});

t('ensemble 11: 12줄캡 결과', () => {
  const lines = Array.from({ length: 15 }, (_, i) => `설록 | 줄 ${i + 1}`).join('\n');
  const parsed = parseScript(lines, ALLOWED);
  assert.equal(parsed.items.length, PASS_S_MAX_LINES);
  assert.equal(parsed.dropped_lines, 3);
  const { blocks, turn } = ensembleTurn(lines);
  const d = dialogueOf(turn);
  assert.equal(d.length, PASS_S_MAX_LINES);
  assert.equal(d[0].text, '줄 1');
  assert.equal(d[11].text, '줄 12');
  assertLossless(blocks, turn);
});

t('ensemble 12: canonical id·name', () => {
  const parsed = parseScript('여자 | 이쪽이야.', ALLOWED);
  assert.equal(parsed.items[0].kind, 'line');
  if (parsed.items[0].kind === 'line') {
    assert.equal(parsed.items[0].character_id, 'str');
    assert.equal(parsed.items[0].name, '낯선 여자');
  }
  const { blocks, turn } = ensembleTurn('여자 | 이쪽이야.');
  const d = dialogueOf(turn);
  assert.equal(d.length, 1);
  assert.equal(d[0].speakerId, 'str');
  assert.equal(d[0].speakerName, '낯선 여자');
  assert.equal(d[0].text, '이쪽이야.');
  assertLossless(blocks, turn);
});

t('ensemble 13: 혼합이름', () => {
  const parsed = parseScript('**설록** | 장식된 이름.', ALLOWED);
  assert.equal(parsed.items[0].kind, 'line');
  if (parsed.items[0].kind === 'line') {
    assert.equal(parsed.items[0].character_id, 'slk');
    assert.equal(parsed.items[0].name, '설록');
  }
  const { blocks, turn } = ensembleTurn('**설록** | 장식된 이름.');
  const d = dialogueOf(turn);
  assert.equal(d[0].speakerId, 'slk');
  assert.equal(d[0].speakerName, '설록');
  assertLossless(blocks, turn);
});

t('ensemble 14: 중복표시명 탐지-매핑수정없음', () => {
  const blocks = [
    line('a1', '동일명', '하나', 0),
    line('a2', '동일명', '둘', 1),
  ];
  const turn = partyTurnFromBlocks('ensemble', blocks);
  const d = dialogueOf(turn);
  assert.equal(d.length, 2);
  assert.equal(d[0].speakerId, 'a1');
  assert.equal(d[1].speakerId, 'a2');
  assert.equal(d[0].speakerName, '동일명');
  assert.equal(d[1].speakerName, '동일명');
  assert.equal(d[0].text, '하나');
  assert.equal(d[1].text, '둘');
  assertLossless(blocks, turn);
});

// ---- attach points + no leak ---------------------------------------------

t('finishBeat maps from finalized blocks (focused); finishDialogBeat from its blocks (ensemble)', () => {
  const beat = src('apps/server/src/prompt/composeBeat.ts');
  const dialog = src('apps/server/src/prompt/composeDialog.ts');
  const beatCall = beat.indexOf("partyTurn: partyTurnFromBlocks('focused', blocks)");
  const beatSer = beat.indexOf('const blocks = serializeBeat(');
  assert.ok(beatSer > 0 && beatCall > beatSer, 'focused mapper runs after serializeBeat');
  assert.ok(!beat.includes('dialog'), 'composeBeat.ts must not know about the dialog format');
  const dCall = dialog.indexOf("partyTurnFromBlocks('ensemble', blocks)");
  const dSer = dialog.indexOf('serializeDialogBeat(');
  assert.ok(dSer > 0 && dCall > dSer, 'ensemble mapper runs after serializeDialogBeat');
  assert.ok(!dialog.includes('parsed.items') || dialog.indexOf('script: parsed.items') > 0);
  const afterBlocks = dialog.slice(dialog.indexOf('const blocks = serializeDialogBeat'));
  assert.match(afterBlocks, /partyTurnFromBlocks\('ensemble', blocks\)/);
  assert.doesNotMatch(afterBlocks, /partyTurnFromBlocks\('ensemble', parsed/);
});

t('chat.ts / persist / SSE do not mention partyTurn', () => {
  const chat = src('apps/server/src/routes/chat.ts');
  assert.equal(chat.includes('partyTurn'), false);
  assert.equal(chat.includes('PartyTurn'), false);
  const persist = [
    'apps/server/src/prompt/dialogScript.ts',
    'apps/server/src/prompt/builder.ts',
    'apps/server/src/prompt/templates.ts',
  ];
  for (const rel of persist) {
    const s = src(rel);
    assert.equal(s.includes('partyTurn'), false, rel);
  }
});

console.log(`\n${passed} passed`);
