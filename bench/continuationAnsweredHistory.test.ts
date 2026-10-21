/** npm run test:benches -- continuationAnsweredHistory
 * LOCK-78-Followup (#78). Synthetic fixed IDs/text only, temporary SQLite, mock model (no calls).
 * 1) Narration continuation renders the already-answered user input as chronological history
 *    ('이미 답한 기록'), never as a current-turn input, and asks to continue after the target.
 * 2) An unnamed user (pronoun fallback 나) gets an unambiguous referent and keeps first-person ownership.
 * 3) Byte invariance vs 0194b9f: beat Pass N/F/E, direct renderPassN (default-off), Pass F/dialog/solo
 *    continuation requests and the 1:1 chat buildPrompt request are sha256-pinned.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openMigratedDb, one, run } from '../apps/server/src/db/index.js';
import { getPath, setHead } from '../apps/server/src/db/tree.js';
import { buildSceneSnapshot } from '../apps/server/src/db/sceneBase.js';
import { buildContinuation } from '../apps/server/src/routes/continuation.js';
import { buildPrompt } from '../apps/server/src/prompt/builder.js';
import { renderPassN, type NarrationObservation } from '../apps/server/src/prompt/passes.js';
import { planBeat, planPassE, type BeatPlanInput } from '../apps/server/src/prompt/composeBeat.js';
import { catalogFromStory } from '../apps/server/src/prompt/sceneCatalog.js';
import type { CastMember } from '../apps/server/src/prompt/cast.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { config } from '../apps/server/src/config.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { ConversationRow, MessageMeta, Scene } from '../apps/server/src/types.js';

const sha = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').digest('hex');
let checks = 0;
const failures: string[] = [];
const test = (name: string, fn: () => void) => {
  checks++;
  try { fn(); console.log(`ok ${checks} ${name}`); }
  catch (error) { failures.push(name); console.log(`not ok ${checks} ${name}: ${(error as Error).message.split('\n')[0]}`); }
};

/** Pinned at master 0194b9f41081c6c335160f5f6a2c98dbb0b9f340 (computed before the fix). */
const PINNED: Record<string, string> = {
  'renderPassN:named-recent': '4c3405f3220a66d4503e287d774f43d2fa3012f2d0952126423b3dc3b516b7e8',
  'renderPassN:fallback-na': 'a67152696cb8d77b6e18d109c9c761cc284cd03aab256ef862875cdc7caa1fd3',
  'renderPassN:user-observation-with-speakerName': '9ae08aa390c7b26ceebd561487db117b19a6ba86a4e702a4d544d70d0f70209a',
  'beat:named:pass_n': 'f0af3c530e642e5cc2a1f5e666e3540c2bd355f52b58a7844140b9930316add6',
  'beat:named:pass_f': '13ab2f7c7949352585a82d7b865882f35ac6b95ed0ca40b99e3dfeef301fe8e8',
  'beat:named:pass_e': '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  'beat:unnamed:pass_n': 'dbf583e32db6565b0b47a10f0bfb7d1ccc572e6ade5f7d12ded8ba8bc06c12fd',
  'beat:unnamed:pass_f': '003c6e89fdcc9a9c5410238531a49431b5420daf8d15edad8b32ad4ccf5941bb',
  'beat:observed:pass_n': 'e7bf68d4dfffd86bcc82ebf2bbf98b777932b2a3ad8293d023f61f617a0297bb',
  'continuation:solo': '5483e9bcd4fbb3dc6f86fd3dfdcac6a4d2505212730318ba63c5807ba5c1c413',
  'continuation:line(PassF)': '9e71b8ae9e394a02f5e478d28f9d9d91d158d012e957ba802bbf5397594650a8',
  'continuation:dialog': '4e9bd67b27abedb89682f870bcfe3a120345455cbf0f19bd5bbd5156bb445ded',
  'continuation:line-unnamed(PassF)': '117812c148d7e247111b498ed89467a6c205686934233c1d2428c9c8c6aa3d46',
  'chat:buildPrompt': '41f8173bf9b99f057bf83c405619df732ed9775e23c2bff978c8578bcd483b33',
};

