/**
 * npx tsx bench/passPrompts.test.ts
 * f9-swap-passes (S4) — §5 Swap prompts. Each pass sees only the cards it may
 * speak for, and each prohibition is asserted as text because a positive
 * instruction alone is not reliable (the `<choices>` tag went missing ~20% of the
 * time under exactly that assumption).
 * Isolated: no systemd, no live DB, no model call, no migration, no live generate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PASS_E_MAX_SENTENCES, PASS_E_MIN_SENTENCES, PASS_N_MAX_SENTENCES, THOUGHT_MARKER,
  renderPassE, renderPassF, renderPassN,
} from '../apps/server/src/prompt/passes.ts';
import type { CastMember } from '../apps/server/src/prompt/cast.ts';
import type { Scene } from '../apps/server/src/types.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(dir, '..');
const src = (rel: string) => fs.readFileSync(path.join(appRoot, rel), 'utf8');
/** Source with comments stripped — fences bind on code, not on prose naming a symbol. */
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const member = (o: Partial<CastMember> & { id: string; name: string }): CastMember => ({
  aliases: [], duties: [], place: '교실', role: 'secondary', ...o,
});
const NARI = member({ id: 'nari', name: '나리' });
const SERA = member({ id: 'sera', name: '세라', duties: ['교칙'] });
const LUNA = member({ id: 'luna', name: '루나' });
const SOYEON = member({ id: 'soyeon', name: '한소연', place: '사무실' });
const CAST = [NARI, SERA, LUNA, SOYEON];

const SCENE: Scene = {
  location: '교실',
  beat_goal: '자리에 앉히기',
  present_ids: ['nari', 'sera', 'luna'],
};

const NARI_CARD = { name: '나리', personality: '날이 서 있다', speech_style: '짧게 끊어 말한다', taboos: '먼저 사과하지 않는다' };
const SERA_CARD = { name: '세라', personality: '원칙적이다' };

const passN = (o: Partial<Parameters<typeof renderPassN>[0]> = {}) => renderPassN({
  focusCard: NARI_CARD, cast: CAST, scene: SCENE, header: '12일차 · 09:37 · 교실',
  userText: '나리, 네 이야기 말인데.', ambientNames: ['루나'], ...o,
});

const passF = (o: Partial<Parameters<typeof renderPassF>[0]> = {}) => renderPassF({
  focusCard: NARI_CARD, userName: '황지명', userText: '나리, 네 이야기 말인데.',
  scene: SCENE, header: '12일차 · 09:37 · 교실', narration: '지명이 나리를 돌아본다.', ...o,
});

const passE = (o: Partial<Parameters<typeof renderPassE>[0]> = {}) => renderPassE({
  card: SERA_CARD, duty: '교칙', focusName: '나리', focusText: '"시비냐."',
  narration: '지명이 나리를 돌아본다.', userName: '황지명', userText: '나리, 네 이야기 말인데.', ...o,
});

// ── Pass N: narration only ──────────────────────────────────────────────────
t('Pass N forbids every form of dialogue block', () => {
  const p = passN();
  assert.ok(p.includes('어떤 인물의 대사도 쓰지 않는다'));
  assert.ok(p.includes('`이름|` 형식'), 'the 이름| block must be named explicitly');
  assert.ok(p.includes('`이름:` 형식'));
  assert.ok(p.includes(`${PASS_N_MAX_SENTENCES}문장 이내`));
});

t('Pass N names ambient characters as gesture-only, never as speakers', () => {
  const p = passN({ ambientNames: ['루나', '유라'] });
  assert.ok(p.includes('루나, 유라'));
  assert.ok(p.includes('말하게 하지 않는다'));
  assert.ok(p.includes('몸짓으로 존재감만'));
});

t('Pass N lists only who is in the room, and forbids inventing anyone else', () => {
  const p = passN();
  assert.ok(p.includes('나리, 세라, 루나'));
  assert.equal(p.includes('한소연'), false, 'an absent cast member must not be offered');
  assert.ok(p.includes('이름을 지어내지 않는다'));
});

t('Pass N is told the header exists and must not restate it', () => {
  const p = passN();
  assert.ok(p.includes('12일차 · 09:37 · 교실'));
  assert.ok(p.includes('다시 쓰지 말 것'));
  assert.ok(p.includes('서버가 이미 붙였다'));
});

t('Pass N stays in the header place even when the card describes another world', () => {
  assert.ok(passN().includes('지금 장소는 헤더의 장소다'));
});

t('Pass N carries the beat goal so narration can move toward it', () => {
  assert.ok(passN().includes('자리에 앉히기'));
});

// ── Pass F: one card, one voice ─────────────────────────────────────────────
t('Pass F names exactly one speaker and forbids writing anyone else', () => {
  const p = passF();
  assert.ok(p.includes("너는 '나리' 한 명만 연기한다"));
  assert.ok(p.includes('다른 인물의 대사·행동·생각을 대신 쓰지 않는다'));
  assert.ok(p.includes('황지명의 다음 행동·대사·생각·감정을 만들어 내거나 확정하지 않는다'));
});

t('Pass F carries only the focus card — no other character sheet leaks in', () => {
  const p = passF();
  assert.ok(p.includes('날이 서 있다'));
  assert.ok(p.includes('먼저 사과하지 않는다'));
  assert.equal(p.includes('원칙적이다'), false, "세라's card must not appear in 나리's pass");
  assert.equal(p.includes('세라'), false);
});

