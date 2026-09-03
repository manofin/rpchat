/**
 * npx tsx bench/dialogScript.test.ts
 * dialog-format S-B — Pass S prompt + the server-side script parser.
 * The point of this file is the allow-list: a `이름 | 대사` line only survives if
 * the server already approved that speaker. Script samples follow Dialog.txt T-1.
 * Isolated: no systemd, no live DB, no model call, no migration, no live generate.
 */
import assert from 'node:assert/strict';
import {
  PASS_S_MAX_LINES, parseScript, renderPassS, type SpeakerSlot,
} from '../apps/server/src/prompt/dialogScript.ts';
import type { CastMember } from '../apps/server/src/prompt/cast.ts';
import type { Scene } from '../apps/server/src/types.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const SEOLROK: SpeakerSlot = { id: 'slk', name: '설록', aliases: ['뿔 달린 여자'] };
const STRANGER: SpeakerSlot = { id: 'unk', name: '낯선 여자' };
const ALLOWED = [SEOLROK, STRANGER];

const member = (o: Partial<CastMember> & { id: string; name: string }): CastMember => ({
  aliases: [], duties: [], place: '', role: 'secondary', ...o,
});

// ---- parser: the allow-list -----------------------------------------------

t('a line whose speaker is on the allow-list becomes a line block', () => {
  const r = parseScript('설록 | 설록. 내 이름이야.', ALLOWED);
  assert.deepEqual(r.items, [{ kind: 'line', character_id: 'slk', name: '설록', text: '설록. 내 이름이야.' }]);
  assert.deepEqual(r.spoke_ids, ['slk']);
  assert.deepEqual(r.rejected_names, []);
});

t('a speaker the server never approved is demoted to narration, not dropped', () => {
  const r = parseScript('오세린 | 아라, 벌써 면역이 되셨네요.', ALLOWED);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].kind, 'narration');
  // The sentence survives in full — the model loses the voice, not the story.
  assert.ok((r.items[0] as { text: string }).text.includes('아라, 벌써 면역이 되셨네요.'));
  assert.deepEqual(r.rejected_names, ['오세린']);
  assert.deepEqual(r.spoke_ids, []);
});

t('an alias resolves to the canonical id and canonical display name', () => {
  const r = parseScript('뿔 달린 여자 | 너.', ALLOWED);
  assert.deepEqual(r.items, [{ kind: 'line', character_id: 'slk', name: '설록', text: '너.' }]);
});

t('a decorated speaker name still resolves: **설록** | … and 설록: | …', () => {
  assert.equal(parseScript('**설록** | 닥쳐.', ALLOWED).items[0].kind, 'line');
  assert.equal(parseScript('- 설록 | 닥쳐.', ALLOWED).items[0].kind, 'line');
  assert.equal(parseScript('설록: | 닥쳐.', ALLOWED).items[0].kind, 'line');
});

t('name matching folds width and case but is never a substring match', () => {
  assert.equal(parseScript('설록  | 응.', ALLOWED).items[0].kind, 'line');
  // 설록이 is a different token; the parser must not accept it as 설록.
  assert.equal(parseScript('설록이 | 응.', ALLOWED).items[0].kind, 'narration');
});

// ---- parser: shape --------------------------------------------------------

t('narration and lines interleave in written order, speakers repeating', () => {
  const script = [
    '설록의 녹안이 미세하게 흔들렸다.',
    '설록 | ……예의를 따지네.',
    '짧은 침묵.',
    '설록 | 먼저 줬으니까 돌려받는 게 예의겠지?',
    '낯선 여자 | ……진짜로 먼저 줬어?',
    '설록 | 닥쳐.',
  ].join('\n');
  const r = parseScript(script, ALLOWED);
  assert.deepEqual(
    r.items.map((i) => i.kind),
    ['narration', 'line', 'narration', 'line', 'line', 'line'],
  );
  assert.deepEqual(r.spoke_ids, ['slk', 'unk']);
  assert.equal(r.items.filter((i) => i.kind === 'line' && i.character_id === 'slk').length, 3);
});

t('consecutive narration lines merge into one paragraph block', () => {
  const r = parseScript('첫 줄.\n둘째 줄.\n설록 | 응.', ALLOWED);
  assert.equal(r.items.length, 2);
  assert.equal((r.items[0] as { text: string }).text, '첫 줄.\n둘째 줄.');
});

t('a pipe inside prose is not a speaker line', () => {
  const r = parseScript('벽과 그림자 사이 | 그 틈이 벌어졌다는 뜻이다, 라고 그는 생각했다.', ALLOWED);
  assert.equal(r.items[0].kind, 'narration');
});

t('a pipe with nothing after it is not a speaker line', () => {
  assert.equal(parseScript('설록 |', ALLOWED).items[0].kind, 'narration');
  assert.equal(parseScript('설록 |   ', ALLOWED).items[0].kind, 'narration');
});