function beatHashes(): Record<string, string> {
  const member = (o: Partial<CastMember> & { id: string; name: string }): CastMember => ({ aliases: [], duties: [], place: '교실', role: 'secondary', ...o });
  const cast = [member({ id: 'p1', name: '도윤', duties: ['이야기'] }), member({ id: 'p2', name: '서진', duties: ['교칙'] }),
    member({ id: 'p3', name: '하람', duties: ['수업'], role: 'main' })];
  const scene: Scene = { location: '교실', arc: 'entry', stage: 'reg', clock_minutes: 600, day_index: 3, weekday: '수', weather: '맑음',
    scene_version: 0, present_ids: ['p1', 'p2', 'p3'] };
  const catalog = catalogFromStory(JSON.stringify({ places: [{ id: '교실', default_focus: 'p3' }], arcs: ['entry'],
    stagesByArc: { entry: ['reg'] }, weathers: ['맑음'], flags: { rulebreak: { owner_duty: '교칙' } } }));
  const cards = Object.fromEntries(cast.map(m => [m.id, { name: m.name, personality: `${m.name}의 성격` }]));
  const base = (o: Partial<BeatPlanInput> = {}): BeatPlanInput => ({ conversation_id: 'syn-conv', scene, catalog, current_version: 0,
    user_text: '도윤, 아까 맡긴 정리는 내가 끝낼게.', user_name: '강민', cast, cards, main_character_id: 'p3', message_id: 'syn-msg',
    recent_narrations: ['창밖으로 바람이 지나갔다.'], patch: { base_version: 0 }, ...o });
  const out: Record<string, string> = {};
  const named = planBeat(base());
  out['beat:named:pass_n'] = sha(named.pass_n);
  out['beat:named:pass_f'] = sha(named.pass_f ?? '');
  out['beat:named:pass_e'] = sha(planPassE(base(), named, '바람이 지나갔다.', '"알았어."').map(p => p.prompt));
  const unnamedInput = base({ user_name: undefined });
  const unnamed = planBeat(unnamedInput);
  out['beat:unnamed:pass_n'] = sha(unnamed.pass_n);
  out['beat:unnamed:pass_f'] = sha(unnamed.pass_f ?? '');
  const observed = planBeat(base({ observation_enabled: true, user_audience: { visibility: 'public' },
    observations: [{ text: '내가 손목을 감쌌다.', kind: 'user', speakerName: '강민', audience: { visibility: 'public' } },
      { text: '"괜찮아?"', kind: 'dialogue', speakerName: '도윤', audience: { visibility: 'public' } }] }));
  out['beat:observed:pass_n'] = sha(observed.pass_n);
  return out;
}

