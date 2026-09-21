/** npx tsx bench/emptyUserTurn.test.ts
 * empty-turn — 1:1 inject-only 단축어가 남기는 빈 user 턴 차단.
 *
 * 배경: inject-only 단축어(`/일기`)는 content='' 로 제출된다. routes/chat.ts 는 그
 * 빈 user 행을 complete 로 저장하고, buildPrompt 의 skip 루프는 마지막 인덱스를
 * 예외로 두었기 때문에 모델이 빈 user 발화를 그대로 받았다(라이브에서 "무반응/무시"
 * 로 서사에 반영됨). 여기서 고정하는 계약:
 *
 *   1. 현재 턴이 빈 user 여도 모델 입력에는 빈 user 발화가 없다
 *   2. 과거의 빈 complete user 행도 최근 대화에 들어가지 않는다
 *   3. 빠진 끝자리는 기존 폴백 문구가 메운다 — 새 문구를 만들지 않는다
 *   4. inject_instruction 은 그대로 전달된다
 *   5. UI 목록에서 빈 user 행은 숨는다 (assistant 스트리밍 빈 행은 유지)
 *
 * Temp/memory DB + light Fastify. LIVE_NO_TOUCH — 라이브 DB 무접촉.
 * 빈 user 행을 저장하느냐 마느냐는 이 벤치의 범위가 아니다(후속 슬라이스). 저장
 * 여부와 무관하게 위 계약이 성립해야 한다.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import type { DB } from '../apps/server/src/db/index.js';
import { openMigratedDb } from '../apps/server/src/db/index.js';
import { GenerationQueue } from '../apps/server/src/model/queue.js';
import { buildPrompt } from '../apps/server/src/prompt/builder.js';
import { substitute } from '../apps/server/src/prompt/templates.js';
import { PROMPT_VERSION } from '../apps/server/src/config.ts';
import { characterRoutes } from '../apps/server/src/routes/characters.js';
import { conversationRoutes } from '../apps/server/src/routes/conversations.js';
import { storyRoutes } from '../apps/server/src/routes/stories.js';
import { chatRoutes } from '../apps/server/src/routes/chat.js';
import type { Ctx } from '../apps/server/src/ctx.js';
import type { ConversationRow, MessageRow } from '../apps/server/src/types.js';
import type { GenParams, GenResult } from '../apps/server/src/model/adapter.js';
import { groupChatTurns, isEmptyUserMessage, visibleChatMessages } from '../apps/web/src/lib/chatLayout.ts';
import type { Message } from '../apps/web/src/types.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

/** 기존 1:1 폴백 원문. 새 문구를 만들지 않았다는 것을 이 상수가 고정한다. */
const CONTINUE_FALLBACK = '(장면을 이어서 {{char}}의 차례로 진행한다.)';
const GREETING_FALLBACK = '첫 장면을 {{char}}의 인사로 시작한다.';
const INJECT_MARKER = 'EMPTY_TURN_INJECT_MARKER_ZZQ';

function parseSse(raw: string): Array<{ type: string; [k: string]: unknown }> {
  const out: Array<{ type: string; [k: string]: unknown }> = [];
  for (const block of raw.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    try {
      out.push(JSON.parse(line.slice(6)));
    } catch {
      /* keepalive */
    }
  }
  return out;
}

/** 어떤 pass 에서든 빈 user 발화가 모델에 갔는지. 이 벤치의 핵심 판정. */
function emptyUserTurns(captured: GenParams[]): Array<{ pass: number; role: string }> {
  const hits: Array<{ pass: number; role: string }> = [];
  captured.forEach((p, i) => {
    for (const m of p.messages) {
      if (m.role === 'user' && !m.content.trim()) hits.push({ pass: i, role: m.role });
    }
  });
  return hits;
}

function flattenGenMessages(captured: GenParams[]): string {
  return captured.flatMap((p) => p.messages.map((m) => `${m.role}\n${m.content}`)).join('\n---\n');
}

