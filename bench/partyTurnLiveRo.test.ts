/**
 * npx tsx bench/partyTurnLiveRo.test.ts
 * B-2 S2 — live RO before/after render plans on mixed room sha12=0259d81281ad.
 * LIVE_NO_TOUCH: copy only. Never prints live content or display names.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  partyRenderPlan,
  plansEquivalent,
  type PartyRenderPlan,
} from '../apps/web/src/lib/partyRenderPlan.ts';
import {
  partyBlockFromMessage,
  type PartyMessageLike,
  type PartyMessageMeta,
} from '../apps/web/src/lib/partyTurn.ts';
import { wrapSpeechMarks } from '../apps/web/src/lib/speechMarks.ts';

const MIXED_SHA12 = '0259d81281ad';
const COPY = process.env.RPCHAT_RO_DB || '/tmp/rpchat-b2s2-live-ro.db';

function sha12(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

function sqliteJson(db: string, sql: string): Record<string, unknown>[] {
  const out = execFileSync('sqlite3', ['-readonly', '-json', db, sql], { encoding: 'utf8' }).trim();
  if (!out) return [];
  return JSON.parse(out) as Record<string, unknown>[];
}

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

function anonymize(plan: PartyRenderPlan): unknown {
  if (plan.surface === 'plain' || plan.surface === 'header' || plan.surface === 'info' || plan.surface === 'narration') {
    return { surface: plan.surface, text_sha12: sha12(plan.surface === 'narration' || plan.surface === 'plain' ? plan.text : plan.text), streaming: 'streaming' in plan ? plan.streaming : undefined };
  }
  if (plan.surface === 'dialogue') {
    return {
      surface: 'dialogue',
      speaker_sha12: plan.speakerId ? sha12(plan.speakerId) : null,
      name_sha12: plan.speakerName ? sha12(plan.speakerName) : null,
      text_sha12: sha12(plan.text),
      streaming: plan.streaming,
    };
  }
  if (plan.surface === 'ui-raw') return { surface: 'ui-raw', raw_sha12: sha12(plan.raw) };
  return { surface: plan.surface };
}

assert.ok(fs.existsSync(COPY), `RO copy missing: ${COPY}`);
const st = fs.statSync(COPY);
assert.ok(st.isFile(), COPY);

const convs = sqliteJson(COPY, 'SELECT id FROM conversations');
const hit = convs.find((c) => sha12(String(c.id)) === MIXED_SHA12);
assert.ok(hit, `no conversation with sha12 ${MIXED_SHA12} in RO copy`);
const convId = String(hit.id);

const rows = sqliteJson(
  COPY,
  `SELECT id, role, content, meta_json, status, created_at FROM messages WHERE conversation_id = '${convId.replace(/'/g, "''")}' ORDER BY created_at ASC`,
);

type Row = {
  role: string;
  content: string;
  meta: Record<string, unknown>;
  generation_id: string | null;
};

const parsed: Row[] = rows.map((r) => {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(String(r.meta_json ?? '{}')) as Record<string, unknown>;
  } catch {
    meta = {};
  }
  const gid = typeof meta.generation_id === 'string' ? meta.generation_id : null;
  return { role: String(r.role), content: String(r.content ?? ''), meta, generation_id: gid };
});

const gens: string[] = [];
const byGen = new Map<string, Row[]>();
for (const row of parsed) {
  const key = row.generation_id ?? `nogid:${sha12(row.content).slice(0, 8)}`;
  if (!byGen.has(key)) {
    gens.push(key);
    byGen.set(key, []);
  }
  byGen.get(key)!.push(row);
}

function classify(rowsIn: Row[]): 'one-to-one' | 'beat' | 'dialog' {
  const kinds = rowsIn
    .filter((r) => r.role === 'assistant')
    .map((r) => (typeof r.meta.block_kind === 'string' ? r.meta.block_kind : ''));
  if (kinds.every((k) => !k)) return 'one-to-one';
  if (kinds.includes('thought') || kinds.includes('ui') || kinds.includes('header')) return 'beat';
  if (kinds.includes('info') || kinds.includes('line') || kinds.includes('narration')) return 'dialog';
  return 'one-to-one';
}

function asMsg(row: Row): PartyMessageLike {
  const block_kind = typeof row.meta.block_kind === 'string' ? (row.meta.block_kind as PartyMessageMeta['block_kind']) : undefined;
  const speaker_character_id = typeof row.meta.speaker_character_id === 'string' ? row.meta.speaker_character_id : undefined;
  const speaker_name = typeof row.meta.speaker_name === 'string' ? row.meta.speaker_name : undefined;
  return {
    content: row.content,
    meta: { block_kind, speaker_character_id, speaker_name },
  };
}

let compared = 0;
let oneToOne = 0;
let beat = 0;
let dialog = 0;

for (const gid of gens) {
  const group = byGen.get(gid)!;
  const cls = classify(group);
  if (cls === 'one-to-one') oneToOne += 1;
  else if (cls === 'beat') beat += 1;
  else dialog += 1;

  for (const row of group) {
    if (row.role !== 'assistant') continue;
    const m = asMsg(row);
    const oldP = legacyRenderPlan(m, false);
    const newP = partyRenderPlan(m, { streaming: false });
    if (cls === 'dialog') {
      assert.ok(plansEquivalent(oldP, newP), 'dialog equivalent');
    } else {
      assert.deepEqual(oldP, newP, `${cls} identical`);
    }
    void anonymize(newP);
    void partyBlockFromMessage(m);
    compared += 1;
  }
}

assert.ok(oneToOne >= 1 && beat >= 1 && dialog >= 1, `mixed room expected 1:1+beat+dialog gens, got ${oneToOne}/${beat}/${dialog}`);
assert.ok(compared > 0, 'no assistant rows');

console.log(
  `partyTurnLiveRo PASS compared=${compared} gens=${gens.length} oneToOne=${oneToOne} beat=${beat} dialog=${dialog} copy=${path.basename(COPY)} sha12=${MIXED_SHA12}`,
);