t('Pass F fixes the thought marker and scopes 속마음 to the focus', () => {
  const p = passF();
  assert.ok(p.includes(THOUGHT_MARKER));
  assert.ok(p.includes('맨 마지막 줄에만'));
  assert.ok(p.includes("속마음은 '나리'의 것만 쓴다"));
  assert.ok(p.includes('없으면 그 줄을 쓰지 않는다'), 'the marker must be optional, not required');
});

t('Pass F stays in the header place rather than the card\'s home world', () => {
  assert.ok(passF().includes('헤더의 장소에서 말한다'));
});

t('Pass F is shown the narration and told not to repeat it', () => {
  const p = passF();
  assert.ok(p.includes('지명이 나리를 돌아본다.'));
  assert.ok(p.includes('이미 화면에 있다'));
  // …and omits the section entirely when Pass N produced nothing
  assert.equal(passF({ narration: '' }).includes('이미 화면에 있다'), false);
});

t('Pass F appends the content policy when one is set, and nothing when not', () => {
  assert.ok(passF({ contentPolicy: '수위 제한 없음' }).includes('수위 제한 없음'));
  assert.equal(passF({ contentPolicy: '   ' }).includes('- \n'), false);
});

// ── Pass E: add one thing, do not restate ───────────────────────────────────
t('Pass E forbids repeating the focus, including in paraphrase', () => {
  const p = passE();
  assert.ok(p.includes("'나리'이 이미 한 말을 반복하지 않는다"));
  assert.ok(p.includes('다른 말로 바꾸는 것도 반복이다'), 'paraphrase is the actual failure mode');
});

t('Pass E scopes the extra to their own duty (duty_transfer guard in the prompt too)', () => {
  const p = passE();
  assert.ok(p.includes('네 직무(교칙)의 권한 안에서'));
  assert.ok(p.includes('그 밖의 판단을 내리지 않는다'));
  assert.ok(p.includes('이번 턴에 끼어들 근거는 네 직무다: 교칙'));
});

t('Pass E is capped at a short interjection', () => {
  const p = passE();
  assert.ok(p.includes(`${PASS_E_MIN_SENTENCES}~${PASS_E_MAX_SENTENCES}문장`));
  assert.ok(p.includes('짧게 끼어들고 끝낸다'));
  assert.ok(p.includes('장면을 새 국면으로 끌고 가지 않는다'));
});

t('Pass E carries only its own card', () => {
  const p = passE();
  assert.ok(p.includes('원칙적이다'));
  assert.equal(p.includes('날이 서 있다'), false, "나리's card must not appear in 세라's pass");
});

t('Pass E gets the focus line to react to, without permission to write it', () => {
  const p = passE();
  assert.ok(p.includes('"시비냐."'));
  assert.ok(p.includes("'나리'이나 황지명의 대사·행동·생각을 대신 쓰지 않는다"));
});

t('server facts are marked as fixed, and the section vanishes when there are none', () => {
  const p = passE({ facts: ['빈자리는 나리 옆자리', '수업 시작 09:40'] });
  assert.ok(p.includes('빈자리는 나리 옆자리'));
  assert.ok(p.includes('수업 시작 09:40'));
  assert.ok(p.includes('서버가 정한 것'));
  assert.equal(passE({ facts: [] }).includes('확정 사실'), false);
  assert.equal(passE({ facts: ['  '] }).includes('확정 사실'), false);
});

// ── every pass: the server owns the chrome ──────────────────────────────────
t('no pass may output the header, numbers, choices or an image', () => {
  for (const [name, p] of [['N', passN()], ['F', passF()], ['E', passE()]] as const) {
    assert.ok(p.includes('선택지'), `${name} must forbid choices`);
    assert.ok(p.includes('이미지'), `${name} must forbid images`);
    assert.ok(/상태 (수치|패널)/.test(p), `${name} must forbid status numbers`);
    assert.ok(p.includes('한국어로 답한다'), `${name} must set the language`);
  }
});

t('no pass ever contains a URL or an asset path', () => {
  for (const p of [passN(), passF(), passE()]) {
    assert.equal(/https?:\/\/|silu\.uk|\/media\//.test(p), false);
  }
});

t('the module is pure and builds strings only', () => {
  const s = code('apps/server/src/prompt/passes.ts');
  for (const banned of ['better-sqlite3', 'fetch(', 'ModelClient', '../db/', 'Math.random']) {
    assert.equal(s.includes(banned), false, banned);
  }
  const imports = (s.match(/^import .*$/gm) ?? []).filter((l) => !l.startsWith('import type'));
  assert.deepEqual(imports, [], 'passes.ts should need no runtime imports');
});

t('1:1 HARD_RULES text is not reused or edited by the pass prompts', () => {
  const templates = src('apps/server/src/prompt/templates.ts');
  assert.ok(templates.includes("오직 '{{char}}' 역할만 연기한다"), '1:1 rule text intact');
  const s = code('apps/server/src/prompt/passes.ts');
  assert.equal(s.includes("오직 '{{char}}'"), false);
  assert.equal(s.includes('HARD_RULES'), false);
  assert.equal(s.includes('<choices>'), false);
});

console.log(`\n${passed} passed`);
