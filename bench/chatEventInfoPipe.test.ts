/** npx tsx bench/chatEventInfoPipe.test.ts
 * 코드-S2: 이름 부분에 ':'/'：'가 남는 INFO 파이프 줄은 화자 줄로 보지 않는다.
 * 실제 대진라 인사말 원문(라이브 DB SELECT-only에서 읽어 벤치 리터럴로 복사)을
 * defaultActor=화령으로 변환해, 가짜 화자가 0개인지 확인한다.
 *
 * Isolation: 임시 DATA_DIR(mkdtemp)과 인메모리 SQLite만 사용; 실모델·라이브 DB·네트워크 없음.
 * 인사말은 이 파일 안의 리터럴이다(라이브 DB는 SELECT-only로 1회 읽어 복사).
 * Regression control: 판정을 원래대로 되돌리면 이 bench가 실패한다.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adaptChatEvents } from '../apps/server/src/contracts/chatEventAdapter.ts';
import { messageEvents } from '../apps/server/src/db/tree.ts';
import { openMigratedDb } from '../apps/server/src/db/index.ts';
import type { EventActor } from '../apps/server/src/contracts/chatEventAdapter.ts';

let passed = 0;
async function t(name: string, check: () => void) {
  check();
  console.log(`ok ${++passed} ${name}`);
}

// 대진라 인사말 원문 — 라이브 DB(rpchat.db, SELECT-only)에서 읽어 리터럴로 복사.
// 출처: stories.opening_json.greeting (id 05f266dc-8e7d-4acd-9ed3-c6393bb642ce).
const GREETING = `옅은 금빛 구름 위에 작은 안내 책상이 놓여 있다. 흰 선녀옷을 입은 금발의 여신이 종이 몇 장을 반듯하게 맞춘다.

화령｜“어서 와! 나는 화령, 만물의 여신이야. 이번에는 설명부터 차근차근 할게. 새 세계에서 기억을 유지한 채 살아갈 수 있고, 능력이나 물건 하나를 가져갈 수 있어. 물론 먼저 네 생각을 들어야지.”

화령은 대진라 제국의 지도를 펼치며 내륙 도시 서라운을 가리킨다.

화령｜“출발지는 자유지만 여긴 유사단이 있어서 첫걸음을 배우기 좋아. 어떤 삶을 시작하고 싶어? 가져갈 능력과 조건부터 함께 정해 볼까?”

[INFO]
날짜·시간: 천개 1341년 3월 12일 09:00 / 1일차
장소: 천계·환생 안내소
직업·능력: 미정 | 경지: 불 | 경험치: 0/100
일정: 능력·제약 합의, 환생 의사와 출발지 확인
관계: 화령—첫 만남; 설화린·양월아—미조우
가방·소지금: 없음`;

const HARYEONG: EventActor = { id: 'c1748ea3-b078-4161-baae-bad9d5e7e6f3', name: '화령' };

t('INFO pipe line "직업·능력: 미정 | 경지: 불 | 경험치: 0/100" is narration, not a speaker line', () => {
  const events = adaptChatEvents({ id: 'm', role: 'assistant', content: GREETING }, { defaultActor: HARYEONG, actors: [HARYEONG] });
  const dialogues = events.filter((e) => e.type === 'dialogue');
  assert.equal(dialogues.length, 2, `화령 인용 대사 2개가 남아야 한다: ${dialogues.length}`);
  assert.ok(dialogues.every((e) => e.actorName === '화령'));
  const fakeSpeaker = dialogues.filter((e) => {
    const n = e.actorName ?? '';
    return n.includes(':') || n.includes('：');
  });
  assert.equal(fakeSpeaker.length, 0, `콜론이 든 가짜 화자가 없어야 한다: ${JSON.stringify(fakeSpeaker)}`);
});

t('INFO pipe line resolves to narration (verbatim pipe text survives)', () => {
  const events = adaptChatEvents({ id: 'm', role: 'assistant', content: '직업·능력: 미정 | 경지: 불 | 경험치: 0/100' }, { defaultActor: HARYEONG, actors: [HARYEONG] });
  const narrations = events.filter((e) => e.type === 'narration');
  assert.equal(narrations.length, 1);
  assert.match(narrations[0].text, /직업·능력: 미정/);
});

t('화령 | "..." (ASCII pipe) stays a 화령 dialogue', () => {
  const events = adaptChatEvents({ id: 'm', role: 'assistant', content: '화령 | "어서 와!"' }, { defaultActor: HARYEONG, actors: [HARYEONG] });
  assert.deepEqual(events.map((e) => e.type), ['dialogue']);
  assert.equal(events[0].actorId, HARYEONG.id);
});

t('[낯선 사람] : "..." keeps actorId null and preserves the name (fixture-05 contract)', () => {
  const events = adaptChatEvents({ id: 'm', role: 'assistant', content: '[낯선 사람] : "실례합니다."' }, { defaultActor: HARYEONG, actors: [HARYEONG] });
  assert.deepEqual(events.map((e) => e.type), ['dialogue']);
  assert.equal(events[0].actorId, null);
  assert.equal(events[0].actorName, '낯선 사람');
});

t('[아리]: "..." with a trailing colon is still speaker 아리', () => {
  const events = adaptChatEvents({ id: 'm', role: 'assistant', content: '[아리]: "반가워."' }, { defaultActor: HARYEONG, actors: [HARYEONG] });
  assert.deepEqual(events.map((e) => e.type), ['dialogue']);
  assert.equal(events[0].actorName, '아리');
});

t('middle fullwidth ： colon in the name is NOT a speaker (falls to narration path)', () => {
  const events = adaptChatEvents({ id: 'm', role: 'assistant', content: '경지：불 | "대사"' }, { defaultActor: HARYEONG, actors: [HARYEONG] });
  const fake = events.filter((e) => e.type === 'dialogue' && (e.actorName ?? '').includes('：'));
  assert.equal(fake.length, 0);
});

t("fullwidth ｜ line keeps current behavior — 화령｜ prefix is narration, quote is defaultActor dialogue", () => {
  const events = adaptChatEvents({ id: 'm', role: 'assistant', content: '화령｜"어서 와!"' }, { defaultActor: HARYEONG, actors: [HARYEONG] });
  // 현재 동작 고정(전각 ｜ 지원은 범위 밖): ｜는 화자 구분자가 아니므로
  // '화령｜' 앞부분은 narration으로 남고, 인용 대사는 defaultActor(화령)가 된다.
  assert.deepEqual(events.map((e) => e.type), ['narration', 'dialogue']);
  assert.equal(events[0].type === 'narration' ? events[0].text : '', '화령｜');
  const dialogue = events.find((e) => e.type === 'dialogue')!;
  assert.equal(dialogue.actorId, HARYEONG.id);
  assert.equal(dialogue.actorName, '화령');
});

t('messageEvents returns the stored v1 snapshot verbatim (existing rooms not re-interpreted)', () => {
  // 저장본 경로(tree.ts messageEvents): meta.chat_event_version=1 + 유효 events면
  // 본문을 다시 파싱하지 않고 저장된 이벤트 배열을 그대로 돌려준다.
  // 가짜 화자가 든 저장 events가 있어도 재해석하지 않는다.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpchat-info-pipe-'));
  const db = openMigratedDb(tmp, path.resolve('apps/server/migrations'));
  try {
    db.prepare("INSERT INTO characters (id, name, tagline, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, tags_json, archived, created_at, updated_at, play_guide) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(HARYEONG.id, '화령', '', '', '', '', '', '', '', '', '[]', 0, 't', 't', '');
    const convId = 'conv/info-pipe';
    db.prepare("INSERT INTO conversations (id, character_id, title, mode, profile_name, scene_json, prompt_version, favorite, archived, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(convId, HARYEONG.id, 'info pipe', 'story', 'rp-balanced', '{}', 'v', 0, 0, 't', 't');
    const stored = [
      { type: 'dialogue', id: 'a', actorId: HARYEONG.id, actorName: '직업·능력: 미정', text: '오래된 저장 화자(재해석 금지)' },
      { type: 'narration', id: 'b', text: '직업·능력: 미정 | 경지: 불 | 경험치: 0/100' },
    ];
    db.prepare('INSERT INTO messages (id, conversation_id, parent_id, role, content, status, meta_json, bookmarked, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('msg/info-pipe', convId, null, 'assistant', '직업·능력: 미정 | 경지: 불 | 경험치: 0/100', 'complete', JSON.stringify({ chat_event_version: 1, events: stored }), 0, 't');
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get('msg/info-pipe') as any;
    const events = messageEvents(db, row);
    assert.deepEqual(events, stored, '저장된 v1 이벤트를 그대로 돌려줘야 한다(본문 재파싱 없음)');
    assert.equal(events.filter((e) => e.type === 'dialogue' && (e.actorName ?? '').includes(':')).length, 1, '오래된 가짜 화자도 저장본 그대로 유지');
  } finally {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

console.log(`passed ${passed}`);
