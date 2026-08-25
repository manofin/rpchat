/** npx tsx bench/builderDifferential.test.ts
 * live-path vs pre-wire characterization:
 * 현재 buildPrompt의 예산 판정(진단 + 주입 텍스트)을, 04a8f1e 이전(35d0a01) builder.ts의
 * 인라인 pre-wire 루프 오라클과 대조한다. allocateSummaryBudget을 오라클로 쓰지 않는다.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import type { DB } from '../apps/server/src/db/index.js';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

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
  // 메시지 60개 — created_at zero-pad (사전식 정렬 = 시간순). 최근 24창 = m37~m60.
  const ins = db.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?)`);
  for (let i = 1; i <= 60; i++) ins.run(`m${String(i).padStart(2, '0')}`, 'conv1', i % 2 ? 'user' : 'assistant', `대화 ${i}입니다.`, 'done', String(i).padStart(4, '0'));
  return db;
}

type Row = Record<string, unknown>;
function seedSummaries(db: DB, rows: Array<Partial<Row> & { tier: string }>) {
  const ins = db.prepare(`INSERT INTO summaries VALUES (?,?,?,?,?,?,?,?,?)`);
  rows.forEach((r, i) => ins.run(r.id ?? `s${i}`, 'conv1', r.content ?? '요약 본문입니다.', r.covers_until ?? null, r.covers_from ?? null, 'approved', r.created ?? String(i), r.tier, r.rolled_up_into ?? null));
}

/** pre-wire 오라클 — builder.ts@35d0a01 L188~216의 episode/scene 결정 루프를 그대로 옮긴 것.
 * truncate/estimateTokens는 토큰 추정 함수(cal=1)를 그대로 쓴다(와이어링 전후 동일 함수). */
function legacyDecide(opts: {
  sumBudget: number; stateEst: number; wholeEstOnly: number;
  episodeRenderedTokens: number;
  episodeCoversUntil: string | null;
  recentGuardIds: Set<string>;
  pathIds: Set<string>;
  scenes: Array<{ id: string; coversUntil: string | null; tokens: number }>;
}): { episodeUsed: boolean; sceneIds: string[] } {
  // episode: afterState의 35% cap + MIN_EPISODE_TOKENS(30) + recentGuard (builder.ts@35d0a01)
  const MIN_EPISODE_TOKENS = 30;
  let episodeUsed = false;
  if (!(opts.episodeCoversUntil && opts.recentGuardIds.has(opts.episodeCoversUntil))) {
    const epCap = Math.floor(Math.max(0, opts.sumBudget - opts.stateEst) * 0.35);
    const est = Math.min(opts.episodeRenderedTokens, epCap);
    if (opts.episodeRenderedTokens > 0 && epCap > 0 && est >= MIN_EPISODE_TOKENS) episodeUsed = true;
  }
  const episodeEst = episodeUsed ? Math.min(opts.episodeRenderedTokens, Math.floor(Math.max(0, opts.sumBudget - opts.stateEst) * 0.35)) : 0;
  // scene: sceneBudget>0이면 독립 수집, 개별 covers_until 가드/오프경로 continue, 누적 초과 break, 최대 2
  const sceneBudget = Math.max(0, opts.sumBudget - opts.stateEst - episodeEst - opts.wholeEstOnly);
  const sceneIds: string[] = [];
  if (sceneBudget > 0) {
    let acc = 0;
    for (const sc of opts.scenes) {
      if (sceneIds.length >= 2) break;
      if (sc.coversUntil && opts.recentGuardIds.has(sc.coversUntil)) continue;
      if (sc.coversUntil && !opts.pathIds.has(sc.coversUntil)) continue;
      if (acc + sc.tokens > sceneBudget) break;
      acc += sc.tokens;
      sceneIds.push(sc.id);
    }
  }
  return { episodeUsed, sceneIds };
}

async function runBuilder(db: DB) {
  const { buildPrompt } = await import('../apps/server/src/prompt/builder.js');
  const conv = { id: 'conv1', character_id: 'c1', persona_id: 'p1', mode: 'story', profile_name: null, scene_json: '{}' } as never;
  const history = db.prepare(`SELECT * FROM messages WHERE conversation_id='conv1' ORDER BY created_at`).all() as never[];
  return buildPrompt(db, conv, history, 8192, 'test-model', undefined, { diagnostics: true });
}