function seed(): DB {
  const db = new Database(':memory:') as unknown as DB;
  db.exec(`
    CREATE TABLE characters (id TEXT PRIMARY KEY, name TEXT, tagline TEXT, description TEXT, personality TEXT, speech_style TEXT, scenario TEXT, taboos TEXT, example_dialogue TEXT);
    CREATE TABLE personas (id TEXT PRIMARY KEY, name TEXT, address_as TEXT, appearance TEXT, personality TEXT, relationship TEXT, is_default INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE model_profiles (name TEXT PRIMARY KEY, model TEXT, temperature REAL, top_p REAL, max_tokens INTEGER, stop_json TEXT, system_mode TEXT, notes TEXT);
    INSERT INTO characters VALUES ('c1','테스트캐','짧은소개','설명','성격','말투','시나리오','금기','예시');
    INSERT INTO model_profiles VALUES ('rp-balanced',NULL,0.8,0.95,400,'[]','system',NULL);
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, character_id TEXT, persona_id TEXT, mode TEXT, profile_name TEXT, scene_json TEXT, user_note TEXT,
      story_id TEXT, story_applied_at TEXT, story_name_snapshot TEXT, story_setting_snapshot TEXT, story_minor_cast_snapshot TEXT,
      story_participant_ids_snapshot TEXT, story_opening_snapshot TEXT, story_endings_snapshot TEXT, ended_at TEXT, reached_ending_id TEXT
    );
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, status TEXT, created_at TEXT);
    CREATE TABLE memories (id TEXT PRIMARY KEY, conversation_id TEXT, character_id TEXT, content TEXT, source TEXT, status TEXT, importance INTEGER, scope TEXT, evidence_message_ids_json TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE summaries (id TEXT PRIMARY KEY, conversation_id TEXT, content TEXT, covers_until_message_id TEXT, covers_from_message_id TEXT, status TEXT, created_at TEXT, tier TEXT, rolled_up_into TEXT, rel_character_id TEXT, rel_persona_id TEXT);
    CREATE TABLE lorebooks (id TEXT PRIMARY KEY, character_id TEXT, story_id TEXT);
    CREATE TABLE lore_entries (id TEXT PRIMARY KEY, lorebook_id TEXT, title TEXT, content TEXT, keywords_json TEXT, secondary_keys_json TEXT, selective INTEGER, always_on INTEGER, priority INTEGER, token_cap INTEGER, enabled INTEGER);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO settings VALUES ('token_calibration','1.0');
  `);
  db.prepare(`INSERT INTO personas VALUES (?,?,?,?,?,?,?,?,?)`).run(
    'p1', '유저', '호칭1', '외형1', '페르소나성격', '관계1', 1, '0001', '0001',
  );
  return db;
}

function convBase(over: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: 'conv1',
    character_id: 'c1',
    persona_id: 'p1',
    title: '',
    mode: 'chat',
    profile_name: 'rp-balanced',
    scene_json: '{"place":"광장"}',
    head_message_id: null,
    prompt_version: PROMPT_VERSION,
    favorite: 0,
    archived: 0,
    created_at: 't',
    updated_at: 't',
    last_message_at: 't',
    user_note: null,
    persona_name_snapshot: null,
    persona_address_snapshot: null,
    persona_appearance_snapshot: null,
    persona_personality_snapshot: null,
    persona_relationship_snapshot: null,
    persona_applied_at: null,
    story_id: null,
    story_applied_at: null,
    story_name_snapshot: null,
    story_setting_snapshot: null,
    story_minor_cast_snapshot: null,
    story_participant_ids_snapshot: null,
    story_opening_snapshot: null,
    story_endings_snapshot: null,
    ended_at: null,
    reached_ending_id: null,
    ...over,
  } as ConversationRow;
}

function msg(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  created_at: string,
  status: string = 'complete',
): MessageRow {
  return {
    id,
    conversation_id: 'conv1',
    parent_id: null,
    role,
    content,
    status,
    created_at,
    metadata_json: null,
  } as MessageRow;
}

function turns(b: ReturnType<typeof buildPrompt>) {
  return b.messages.filter((m) => m.role !== 'system');
}

function systemText(b: ReturnType<typeof buildPrompt>): string {
  return String(b.messages.find((m) => m.role === 'system')?.content ?? '');
}

