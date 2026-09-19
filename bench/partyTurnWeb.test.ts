/**
 * npx tsx bench/partyTurnWeb.test.ts
 * B-2 S2 — client mapper twin + old switch vs new renderer (synthetic).
 * Pure. No live DB, no model, no SSE, no persist.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { partyTurnFromBlocks } from '../apps/server/src/prompt/partyTurn.ts';
import type { BeatBlock } from '../apps/server/src/prompt/renderBeat.ts';
import {
  partyBlockFromMessage,
  type PartyMessageLike,
} from '../apps/web/src/lib/partyTurn.ts';
import {
  partyRenderPlan,
  plansEquivalent,
  type PartyRenderPlan,
} from '../apps/web/src/lib/partyRenderPlan.ts';
import { wrapSpeechMarks } from '../apps/web/src/lib/speechMarks.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const chatPage = fs.readFileSync(path.join(root, 'apps/web/src/pages/ChatPage.tsx'), 'utf8');
const viewSrc = fs.readFileSync(path.join(root, 'apps/web/src/components/view.tsx'), 'utf8');

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`ok ${passed} ${name}`);
}

const blank = {
  speaker_character_id: null as string | null,
  speaker_name: null as string | null,
  asset_path: null as string | null,
  emotion: null as string | null,
  outfit: null as string | null,
};

function blk(kind: BeatBlock['kind'], text: string, extra: Partial<BeatBlock> = {}): BeatBlock {
  return { seq: 0, kind, ...blank, text, ...extra };
}

/** Frozen pre-S2 ChatPage chrome (구 스위치). */
function legacyRenderPlan(m: PartyMessageLike, streaming = false): PartyRenderPlan {
  const kind = m.meta?.block_kind;
  if (!kind) return { surface: 'plain', text: m.content, streaming };
  if (kind === 'line') {
    return {
      surface: 'dialogue',
      speakerId: m.meta?.speaker_character_id ?? null,
      speakerName: m.meta?.speaker_name ?? null,
      text: streaming ? m.content : wrapSpeechMarks(m.content),
      streaming,
    };
  }
  if (kind === 'header') return { surface: 'header', text: m.content };
  if (kind === 'info') return { surface: 'info', text: m.content };
  if (kind === 'narration') return { surface: 'narration', text: m.content, streaming };
  if (kind === 'thought') return { surface: 'thought-hidden' };
  return { surface: 'ui-raw', raw: m.content };
}

function rowFromBeat(b: BeatBlock): PartyMessageLike {
  const meta: PartyMessageLike['meta'] = { block_kind: b.kind };
  if (b.kind === 'line' || b.kind === 'thought') {
    if (b.speaker_character_id != null) meta.speaker_character_id = b.speaker_character_id;
    if (b.speaker_name != null) meta.speaker_name = b.speaker_name;
  }
  return { content: b.text, meta };
}

t('ChatPage wires partyBlockFromMessage + PartyBlockView; view exports PartyBlockView', () => {
  assert.match(chatPage, /partyBlockFromMessage/);
  assert.match(chatPage, /PartyBlockView/);
  assert.match(viewSrc, /export function PartyBlockView/);
  assert.match(viewSrc, /kind === 'thought'/);
  assert.match(viewSrc, /BeatNarration text=\{block\.text\}/);
  assert.equal(viewSrc.includes('parseTurnBlocks'), false);
  assert.equal(/BeatHeader|BeatInfoSheet|BeatNarration/.test(chatPage), false);
  assert.equal(chatPage.includes("kind === 'header' || kind === 'info' || kind === 'narration'"), false);
});

t('client mapper is S1 partyTurnFromBlocks twin on BeatBlock rows', () => {
  const blocks: BeatBlock[] = [
    blk('header', 'H'),
    blk('narration', 'N'),
    blk('line', 'hi', { speaker_character_id: 'c1', speaker_name: 'A' }),
    blk('thought', 'secret', { speaker_character_id: 'c1', speaker_name: 'A' }),
    blk('info', '[정보]: x'),
    blk('ui', '{"hint":"go","strip":[],"roster":[]}'),
    blk('panel', 'P'),
    blk('system', 'S'),
  ];
  const server = partyTurnFromBlocks('focused', blocks);
  const client = blocks.map((b) => partyBlockFromMessage(rowFromBeat(b)));
  assert.equal(client.length, server.blocks.length);
  for (let i = 0; i < client.length; i++) {
    assert.deepEqual(client[i], server.blocks[i]);
  }
});