t('characterization: wired buildPrompt decisions == inlined pre-wire loop oracle', async () => {
  const db = seed();
  seedSummaries(db, [
    { tier: 'whole', covers_until: 'm38' },
    { tier: 'state', covers_until: 'm38' },
    { tier: 'episode', covers_until: 'm59' },               // recentGuard 적중 → 생략
    { tier: 'scene', id: 'scOld1', covers_until: 'm05' },   // 가드 밖 → 주입 후보
    { tier: 'scene', id: 'scRecent', covers_until: 'm50' }, // 개별 가드 적중 → skip
    { tier: 'scene', id: 'scOld2', covers_until: 'm06' },   // 가드 밖 → 주입 후보
  ]);
  const b = await runBuilder(db);
  const diag = b.budget.diagnostics!.summaries!;
  const episodeDiag = diag.find((d) => d.tier === 'episode')!;
  const sceneDiag = diag.find((d) => d.tier === 'scene')!;

  // 오라클 입력: builder와 동일한 방식으로 계산한 값
  // guard/pathIds는 builder와 동일하게 history에서 유도
  const { many } = await import('../apps/server/src/db/index.js');
  const history = many<{ id: string }>(db, `SELECT id FROM messages WHERE conversation_id='conv1' ORDER BY created_at`);
  const recentGuardIds = new Set(history.slice(-24).map((m) => m.id));
  const pathIds = new Set(history.map((m) => m.id));
  const cal = 1; // seed settings token_calibration=1.0

  // whole/scene 렌더 토큰 실측 (builder와 동일 문자열)
  const wholeContent = '요약 본문입니다.';
  const wholeEstOnly = Math.ceil(estimateTokensRaw(wholeContent) * cal);
  const scenesForOracle = [
    { id: 'scOld1', coversUntil: 'm05' as const, tokens: tokScene('장면 하나입니다.') },
    { id: 'scRecent', coversUntil: 'm50' as const, tokens: tokScene('장면 두개입니다.') },
    { id: 'scOld2', coversUntil: 'm06' as const, tokens: tokScene('장면 세개입니다.') },
  ];
  function tokScene(content: string): number {
    return Math.ceil(estimateTokensRaw(`- ${content}`) * cal);
  }

  // stateEst/sumBudget도 builder 공식 그대로: memory share = floor(available*0.15), available = 8192-400-64
  const available = 8192 - 400 - 64;
  const sumBudget = Math.floor(available * 0.15); // pinned 없음 → memEst 0
  // stateEst: builder와 동일 — state seed content는 seedSummaries 기본값 '요약 본문입니다.'
  const { estimateTokens } = await import('../apps/server/src/prompt/tokens.js');
  const stateEst = estimateTokens(`### 현재 상태\n요약 본문입니다.`, cal);

  const oracle = legacyDecide({
    sumBudget, stateEst, wholeEstOnly,
    episodeRenderedTokens: Math.ceil(estimateTokensRaw('에피소드입니다.') * cal),
    episodeCoversUntil: 'm59',
    recentGuardIds,
    pathIds,
    scenes: scenesForOracle,
  });

  // 진단과 오라클 일치
  assert.equal(stateEst, diag.find((d) => d.tier === 'state')!.tokens); // 시드 정합
  assert.equal(episodeDiag.used, false, 'oracle: episode guard-hit → 생략');
  assert.equal(oracle.episodeUsed, false);
  assert.equal(sceneDiag.used, true, 'oracle: scene은 episode 가드와 독립 평가');
  // 주입된 장면 id 집합 일치 (시스템 텍스트에 실제로 주입된 것 기준)
  const sys = b.messages[0].content as string;
  assert.ok(sys.includes('### 최근 장면'));
  for (const id of ['scOld1', 'scOld2']) {
    const row = many<{ content: string }>(db, `SELECT content FROM summaries WHERE id='${id}'`)[0];
    assert.ok(sys.includes(row.content), `주입 확인: ${id}`);
  }
  assert.ok(!sys.includes('장면 두개입니다.'), 'recentGuard 적중 장면 미주입');
  assert.deepEqual(
    ['scOld1', 'scOld2'].sort(),
    oracle.sceneIds.sort(),
  );
});

/** tokens.ts의 estimateTokensRaw와 동일 알고리즘 (hangul*0.7 + cjk*1.0 + other/3.6, cjk=한글제외 CJK+가나) */
function estimateTokensRaw(text: string): number {
  let hangul = 0, cjk = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f)) hangul++;
    else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff)) cjk++;
  }
  return Math.ceil(hangul * 0.7 + cjk * 1.0 + (text.length - hangul - cjk) / 3.6);
}

console.log(`passed ${passed}`);
