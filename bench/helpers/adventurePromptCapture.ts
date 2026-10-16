/**
 * Collect model request messages from the real chat routes.
 * Synthetic fixed ids only. No live DB. No product edits.
 * Usage: npx tsx bench/helpers/adventurePromptCapture.ts <out-dir>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { openMigratedDb } from '../../apps/server/src/db/index.ts';
import { GenerationQueue } from '../../apps/server/src/model/queue.ts';
import { characterRoutes } from '../../apps/server/src/routes/characters.ts';
import { storyRoutes } from '../../apps/server/src/routes/stories.ts';
import { conversationRoutes } from '../../apps/server/src/routes/conversations.ts';
import { memoryRoutes } from '../../apps/server/src/routes/memory.ts';
import { chatRoutes } from '../../apps/server/src/routes/chat.ts';
import type { Ctx } from '../../apps/server/src/ctx.ts';
import type { GenParams, GenResult } from '../../apps/server/src/model/adapter.ts';

const T = '2026-10-15 00:00:00';
const IDS = {
  nari: 'char-nari',
  sera: 'char-sera',
  story: 'story-fixed',
  one: 'conv-one',
  beat: 'conv-beat',
  dialog: 'conv-dialog',
  greetOne: 'msg-greet-one',
  greetBeat: 'msg-greet-beat',
  greetDialog: 'msg-greet-dialog',
  memPublic: 'mem-public',
  memPrivate: 'mem-private',
};

export type CapturedCall = {
  label: string;
  messages: Array<{ role: string; content: string }>;
};

function shaMessages(messages: Array<{ role: string; content: string }>): string {
  const body = JSON.stringify(messages.map((m) => ({ role: m.role, content: m.content })));
  return createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');
}

function labelOf(p: GenParams): string {
  const aud = p.audience?.kind;
  if (aud === 'actor') return 'dialog-actor';
  if (aud === 'narrator') return 'dialog-narrator';
  if (aud === 'public') return 'dialog-public';
  const text = p.messages.map((m) => m.content).join('\n');
  if (text.includes('역할극(RP) 파트너')) return 'one-to-one';
  if (text.includes('장면 진행 판정기')) return 'scene-delta';
  if (text.includes('장면 서술자') && text.includes('대사도 쓰지 않는다')) return 'beat-N';
  if (text.includes('끼어들 근거')) return 'beat-E';
  if (text.includes('한 명만 연기한다')) return 'beat-F';
  if (text.includes('입력 초안만 쓴다')) return 'beat-C';
  if (text.includes('대본으로 쓴다')) return 'dialog-public';
  return 'unclassified';
}

export async function capture(outDir: string): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-capture-'));
  const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
  db.prepare(`INSERT INTO settings (key, value) VALUES ('token_calibration', '1')`).run();
  db.prepare(`INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes, instruction_enabled, instruction_text) VALUES ('rp-balanced', 'test-model', 0.8, 0.95, 400, '[]', 'system', null, 0, null)`).run();
  const insertChar = db.prepare(`INSERT INTO characters (id, name, tagline, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, tags_json, archived, created_at, updated_at, play_guide) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`);
  insertChar.run(IDS.nari, '나리', '창가', '2학년', '반말.', '반말', '교실', '', '', '', '["party:place=교실"]', T, T, '');
  insertChar.run(IDS.sera, '세라', '교칙', '2학년', '존댓말.', '존댓말', '교실', '', '', '', '["party:place=교실"]', T, T, '');
  db.prepare(`INSERT INTO stories (id, name, tagline, setting, minor_cast, archived, created_at, updated_at, scene_catalog, opening_json, stats_json, openings_extra_json, endings_json) VALUES (?,?,?,?,?,0,?,?,?,?,?,?,?)`).run(
    IDS.story, '고정이야기', '', 'WORLD', '[]', T, T,
    JSON.stringify({ places: [{ id: '교실', default_focus: IDS.nari }], arcs: ['entry'], stagesByArc: { entry: ['reg'] }, weathers: ['맑음'] }),
    '{}', '{}', '[]', '[]',
  );
  db.prepare(`INSERT INTO story_characters (story_id, character_id, role, sort_order) VALUES (?,?,?,?)`).run(IDS.story, IDS.nari, 'host', 0);
  db.prepare(`INSERT INTO story_characters (story_id, character_id, role, sort_order) VALUES (?,?,?,?)`).run(IDS.story, IDS.sera, 'cast', 1);
  const scene = {
    location: '교실', arc: 'entry', stage: 'reg', clock_minutes: 577, day_index: 12, weekday: '화', weather: '맑음', scene_version: 0,
    present_ids: [IDS.nari, IDS.sera],
  };
  const insertConv = db.prepare(`INSERT INTO conversations (id, character_id, title, mode, profile_name, scene_json, head_message_id, prompt_version, favorite, archived, created_at, updated_at, story_id, story_participant_ids_snapshot, story_name_snapshot, story_setting_snapshot) VALUES (?,?,?,?,?,?,?,?,0,0,?,?,?,?,?,?)`);
  insertConv.run(IDS.one, IDS.nari, 'one', 'chat', 'rp-balanced', JSON.stringify({ ...scene, present_ids: [IDS.nari] }), IDS.greetOne, '2026.08.22-r1+story+compact+roster+opening', T, T, null, null, null, null);
  insertConv.run(IDS.beat, IDS.nari, 'beat', 'story', 'rp-balanced', JSON.stringify(scene), IDS.greetBeat, '2026.08.22-r1+story+compact+roster+opening', T, T, IDS.story, JSON.stringify([IDS.nari, IDS.sera]), '고정이야기', 'WORLD');
  const dialogScene = { ...scene, format: 'dialog' };
  insertConv.run(IDS.dialog, IDS.nari, 'dialog', 'story', 'rp-balanced', JSON.stringify(dialogScene), IDS.greetDialog, '2026.08.22-r1+story+compact+roster+opening', T, T, IDS.story, JSON.stringify([IDS.nari, IDS.sera]), '고정이야기', 'WORLD');
  const insertMsg = db.prepare(`INSERT INTO messages (id, conversation_id, parent_id, role, content, status, meta_json, bookmarked, created_at) VALUES (?,?,?,?,?,?,?,0,?)`);
  insertMsg.run(IDS.greetOne, IDS.one, null, 'assistant', '나리 | 안녕.', 'complete', '{}', T);
  insertMsg.run(IDS.greetBeat, IDS.beat, null, 'assistant', '나리 | 안녕.', 'complete', '{}', T);
  insertMsg.run(IDS.greetDialog, IDS.dialog, null, 'assistant', '나리 | 안녕.', 'complete', '{}', T);
  db.prepare(`INSERT INTO memories (id, conversation_id, content, source, status, importance, scope, evidence_message_ids_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(IDS.memPublic, IDS.dialog, 'PUBLIC_FACT', 'user', 'pinned', 1, 'conversation', JSON.stringify([IDS.greetDialog]), T, T);
  db.prepare(`INSERT INTO memories (id, conversation_id, content, source, status, importance, scope, evidence_message_ids_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(IDS.memPrivate, IDS.dialog, 'PRIVATE_FACT', 'user', 'pinned', 1, 'conversation', JSON.stringify([IDS.greetDialog]), T, T);
  const dialogContext = { version: 1, entries: [
    { memory_id: IDS.memPublic, anchor_message_id: IDS.greetDialog, kind: 'fact', known_by: 'public', status: 'active' },
    { memory_id: IDS.memPrivate, anchor_message_id: IDS.greetDialog, kind: 'fact', known_by: [IDS.nari], status: 'active' },
  ] };
  db.prepare(`UPDATE conversations SET scene_json = ? WHERE id = ?`).run(JSON.stringify({ ...dialogScene, dialog_context: dialogContext }), IDS.dialog);

  const calls: CapturedCall[] = [];
  const result = (text: string): GenResult => ({ text, finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 });
  const model = {
    complete: async (p: GenParams) => {
      calls.push({ label: labelOf(p), messages: p.messages.map((m) => ({ role: m.role, content: m.content })) });
      return result('null');
    },
    stream: async (p: GenParams, onToken: (d: string) => void) => {
      calls.push({ label: labelOf(p), messages: p.messages.map((m) => ({ role: m.role, content: m.content })) });
      const aud = p.audience?.kind;
      const text = aud === 'actor' ? '나리 | PRIVATE_LINE' : aud === 'narrator' ? '서술만' : '나리 | 응답';
      onToken(text);
      return result(text);
    },
    listModels: async () => ['test-model'],
  };
  const ctx = {
    db,
    model,
    queue: new GenerationQueue(1),
    log: { error() {}, info() {}, warn() {}, debug() {} },
    resolvedModel: () => 'test-model',
    setResolvedModel: () => {},
    health: async () => ({ ok: true, checkedAt: T, latencyMs: 0, models: ['test-model'] }),
    effectiveDataDir: tmp,
  } as unknown as Ctx;
  const app = Fastify({ logger: false });
  for (const route of [characterRoutes, storyRoutes, conversationRoutes, memoryRoutes, chatRoutes]) await app.register(route(ctx));
  const send = async (id: string, content: string) => {
    const res = await app.inject({ method: 'POST', url: `/api/conversations/${id}/messages`, payload: { content } });
    if (res.statusCode >= 400 && !String(res.headers['content-type']).includes('text/event-stream')) {
      throw new Error(`send ${id} ${res.statusCode} ${res.body.slice(0, 400)}`);
    }
    return res.statusCode;
  };
  const beforeOne = calls.length;
  await send(IDS.one, '안녕');
  const beforeBeat = calls.length;
  await send(IDS.beat, '나리, 네 이야기 말인데. 세라도 들어.');
  const beforeDialog = calls.length;
  await send(IDS.dialog, '나리, CURRENT');
  await app.close();
  const tagged = calls.map((c, i) => ({ ...c, index: i, sha256: shaMessages(c.messages) }));
  const summary = {
    one: tagged.slice(beforeOne, beforeBeat).map((c) => c.label),
    beat: tagged.slice(beforeBeat, beforeDialog).map((c) => c.label),
    dialog: tagged.slice(beforeDialog).map((c) => c.label),
    counts: {
      one: beforeBeat - beforeOne,
      beat: beforeDialog - beforeBeat,
      dialog: tagged.length - beforeDialog,
      dialogActor: tagged.slice(beforeDialog).filter((c) => c.label === 'dialog-actor').length,
    },
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'calls.json'), JSON.stringify(tagged, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  for (const c of tagged) {
    const body = JSON.stringify(c.messages.map((m) => ({ role: m.role, content: m.content })));
    fs.writeFileSync(path.join(outDir, `${String(c.index).padStart(2, '0')}-${c.label}.json`), body);
  }
  console.log(JSON.stringify(summary));
}

const out = process.argv[2];
if (out && process.argv[1] && process.argv[1].includes('adventurePromptCapture')) {
  capture(out).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