t('damaged ui JSON: client payload matches S1 (raw string, never throws)', () => {
  const b = blk('ui', '{not json');
  const server = partyTurnFromBlocks('focused', [b]).blocks[0];
  const client = partyBlockFromMessage(rowFromBeat(b));
  assert.deepEqual(client, server);
  assert.equal(client && client.kind === 'ui' && client.payload, '{not json');
});

t('no block_kind → not a PartyBlock (1:1 path)', () => {
  assert.equal(partyBlockFromMessage({ content: 'hello', meta: {} }), null);
  assert.equal(partyBlockFromMessage({ content: 'hello' }), null);
});

const cases: { name: string; m: PartyMessageLike; streaming?: boolean }[] = [
  { name: '1:1', m: { content: 'plain *hi*', meta: {} } },
  { name: '1:1 streaming', m: { content: 'hel', meta: {} }, streaming: true },
  { name: 'header', m: { content: 'Scene', meta: { block_kind: 'header' } } },
  { name: 'info', m: { content: '[정보]: here', meta: { block_kind: 'info' } } },
  { name: 'narration', m: { content: 'The rain.', meta: { block_kind: 'narration' } } },
  { name: 'narration streaming', m: { content: 'The r', meta: { block_kind: 'narration' } }, streaming: true },
  { name: 'thought hidden', m: { content: 'secret', meta: { block_kind: 'thought', speaker_character_id: 'c1', speaker_name: 'A' } } },
  { name: 'line done', m: { content: 'hello', meta: { block_kind: 'line', speaker_character_id: 'c1', speaker_name: 'A' } } },
  { name: 'line streaming raw', m: { content: 'hel', meta: { block_kind: 'line', speaker_character_id: 'c1', speaker_name: 'A' } }, streaming: true },
  { name: 'ui json', m: { content: '{"hint":"x","strip":[],"roster":[]}', meta: { block_kind: 'ui' } } },
  { name: 'ui damaged', m: { content: '{not json', meta: { block_kind: 'ui' } } },
  { name: 'panel', m: { content: '{"hint":"p","strip":[],"roster":[]}', meta: { block_kind: 'panel' } } },
  { name: 'system', m: { content: 'sys', meta: { block_kind: 'system' } } },
];

t('old switch vs new renderer: identical component+props plan per case', () => {
  for (const c of cases) {
    const oldP = legacyRenderPlan(c.m, !!c.streaming);
    const newP = partyRenderPlan(c.m, { streaming: c.streaming });
    assert.ok(plansEquivalent(oldP, newP), c.name);
    if (c.name !== 'ui json' && c.name !== 'panel') {
      assert.deepEqual(oldP, newP, c.name);
    }
  }
});

t('completed line plan wraps speech marks; streaming stays raw; wrap not in mapper', () => {
  const m: PartyMessageLike = {
    content: 'hello',
    meta: { block_kind: 'line', speaker_character_id: 'c1', speaker_name: 'A' },
  };
  const done = partyRenderPlan(m, { streaming: false });
  const live = partyRenderPlan(m, { streaming: true });
  const mapped = partyBlockFromMessage(m);
  assert.equal(mapped && mapped.kind === 'dialogue' && mapped.text, 'hello');
  assert.equal(done.surface, 'dialogue');
  if (done.surface === 'dialogue') assert.equal(done.text, wrapSpeechMarks('hello'));
  if (live.surface === 'dialogue') assert.equal(live.text, 'hello');
});

t('thought plan is hidden; mapper still emits thought block', () => {
  const m: PartyMessageLike = { content: 'secret', meta: { block_kind: 'thought' } };
  assert.equal(partyBlockFromMessage(m)?.kind, 'thought');
  assert.deepEqual(partyRenderPlan(m), { surface: 'thought-hidden' });
});

console.log(`partyTurnWeb ${passed}/${passed} PASS`);