function directPassNHashes(): Record<string, string> {
  const cast: CastMember[] = [{ id: 'p1', name: '도윤', aliases: [], duties: [], place: '교실', role: 'secondary' }];
  const scene: Scene = { present_ids: ['p1'] };
  const obs: NarrationObservation[] = [{ kind: 'user', text: '내가 상자를 옮겼다.' }, { kind: 'narration', text: '먼지가 일었다.' },
    { kind: 'dialogue', speakerName: '도윤', text: '"조심해."' }, { kind: 'unknown', text: '알 수 없는 기록' }];
  return {
    'renderPassN:named-recent': sha(renderPassN({ focusCard: null, cast, scene, header: '헤더', userName: '강민', userText: '현재 입력',
      ambientNames: ['도윤'], observations: obs, recentNarrations: ['앞 서술 하나', '앞 서술 둘'] })),
    'renderPassN:fallback-na': sha(renderPassN({ focusCard: null, cast, scene, header: null, userText: '나는 문을 열었다.', ambientNames: [], observations: obs })),
    'renderPassN:user-observation-with-speakerName': sha(renderPassN({ focusCard: null, cast, scene, header: null, userName: '나', userText: 'x',
      ambientNames: [], observations: [{ kind: 'user', speakerName: '강민', text: '이전 입력' }] })),
  };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-answered-history-'));
  const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
  const previousContext = config.model.contextTokens;
  config.model.contextTokens = 16384;
  const ctx = { db, queue: new GenerationQueue(1), resolvedModel: () => 'mock', log: { warn() {}, error() {} },
    model: { stream: async () => { throw new Error('no model calls in this bench'); } } } as unknown as Ctx;
  const stamp = '2026-01-01T00:00:00Z';
  try {
    run(db, "INSERT INTO model_profiles(name,max_tokens) VALUES ('rp-balanced',500)");
    for (const [id, name] of [['a', '루미'], ['b', '세온']]) run(db, 'INSERT INTO characters(id,name,created_at,updated_at) VALUES (?,?,?,?)', id, name, stamp, stamp);
    run(db, "INSERT INTO personas(id,name,created_at,updated_at) VALUES ('player','합성 플레이어',?,?)", stamp, stamp);
    run(db, "INSERT INTO stories(id,name,scene_catalog,created_at,updated_at) VALUES ('story','합성 무대',?,?,?)", JSON.stringify({ places: [{ id: 'yard', name: '마당' }] }), stamp, stamp);
    for (const [i, id] of ['a', 'b'].entries()) run(db, "INSERT INTO story_characters(story_id,character_id,sort_order) VALUES ('story',?,?)", id, i);
    const conv = (id: string) => one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id=?', id)!;
    const fixture = (id: string, mode: 'solo' | 'line' | 'dialog' | 'narration' = 'narration', persona: string | null = 'player', userInput = 'ANSWERED_INPUT_SYN') => {
      const scene: Scene = { format: mode === 'dialog' ? 'dialog' : 'beat', present_ids: ['a', 'b'], location: 'yard', observation_filter: false, scene_version: 1 };
      run(db, `INSERT INTO conversations(id,character_id,persona_id,mode,story_id,story_participant_ids_snapshot,scene_json,prompt_version,created_at,updated_at)
        VALUES (?,'a',?,?,?,?,?,'fixture',?,?)`, id, persona, mode === 'solo' ? 'chat' : 'story', mode === 'solo' ? null : 'story', mode === 'solo' ? null : '["a","b"]', JSON.stringify(scene), stamp, stamp);
      let parent: string | null = null;
      const add = (key: string, role: 'user' | 'assistant', content: string, meta: MessageMeta = {}) => {
        const rowId = `${id}-${key}`;
        run(db, "INSERT INTO messages(id,conversation_id,parent_id,role,content,status,meta_json,created_at) VALUES (?,?,?,?,?,'complete',?,?)", rowId, id, parent, role, content,
          JSON.stringify({ generation_id: id, observation: { visibility: 'public' }, ...meta }), stamp);
        parent = rowId; setHead(db, id, rowId); return rowId;
      };
      add('h1', 'user', 'EARLIER_USER_SYN');
      add('h2', 'assistant', 'EARLIER_NARRATION_SYN', { block_kind: 'narration' });
      add('h3', 'assistant', '"NPC_LINE_SYN"', { block_kind: 'line', speaker_character_id: 'b', speaker_name: '세온' });
      add('u', 'user', userInput);
      add('target', 'assistant', 'TARGET_SHOWN_SYN', mode === 'solo' ? {} : {
        block_kind: mode === 'narration' ? 'narration' : 'line',
        ...(mode === 'narration' ? {} : { speaker_character_id: 'a', speaker_name: '루미' }),
        beat_seq: 0, scene_state: buildSceneSnapshot(scene, scene),
      });
      return id;
    };
    const build = (id: string) => buildContinuation(ctx, conv(id), getPath(db, conv(id)));
    const req = (id: string) => { const b = build(id); return { messages: b.messages, maxTokens: b.maxTokens, temperature: b.temperature, topP: b.topP, stop: b.stop }; };
    const prompt = (id: string) => build(id).messages.map(m => m.content).join('\n');

    const got: Record<string, string> = { ...directPassNHashes(), ...beatHashes() };
    got['continuation:solo'] = sha(req(fixture('bytes-solo', 'solo')));
    got['continuation:line(PassF)'] = sha(req(fixture('bytes-line', 'line')));
    got['continuation:dialog'] = sha(req(fixture('bytes-dialog', 'dialog')));
    got['continuation:line-unnamed(PassF)'] = sha(req(fixture('bytes-line-unnamed', 'line', null)));
    const chatId = fixture('bytes-chat', 'solo');
    const chat = buildPrompt(db, conv(chatId), getPath(db, conv(chatId)), 16384, 'mock');
    got['chat:buildPrompt'] = sha({ messages: chat.messages, stop: chat.stop, model: chat.model, max_tokens: chat.profile.max_tokens });
    if (process.env.RPCHAT_PRINT_HASHES === '1') console.log(JSON.stringify(got, null, 2));
    const artifact = process.env.RPCHAT_BENCH_ARTIFACT_DIR;
    if (artifact) { fs.mkdirSync(artifact, { recursive: true }); fs.writeFileSync(path.join(artifact, 'answered-history-byte-pins.json'), JSON.stringify(got, null, 2) + '\n'); }

    test('beat Pass N/F/E, default renderPassN, Pass F/dialog/solo continuation and chat buildPrompt bytes equal the 0194b9f pins', () => {
      assert.deepEqual(got, PINNED);
    });

    const p = prompt(fixture('answered'));
    test('(a) the answered input is not presented as a current-turn input', () => {
      assert.ok(!p.includes('## 현재 사용자 발화'));
      assert.ok(!p.includes('이번 턴에 새로 달라진 것만 쓴다'));
    });
    test('(a) answered input sits under 이미 답한 기록 in chronological order before the continuation target', () => {
      const head = '## 이미 답한 기록';
      assert.ok(p.includes(head));
      const order = ['[사용자] EARLIER_USER_SYN', '[서술자] EARLIER_NARRATION_SYN', '[세온] "NPC_LINE_SYN"', '[사용자: 합성 플레이어] ANSWERED_INPUT_SYN', '[서술자] TARGET_SHOWN_SYN']
        .map(s => { const i = p.indexOf(s); assert.ok(i >= 0, s); return i; });
      assert.deepEqual([...order].sort((x, y) => x - y), order);
      const record = p.split(`${head}`)[1].split('\n\n')[0];
      assert.ok(record.includes('[사용자: 합성 플레이어] ANSWERED_INPUT_SYN'));
      assert.ok(!record.includes('TARGET_SHOWN_SYN'));
      assert.equal(p.split('ANSWERED_INPUT_SYN').length - 1, 1, 'answered input rendered exactly once');
    });
    test('(a) the task is to continue after the target, not to answer the recorded input', () => {
      assert.ok(p.includes('위 "이미 답한 기록"의 사용자 입력에는 이미 응답했다. 그 입력에 다시 답하거나 다시 서술하지 않는다.'));
      assert.ok(p.includes('이어 쓸 직전 서술'));
    });
    test('(b) the [사용자: name] attribution label is kept for the answered input', () => {
      assert.ok(p.includes('[사용자: 합성 플레이어] ANSWERED_INPUT_SYN'));
      assert.ok(p.includes("'합성 플레이어'은 사용자다. 위 목록의 인물과 같은 사람이 아니다."), 'named persona line unchanged');
    });
    const unnamed = prompt(fixture('unnamed', 'narration', null, '나는 세온 옆에서 손목을 감싸 쥐고 남은 장부 정리를 마저 했다.'));
    test('(c) unnamed user (fallback 나) keeps an unambiguous referent and first-person ownership', () => {
      assert.ok(!unnamed.includes("'나'은"), 'no broken particle');
      assert.ok(unnamed.includes('[사용자: 나] 나는 세온 옆에서'));
      assert.ok(unnamed.includes("- 사용자는 이름이 없다. 사용자 입력 속 '나'·'내'·'제'는 사용자 자신이다. 서술자도, 위 목록의 인물도 아니다."));
      assert.ok(unnamed.includes("- 서술에서 사용자를 가리킬 때는 '당신'이라고 쓴다. 사용자의 몸·부상·일·약속을 다른 인물의 것으로 옮기지 않는다."));
    });
    test('(c) a persona named differently is not affected by the unnamed-user lines', () => {
      assert.ok(!p.includes('사용자는 이름이 없다.'));
    });
  } finally { config.model.contextTokens = previousContext; db.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
  if (failures.length) throw new Error(`${failures.length}/${checks} checks failed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
