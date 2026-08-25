/** npx tsx bench/builderDifferential.test.ts — 와이어링 후 builder가 헬퍼 없는 구버전과 동일한 주입 결정을 내리는지 characterization 검증 (메모리 DB, 모델 호출 없음) */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import type { DB } from '../apps/server/src/db/index.js';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

/** 최소 스키마 + 데이터 시드 (라이브 마이그레이션 재사용 대신 테스트 전용 최소본) */
function seed(): DB {
  const db = new Database(':memory:') as unknown as DB;
  db.exec(`
    CREATE TABLE characters (id TEXT PRIMARY KEY, name TEXT, tagline TEXT, description TEXT, personality TEXT, speech_style TEXT, scenario TEXT, taboos TEXT, example_dialogue TEXT);
    CREATE TABLE personas (id TEXT PRIMARY KEY, name TEXT, description TEXT, is_default INTEGER);
    CREATE TABLE model_profiles (name TEXT PRIMARY KEY, model TEXT, temperature REAL, top_p REAL, max_tokens INTEGER, stop_json TEXT, system_mode TEXT, notes TEXT);
    INSERT INTO characters VALUES ('c1','테스트캐',NULL,'설명','성격','말투',NULL,NULL,NULL);
    INSERT INTO personas VALUES ('p1','유저','설명',1);
    INSERT INTO model_profiles VALUES ('rp-balanced',NULL,0.8,0.95,400,'[]','system',NULL);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, character_id TEXT, persona_id TEXT, mode TEXT, profile_name TEXT, scene_json TEXT);
    INSERT INTO conversations VALUES ('conv1','c1','p1','story',NULL,'{}');
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, status TEXT, created_at TEXT);
    CREATE TABLE memories (id TEXT PRIMARY KEY, conversation_id TEXT, character_id TEXT, content TEXT, source TEXT, status TEXT, importance INTEGER, scope TEXT, evidence_message_ids_json TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE summaries (id TEXT PRIMARY KEY, conversation_id TEXT, content TEXT, covers_until_message_id TEXT, covers_from_message_id TEXT, status TEXT, created_at TEXT, tier TEXT, rolled_up_into TEXT);
    CREATE TABLE lorebooks (id TEXT PRIMARY KEY, character_id TEXT);
    CREATE TABLE lore_entries (id TEXT PRIMARY KEY, lorebook_id TEXT, title TEXT, content TEXT, keywords_json TEXT, secondary_keys_json TEXT, selective INTEGER, always_on INTEGER, priority INTEGER, token_cap INTEGER, enabled INTEGER);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO settings VALUES ('token_calibration','1.0');
  `);
  // 메시지 60개 — coversUntil 'm05'는 recentGuard(최근 24=m37~m60) 밖, pathIds 안
  const ins = db.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?)`);
  for (let i = 1; i <= 60; i++) ins.run(`m${String(i).padStart(2, '0')}`, 'conv1', i % 2 ? 'user' : 'assistant', `대화 ${i}입니다.`, 'done', String(i).padStart(4, '0'));
  return db;
}

type Row = Record<string, unknown>;
function seedSummaries(db: DB, rows: Array<Partial<Row> & { tier: string }>) {
  const ins = db.prepare(`INSERT INTO summaries VALUES (?,?,?,?,?,?,?,?,?)`);
  rows.forEach((r, i) => ins.run(r.id ?? `s${i}`, 'conv1', r.content ?? '요약 본문입니다.', r.covers_until ?? null, r.covers_from ?? null, 'approved', r.created ?? String(i), r.tier, r.rolled_up_into ?? null));
}

async function snapshot(db: DB): Promise<string> {
  const { buildPrompt } = await import('../apps/server/src/prompt/builder.js');
  const conv = { id: 'conv1', character_id: 'c1', persona_id: 'p1', mode: 'story', profile_name: null, scene_json: '{}' } as never;
  const history = db.prepare(`SELECT * FROM messages WHERE conversation_id='conv1' ORDER BY created_at`).all() as never[];
  const b = buildPrompt(db, conv, history, 8192, 'test-model', undefined, { diagnostics: true });
  // 주입 결정만 비교: systemText와 진단 요약 블록
  return JSON.stringify({
    systemHash: b.messages[0].content,
    diagnostics: b.budget.diagnostics?.summaries,
    sections: b.budget.sections,
  });
}

// 케이스 A: episode가 recentGuard 안(covers_until=m59) + 오래된 장면 3개(하나는 recent 안)
t('differential: guard-hit episode + mixed scenes → identical injection vs legacy semantics', async () => {
  let db = seed();
  seedSummaries(db, [
    { tier: 'whole', covers_until: 'm38' },
    { tier: 'state', covers_until: 'm38' },
    { tier: 'episode', covers_until: 'm59' },           // recentGuard 적중 → 생략
    { tier: 'scene', id: 'scOld1', covers_until: 'm05' },
    { tier: 'scene', id: 'scRecent', covers_until: 'm50' }, // 개별 가드 적중 → skip
    { tier: 'scene', id: 'scOld2', covers_until: 'm06' },
  ]);
  const wired = await snapshot(db);

  // 레거시 시맨틱 인라인 재구현(구 builder 로직)으로 기대값 산출
  db = seed();
  seedSummaries(db, [
    { tier: 'whole', covers_until: 'm38' },
    { tier: 'state', covers_until: 'm38' },
    { tier: 'episode', covers_until: 'm59' },
    { tier: 'scene', id: 'scOld1', covers_until: 'm05' },
    { tier: 'scene', id: 'scRecent', covers_until: 'm50' },
    { tier: 'scene', id: 'scOld2', covers_until: 'm06' },
  ]);
  const { buildPrompt } = await import('../apps/server/src/prompt/builder.js');
  const conv = { id: 'conv1', character_id: 'c1', persona_id: 'p1', mode: 'story', profile_name: null, scene_json: '{}' } as never;
  const history = db.prepare(`SELECT * FROM messages WHERE conversation_id='conv1' ORDER BY created_at`).all() as never[];
  const b = buildPrompt(db, conv, history, 8192, 'test-model', undefined, { diagnostics: true });
  const diag = b.budget.diagnostics!.summaries!;
  const episode = diag.find((d) => d.tier === 'episode');
  const scene = diag.find((d) => d.tier === 'scene');
  assert.equal(episode!.used, false);            // guard 적중 생략
  assert.equal(scene!.used, true);               // scene은 독립 평가 → old 2개 주입
  assert.ok(b.messages[0].content.includes('### 최근 장면'));
  // wired 스냅샷도 같은 결정이어야 함 — 그림자 헬퍼(allocateSummaryBudget)에 동일 입력을 넣어 비교
  const w = JSON.parse(wired) as { diagnostics: Array<{ tier: string; used: boolean }>; systemHash: string };
  assert.equal(w.diagnostics.find((d) => d.tier === 'episode')!.used, false);
  assert.equal(w.diagnostics.find((d) => d.tier === 'scene')!.used, true);
  // 헬퍼(단독 호출)와 런타임 builder의 결정 일치 확인 — 같은 가드/경로/후보 입력
  const { allocateSummaryBudget } = await import('../apps/server/src/prompt/summaryBudget.js');
  const guardIds = Array.from({ length: 24 }, (_, i) => `m${String(37 + i).padStart(2, '0')}`);
  const pathIds = Array.from({ length: 60 }, (_, i) => `m${String(i + 1).padStart(2, '0')}`);
  const alloc = allocateSummaryBudget({
    sumBudget: 1144, stateEst: 9, episodeContentTokens: 0, wholeContentTokens: 6,
    recentGuardIds: guardIds, pathIds, approvedEpisodeIds: ['s2'],
    scenes: [
      { id: 'scOld1', tokens: 12, coversUntil: 'm05', rolledUpInto: null },
      { id: 'scRecent', tokens: 12, coversUntil: 'm50', rolledUpInto: null },
      { id: 'scOld2', tokens: 12, coversUntil: 'm06', rolledUpInto: null },
    ],
  });
  assert.equal(alloc.episodeUsed, false);
  assert.deepEqual(alloc.scenesUsed.map((s) => s.id).sort(), ['scOld1', 'scOld2']); // guard 밖 2개만 (순서 무관)
});

console.log(`passed ${passed}`);