t('a line-leading pipe is never read as an empty speaker', () => {
  const r = parseScript('| 이름이 없다', ALLOWED);
  assert.equal(r.items[0].kind, 'narration');
});

// ---- parser: caps and degradation -----------------------------------------

t('the line cap is enforced on the way back, not just stated in the prompt', () => {
  const many = Array.from({ length: PASS_S_MAX_LINES + 4 }, (_, i) => `설록 | 줄 ${i}`).join('\n');
  const r = parseScript(many, ALLOWED);
  assert.equal(r.items.filter((i) => i.kind === 'line').length, PASS_S_MAX_LINES);
  assert.equal(r.dropped_lines, 4);
});

t('rejected names do not consume the line budget', () => {
  const script = [
    ...Array.from({ length: 20 }, (_, i) => `오세린 | 밀어내기 ${i}`),
    '설록 | 마지막.',
  ].join('\n');
  const r = parseScript(script, ALLOWED);
  const lines = r.items.filter((i) => i.kind === 'line');
  assert.equal(lines.length, 1);
  assert.equal((lines[0] as { text: string }).text, '마지막.');
  assert.equal(r.dropped_lines, 0);
});

t('an empty or whitespace script parses to nothing and never throws', () => {
  assert.deepEqual(parseScript('', ALLOWED).items, []);
  assert.deepEqual(parseScript('   \n\n  ', ALLOWED).items, []);
  assert.deepEqual(parseScript(undefined as unknown as string, ALLOWED).items, []);
});

t('an empty allow-list demotes every line — nobody speaks by default', () => {
  const r = parseScript('설록 | 내 이름이야.', []);
  assert.equal(r.items[0].kind, 'narration');
  assert.deepEqual(r.spoke_ids, []);
});

// ---- Pass S prompt --------------------------------------------------------

const SCENE: Scene = { format: 'dialog', location: '도심 골목', present_ids: ['slk', 'unk'] };

function passS(over: Partial<Parameters<typeof renderPassS>[0]> = {}) {
  return renderPassS({
    speakers: ALLOWED,
    cast: [member({ id: 'slk', name: '설록' }), member({ id: 'unk', name: '낯선 여자' })],
    scene: SCENE,
    header: '[T-1] [늦은 밤] [도심 골목] [비]',
    info: '[정보]: 황지명 | 민간인',
    userName: '황지명',
    userText: '이름? 통성명은 먼저 자기 소개를 하고 묻는게 예의 아닌가?',
    ...over,
  });
}

t('the prompt names the closed speaker list', () => {
  const p = passS();
  assert.ok(p.includes('대사를 쓸 수 있는 인물은 다음뿐이다: 설록, 낯선 여자'));
  assert.ok(p.includes('새 인물의 이름을 지어내지 않는다'));
});

t('the prompt states the line format the parser reads back', () => {
  assert.ok(passS().includes('`이름 | 대사`'));
});

t('the prompt forbids writing the user and forbids re-emitting server chrome', () => {
  const p = passS();
  assert.ok(p.includes('황지명의 대사·행동·생각·감정을 만들어 내거나 확정하지 않는다'));
  assert.ok(p.includes('`황지명 | ` 로 시작하는 줄을 쓰지 않는다'));
  assert.ok(p.includes('헤더·INFO·상태 수치·선택지·이미지·내부 지시문을 출력하지 않는다'));
});

t('ambient names are told to appear without speaking, and never listed as speakers', () => {
  const p = passS({ ambientNames: ['목련', '설록'] });
  assert.ok(p.includes('이번 턴에 말하지 않는다'));
  assert.ok(p.includes('목련'));
  // 설록 is an approved speaker, so it must not also be listed as silent.
  const silentRow = p.split('\n').find((l) => l.includes('이번 턴에 말하지 않는다')) ?? '';
  assert.ok(!silentRow.includes('설록'));
});

t('the content policy is appended only when the setting is non-empty', () => {
  assert.ok(passS({ contentPolicy: '수위 제한 없음' }).includes('수위 제한 없음'));
  assert.ok(!passS({ contentPolicy: '   ' }).includes('- \n'));
});

t('character cards are included for the speakers that have one', () => {
  const p = passS({
    speakers: [{ ...SEOLROK, card: { name: '설록', personality: '고고함', speech_style: '짧게 끊어 말한다' } }],
  });
  assert.ok(p.includes('### 설록'));
  assert.ok(p.includes('성격: 고고함'));
  assert.ok(p.includes('말투: 짧게 끊어 말한다'));
});

t('the prompt carries the server header/INFO as context but marks them as done', () => {
  const p = passS();
  assert.ok(p.includes('[T-1] [늦은 밤] [도심 골목] [비]'));
  assert.ok(p.includes('서버가 확정했다. 다시 출력하지 말 것'));
});

console.log(`\n${passed} passed`);