/** web Message 픽스처 */
function wmsg(partial: Partial<Message> & Pick<Message, 'id' | 'role'>): Message {
  return {
    conversation_id: 'c',
    parent_id: null,
    content: partial.content ?? '',
    status: 'complete',
    meta: partial.meta ?? {},
    bookmarked: false,
    created_at: '',
    siblings: { index: 0, count: 1, ids: [partial.id] },
    ...partial,
  };
}

async function main() {
  const db = seed();
  const conv = convBase();
  const continueLine = substitute(CONTINUE_FALLBACK, '테스트캐', '유저');
  const greetingLine = substitute(GREETING_FALLBACK, '테스트캐', '유저');

  // --- buildPrompt: 현재 턴 ---

  await t('현재 턴이 빈 user → 모델 입력에 빈 user 발화 없음; 기존 이어가기 폴백이 끝을 메움', () => {
    const hist = [
      msg('m1', 'user', '안녕', '0001'),
      msg('m2', 'assistant', '반가워.', '0002'),
      msg('m3', 'user', '', '0003'), // inject-only 턴
    ];
    const b = buildPrompt(db, conv, hist, 8192, 'test-model', undefined, {
      inject: { instruction: `${INJECT_MARKER}: 오늘 일기를 써라.` },
    });
    const ts = turns(b);
    assert.equal(ts.some((m) => m.role === 'user' && !m.content.trim()), false, '빈 user 턴이 남아 있으면 안 된다');
    assert.equal(ts[ts.length - 1].role, 'user', '마지막 턴은 user 여야 한다');
    assert.equal(ts[ts.length - 1].content, continueLine, '기존 폴백 원문이어야 한다 (새 문구 금지)');
    assert.ok(systemText(b).includes(INJECT_MARKER), 'inject 지침은 그대로 전달');
  });

  await t('공백만 있는 현재 턴도 같은 처리', () => {
    const hist = [
      msg('m1', 'user', '안녕', '0001'),
      msg('m2', 'assistant', '반가워.', '0002'),
      msg('m3', 'user', '   \n  ', '0003'),
    ];
    const b = buildPrompt(db, conv, hist, 8192, 'test-model');
    const ts = turns(b);
    assert.equal(ts.some((m) => m.role === 'user' && !m.content.trim()), false);
    assert.equal(ts[ts.length - 1].content, continueLine);
  });

  await t('대화 첫 턴이 inject-only → 빈 user 대신 기존 인사 폴백', () => {
    const hist = [msg('m1', 'user', '', '0001')];
    const b = buildPrompt(db, conv, hist, 8192, 'test-model', undefined, {
      inject: { instruction: `${INJECT_MARKER}: 일기.` },
    });
    const ts = turns(b);
    assert.equal(ts.length, 1);
    assert.equal(ts[0].role, 'user');
    assert.equal(ts[0].content, greetingLine);
    assert.ok(systemText(b).includes(INJECT_MARKER));
  });

  // --- buildPrompt: 과거 오염 ---

  await t('과거의 빈 complete user 행은 최근 대화에서 제외된다 (라이브 3건 방어)', () => {
    const hist = [
      msg('m1', 'user', '', '0001'),
      msg('m2', 'assistant', '유키는 킥킥 웃었다.', '0002'),
      msg('m3', 'user', '', '0003'),
      msg('m4', 'assistant', '유키는 고개를 갸웃했다.', '0004'),
      msg('m5', 'user', '지금 뭐 해?', '0005'),
    ];
    const b = buildPrompt(db, conv, hist, 8192, 'test-model');
    const ts = turns(b);
    assert.equal(ts.some((m) => m.role === 'user' && !m.content.trim()), false, '과거 빈 user 도 제외');
    assert.equal(ts[ts.length - 1].content, '지금 뭐 해?', '진짜 현재 입력은 그대로');
    const flat = ts.map((m) => m.content).join('\n');
    assert.ok(flat.includes('유키는 킥킥 웃었다.'), 'assistant 응답은 남는다');
    assert.ok(flat.includes('유키는 고개를 갸웃했다.'));
  });

  await t('빈 complete user 만 있고 assistant 가 뒤따르는 경로 → 폴백 한 번만', () => {
    const hist = [
      msg('m1', 'assistant', '첫 인사.', '0001'),
      msg('m2', 'user', '', '0002'),
    ];
    const b = buildPrompt(db, conv, hist, 8192, 'test-model');
    const ts = turns(b);
    assert.equal(ts.filter((m) => m.content === continueLine).length, 1);
    assert.equal(ts.some((m) => !m.content.trim()), false);
  });

  // --- 회귀: 건드리면 안 되는 것 ---

  await t('일반 1:1 회귀: 내용 있는 user 는 그대로, 폴백 삽입 없음', () => {
    const hist = [
      msg('m1', 'user', '안녕', '0001'),
      msg('m2', 'assistant', '반가워.', '0002'),
      msg('m3', 'user', '오늘 뭐 했어?', '0003'),
    ];
    const b = buildPrompt(db, conv, hist, 8192, 'test-model');
    const ts = turns(b);
    assert.deepEqual(ts.map((m) => `${m.role}:${m.content}`), [
      'user:안녕',
      'assistant:반가워.',
      'user:오늘 뭐 했어?',
    ]);
    assert.equal(ts.some((m) => m.content === continueLine), false, '정상 턴에 폴백이 끼면 안 된다');
  });

  await t('trailing text 가 있는 명령은 사용자 발화로 그대로 전달된다', () => {
    const hist = [
      msg('m1', 'assistant', '첫 인사.', '0001'),
      msg('m2', 'user', '오늘 있었던 일을 정리해', '0002'),
    ];
    const b = buildPrompt(db, conv, hist, 8192, 'test-model', undefined, {
      inject: { instruction: `${INJECT_MARKER}: 일기 형식으로.` },
    });
    const ts = turns(b);
    assert.equal(ts[ts.length - 1].content, '오늘 있었던 일을 정리해');
    assert.equal(ts.some((m) => m.content === continueLine), false);
    assert.ok(systemText(b).includes(INJECT_MARKER));
    assert.equal(
      systemText(b).includes('오늘 있었던 일을 정리해'),
      false,
      '사용자 발화가 system 으로 새면 안 된다',
    );
  });

  await t('내용 있는 user 행은 status 와 무관하게 유지 (빈 것만 제외)', () => {
    const hist = [
      msg('m1', 'user', '중단된 입력', '0001', 'interrupted'),
      msg('m2', 'assistant', '응답.', '0002'),
      msg('m3', 'user', '계속', '0003'),
    ];
    const b = buildPrompt(db, conv, hist, 8192, 'test-model');
    assert.ok(turns(b).some((m) => m.content === '중단된 입력'));
  });

  await t('빈 assistant complete 행은 이 규칙의 대상이 아니다 (범위 가드)', () => {
    const hist = [
      msg('m1', 'user', '안녕', '0001'),
      msg('m2', 'assistant', '', '0002'),
      msg('m3', 'user', '뭐해', '0003'),
    ];
    const b = buildPrompt(db, conv, hist, 8192, 'test-model');
    assert.equal(
      turns(b).some((m) => m.role === 'assistant' && m.content === ''),
      true,
      'assistant 빈 행 처리는 건드리지 않았다',
    );
  });

  // --- web: UI 목록 계약 ---

  await t('isEmptyUserMessage: role=user 이고 공백뿐일 때만 참', () => {
    assert.equal(isEmptyUserMessage(wmsg({ id: 'u1', role: 'user', content: '' })), true);
    assert.equal(isEmptyUserMessage(wmsg({ id: 'u2', role: 'user', content: '   \n ' })), true);
    assert.equal(isEmptyUserMessage(wmsg({ id: 'u3', role: 'user', content: '안녕' })), false);
    assert.equal(isEmptyUserMessage(wmsg({ id: 'a1', role: 'assistant', content: '' })), false);
    assert.equal(
      isEmptyUserMessage(wmsg({ id: 'a2', role: 'assistant', content: '', status: 'streaming' })),
      false,
      'assistant 스트리밍 빈 행은 ▍ 커서 자리 — 숨기면 안 된다',
    );
  });

  await t('visibleChatMessages: 빈 user 만 빠지고 나머지 순서는 그대로', () => {
    const list = [
      wmsg({ id: 'u1', role: 'user', content: '' }),
      wmsg({ id: 'a1', role: 'assistant', content: '유키는 킥킥 웃었다.' }),
      wmsg({ id: 'u2', role: 'user', content: '지금 뭐 해?' }),
      wmsg({ id: 'a2', role: 'assistant', content: '', status: 'streaming' }),
    ];
    assert.deepEqual(visibleChatMessages(list).map((m) => m.id), ['a1', 'u2', 'a2']);
    assert.deepEqual(list.map((m) => m.id), ['u1', 'a1', 'u2', 'a2'], '원본 배열은 변형되지 않는다');
  });

  await t('빈 user 행만 있는 대화는 표시상 비어 있다 (빈 말풍선·간격 없음)', () => {
    const list = [wmsg({ id: 'u1', role: 'user', content: '' })];
    assert.equal(visibleChatMessages(list).length, 0);
  });

  await t('groupChatTurns(visible): 빈 user 턴은 assistant 만 남고 user 슬롯은 비어 있다', () => {
    const list = visibleChatMessages([
      wmsg({ id: 'u1', role: 'user', content: '' }),
      wmsg({ id: 'a1', role: 'assistant', content: '서술', meta: { block_kind: 'narration' } }),
      wmsg({ id: 'a2', role: 'assistant', content: '대사', meta: { block_kind: 'line' } }),
    ]);
    const grouped = groupChatTurns(list);
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0].user, null, 'user 슬롯이 비어야 빈 말풍선이 안 그려진다');
    assert.deepEqual(grouped[0].assistants.map((m) => m.id), ['a1', 'a2']);
  });

  await t('groupChatTurns 회귀: 내용 있는 user 는 계속 턴을 연다', () => {
    const list = visibleChatMessages([
      wmsg({ id: 'u1', role: 'user', content: '안녕' }),
      wmsg({ id: 'a1', role: 'assistant', content: '응답' }),
    ]);
    const grouped = groupChatTurns(list);
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0].user?.id, 'u1');
  });

  await t('ChatPage 가 표시 목록과 MessageView 양쪽에 방어를 건다 (소스 계약)', () => {
    const src = fs.readFileSync('apps/web/src/pages/ChatPage.tsx', 'utf8');
    assert.ok(src.includes('visibleChatMessages(chat.messages)'), '목록 단계 필터가 주 방어');
    assert.ok(src.includes('groupChatTurns(shownMessages)'), 'turn grouping 도 표시 목록을 쓴다');
    assert.ok(/if \(isEmptyUserMessage\(m\)\) return null;/.test(src), 'MessageView 보조 방어');
    assert.ok(src.includes(`return props.streaming ? '' : <span className="muted">…</span>;`),
      '… 폴백 자체는 남겨 둔다 — 빈 user 를 그 앞에서 거르는 방식');
  });

  // --- Fastify: inject-only end-to-end ---

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-empty-turn-'));
  const liveDb = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
  liveDb
    .prepare(
      `INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes) VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run('rp-balanced', null, 0.8, 0.95, 400, '[]', 'system', null);

  const streamChunks = ['「오늘은', ' 조용했어.」'];
  const capturedParams: GenParams[] = [];
  const capture = (p: GenParams) => {
    capturedParams.push({
      model: p.model,
      messages: p.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: p.temperature,
      top_p: p.top_p,
      max_tokens: p.max_tokens,
      stop: p.stop,
    });
  };
  const model = {
    stream: async (p: GenParams, onToken: (delta: string) => void): Promise<GenResult> => {
      capture(p);
      for (const c of streamChunks) {
        onToken(c);
        await new Promise((r) => setImmediate(r));
      }
      return {
        text: streamChunks.join(''),
        finishReason: 'stop',
        usage: { prompt_tokens: 12, completion_tokens: 8 },
        ttftMs: 1,
        totalMs: 2,
      };
    },
    complete: async (p: GenParams): Promise<GenResult> => {
      capture(p);
      const prompt = String(p.messages?.[0]?.content ?? '');
      if (prompt.includes('장면 진행 판정기')) {
        return { text: '{"base_version":0}', finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 1 };
      }
      if (prompt.includes('서술') || prompt.includes('군중') || prompt.startsWith('당신은 카메라')) {
        return { text: '교실이 조용해졌다.', finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 2 };
      }
      return { text: '"조용하네."', finishReason: 'stop', usage: null, ttftMs: 1, totalMs: 2 };
    },
    listModels: async () => ['test-model'],
  };

  const ctx = {
    db: liveDb,
    model: model as unknown as Ctx['model'],
    queue: new GenerationQueue(1),
    log: { error() {}, info() {}, warn() {}, debug() {} } as unknown as Ctx['log'],
    resolvedModel: () => 'test-model',
    setResolvedModel: () => {},
    health: async () => ({ ok: true, checkedAt: 't', latencyMs: 0, models: ['test-model'] }),
  } as Ctx;

  const app = Fastify({ logger: false });
  await app.register(characterRoutes(ctx));
  await app.register(storyRoutes(ctx));
  await app.register(conversationRoutes(ctx));
  await app.register(chatRoutes(ctx));
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.addresses()[0] as { port: number };
  const origin = `http://127.0.0.1:${addr.port}`;

  async function api(method: string, url: string, body?: unknown) {
    const res = await fetch(`${origin}${url}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = text;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json, text };
  }

  const charRes = await api('POST', '/api/characters', {
    name: '나리',
    personality: '교실에서 장난을 치지만 친구를 챙긴다. 반말.',
    first_message: '*창가에 기대어 웃었다.* 「{{user}}, 또 늦었네.」',
    description: '2학년. 짧은 단발.',
    speech_style: '반말, 짧게.',
    scenario: '방과 후 교실',
    example_dialogue: '',
    taboos: '사용자를 대신해 말하지 않는다.',
    tagline: '창가의 2학년',
    tags: [],
  });
  assert.equal(charRes.status, 201, charRes.text);
  const soloChar = charRes.json as { id: string; name: string };

  const personaRes = await api('POST', '/api/personas', {
    name: '하준',
    personality: '과묵한 전학생.',
    address_as: '하준아',
    appearance: '회색 후드',
    relationship: '같은 반',
    is_default: true,
  });
  assert.equal(personaRes.status, 201, personaRes.text);
  const persona = personaRes.json as { id: string };

  await t('API 1:1 inject-only: 모델이 빈 user 발화를 받지 않고 inject 는 전달된다', async () => {
    const convRes = await api('POST', '/api/conversations', {
      characterId: soloChar.id,
      personaId: persona.id,
      mode: 'chat',
      title: 'empty-turn-1to1',
    });
    assert.equal(convRes.status, 201, convRes.text);
    const c = (convRes.json as { id: string }).id;

    // 먼저 정상 턴 하나 — 현재 턴 폴백이 인사 폴백과 구분되게 한다.
    const warm = await fetch(`${origin}/api/conversations/${c}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '안녕, 오늘 어땠어?' }),
    });
    assert.equal(warm.status, 200, await warm.clone().text());
    await warm.text();

    capturedParams.length = 0;
    const res = await fetch(`${origin}/api/conversations/${c}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '', inject_instruction: `${INJECT_MARKER}: 오늘 일기를 써라.` }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    const events = parseSse(await res.text());
    assert.ok(events.some((e) => e.type === 'done'), 'done missing');

    assert.deepEqual(emptyUserTurns(capturedParams), [], '빈 user 발화가 모델에 가면 안 된다');
    const flat = flattenGenMessages(capturedParams);
    assert.ok(flat.includes(INJECT_MARKER), 'inject 지침은 이 생성 턴에 전달되어야 한다');
    assert.ok(
      flat.includes(substitute(CONTINUE_FALLBACK, soloChar.name, '하준')),
      '현재 턴은 기존 이어가기 폴백으로 대체된다',
    );
  });

  await t('API 1:1 trailing text: 사용자 발화로 저장·전달되고 명령 본문은 새지 않는다', async () => {
    const convRes = await api('POST', '/api/conversations', {
      characterId: soloChar.id,
      personaId: persona.id,
      mode: 'chat',
      title: 'empty-turn-trailing',
    });
    const c = (convRes.json as { id: string }).id;
    const spoken = '오늘 있었던 일을 정리해';

    capturedParams.length = 0;
    const res = await fetch(`${origin}/api/conversations/${c}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: spoken, inject_instruction: `${INJECT_MARKER}: 일기 형식.` }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    await res.text();

    assert.deepEqual(emptyUserTurns(capturedParams), []);
    const flat = flattenGenMessages(capturedParams);
    assert.ok(flat.includes(spoken), '사용자 발화가 모델에 전달되어야 한다');

    const detail = await api('GET', `/api/conversations/${c}`);
    const msgs = (detail.json as { messages: Array<{ role: string; content: string }> }).messages;
    assert.ok(msgs.some((m) => m.role === 'user' && m.content === spoken), '사용자 발화는 그대로 저장');
    assert.ok(!JSON.stringify(msgs).includes(INJECT_MARKER), '명령 본문은 저장되지 않는다');
  });

  await t('API 1:1 회귀: inject 없는 빈 content 는 여전히 400', async () => {
    const convRes = await api('POST', '/api/conversations', {
      characterId: soloChar.id,
      personaId: persona.id,
      mode: 'chat',
      title: 'empty-turn-400',
    });
    const c = (convRes.json as { id: string }).id;
    const res = await api('POST', `/api/conversations/${c}/messages`, { content: '   ' });
    assert.equal(res.status, 400, res.text);
  });

  // --- 파티 경로 회귀 ---

  const CATALOG = {
    places: [{ id: '교실', name: 'S반 교실', default_focus: 'nari' }, { id: '사무실' }],
    weathers: ['맑음'],
    arcs: ['entry'],
    stagesByArc: { entry: ['reg', 'class'] },
    flags: { rulebreak: { owner_stage: 'reg', owner_duty: '교칙' } },
    stages: { class: { closer_duty: '수업' } },
    outfits: ['교복'],
    emotions: { '😡': 8, '🙂': 2 },
    duties: { 교칙: { slot: '질서' } },
  };

  const mkPartyChar = async (name: string, tags: string[]) => {
    const res = await api('POST', '/api/characters', { name, personality: `${name} 성격`, first_message: '', tags });
    assert.equal(res.status, 201, res.text);
    return res.json as { id: string; name: string };
  };

  const nari = await mkPartyChar('빈턴나리', ['party:duty=이야기', 'party:place=교실', 'party:outfit=교복']);
  const sera = await mkPartyChar('빈턴세라', ['party:duty=교칙', 'party:place=교실', 'party:outfit=교복']);
  const hayeon = await mkPartyChar('빈턴하연', ['party:duty=수업', 'party:place=교실', 'party:outfit=교복']);

  const storyRes = await api('POST', '/api/stories', {
    name: '빈턴-파티',
    tagline: 'S반',
    setting: '교실',
    minor_cast: [],
    scene_catalog: CATALOG,
  });
  assert.equal(storyRes.status, 201, storyRes.text);
  const story = storyRes.json as { id: string };
  for (const [id, order] of [[hayeon.id, 0], [nari.id, 1], [sera.id, 2]] as const) {
    const add = await api('POST', `/api/stories/${story.id}/characters`, { characterId: id, sortOrder: order });
    assert.equal(add.status, 201, add.text);
  }

  await t('파티 inject-only 회귀: IC pass 어디에도 빈 user 발화가 없고 inject 는 전달된다', async () => {
    const startRes = await api('POST', '/api/conversations', {
      characterId: hayeon.id,
      storyId: story.id,
      mode: 'story',
    });
    assert.equal(startRes.status, 201, startRes.text);
    const c = (startRes.json as { id: string }).id;

    capturedParams.length = 0;
    const res = await fetch(`${origin}/api/conversations/${c}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '', inject_instruction: `${INJECT_MARKER}: 파티 일기.` }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    const events = parseSse(await res.text());
    assert.ok(events.some((e) => e.type === 'done'), 'done missing');

    assert.deepEqual(emptyUserTurns(capturedParams), [], '파티 IC pass 에도 빈 user 발화가 없어야 한다');
    assert.ok(flattenGenMessages(capturedParams).includes(INJECT_MARKER), '파티 IC pass 는 inject 를 계속 받는다');
  });

  await app.close();
  liveDb.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  db.close();
  console.log(`PASS=${passed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
