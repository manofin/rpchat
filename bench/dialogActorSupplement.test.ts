import assert from 'node:assert/strict';
import { parseActorSupplement } from '../apps/server/src/prompt/dialogActorSupplement.js';
import { parseScript, PASS_S_MAX_LINES } from '../apps/server/src/prompt/dialogScript.js';
const cast = [{ id: 'nari', name: '나리', aliases: ['Nari'] }, { id: 'sera', name: '세라' }];
let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`ok ${++passed} ${name}`); }
check('merge continuations, excluding leading narration and text after another speaker', () => {
  assert.deepEqual(parseActorSupplement('앞선 서술.\n나리 | 하나.\n\n이어서 말해.\n세라 | 둘.\n세라의 이어지는 말.\nNari | 셋.', 'nari', cast),
    { text: '나리 | 하나. 이어서 말해.\n나리 | 셋.', acceptedLines: 3, rejectedLines: 3, droppedLines: 0 });
});
check('notebook example tests attribution format, not ownership correctness', () => {
  const wrong = '제가 가진 수첩을 돌려주기로 한 약속은 아직 이행되지 않았어요.';
  assert.equal(parseActorSupplement(`나리 | 확인할게.\n${wrong}`, 'nari', cast).text, `나리 | 확인할게. ${wrong}`);
  assert.equal(parseActorSupplement(`나리 | ${wrong}`, 'nari', cast).text, `나리 | ${wrong}`);
});
check('unknown, user, empty and embedded speaker lines are rejected', () => {
  const result = parseActorSupplement('사용자 | 안녕.\n낯선 사람 | 안녕.\n나리 | \n나리 | 하나. 세라 | 둘.', 'nari', cast);
  assert.equal(result.text, ''); assert.equal(result.rejectedLines, 4);
});
check('ambiguous names and aliases do not choose a recipient', () => {
  assert.equal(parseActorSupplement('나리 | 안녕.', 'nari', [...cast, { id: 'other', name: '나리' }]).text, '');
  assert.equal(parseActorSupplement('Nari | 안녕.', 'nari', [...cast, { id: 'other', name: '다른 인물', aliases: ['Nari'] }]).text, '');
});
check('missing allowed actor cannot produce a supplement', () => {
  assert.equal(parseActorSupplement('나리 | 안녕.', 'nari', [cast[1]]).text, '');
});
check('cap applies across the whole supplement', () => {
  const result = parseActorSupplement(Array.from({ length: PASS_S_MAX_LINES + 2 }, () => '나리 | 안녕.').join('\r\n'), 'nari', cast);
  assert.equal(result.acceptedLines, PASS_S_MAX_LINES); assert.equal(result.droppedLines, 2);
});
check('public parser retains narration and unknown speaker contract', () => {
  assert.deepEqual(parseScript('공개 서술.\n낯선 사람 | 대사.', cast).items,
    [{ kind: 'narration', text: '공개 서술.\n낯선 사람 | 대사.' }]);
});
check('long canonical name cannot fall back to private narration', () => {
  const actor = { id: 'long', name: '가'.repeat(25) };
  assert.equal(parseActorSupplement(`${actor.name} | 확인.`, actor.id, [actor]).text, '');
});
check('unique alias with ambiguous canonical name cannot fall back to narration', () => {
  const sameName = [...cast, { id: 'other', name: '나리' }];
  assert.equal(parseActorSupplement('Nari | 확인.', 'nari', sameName).text, '');
});
check('rejected and capped speaker lines break continuation attribution', () => {
  const raw = '나리 | 허용.\n사용자 | 거부.\n이어지는 사용자 대사.\n나리 | \n빈 대사 뒤의 서술.';
  assert.equal(parseActorSupplement(raw, 'nari', cast).text, '나리 | 허용.');
  const capped = Array.from({ length: PASS_S_MAX_LINES + 1 }, () => '나리 | 허용.').join('\n') + '\n상한 밖의 이어지는 말.';
  assert.ok(!parseActorSupplement(capped, 'nari', cast).text.includes('상한 밖'));
});
check('standalone sentinels are omitted without affecting line counts', () => {
  assert.deepEqual(parseActorSupplement('NO_NARRATION\n나리 | 응.\nNO_LINE\nNO_NARRATION\n이어서 말해.', 'nari', cast),
    { text: '나리 | 응. 이어서 말해.', acceptedLines: 2, rejectedLines: 0, droppedLines: 0 });
  assert.deepEqual(parseActorSupplement('NO_LINE\nNO_NARRATION', 'nari', cast),
    { text: '', acceptedLines: 0, rejectedLines: 0, droppedLines: 0 });
});
check('control blocks are removed before assigning continuation speakers', () => {
  for (const tag of ['think', 'thinking', 'analysis', 'thought']) {
    const result = parseActorSupplement(`나리 | 응.\n<${tag}>\n세라 | 내부 생각.\n이것도 내부.\n</${tag}>\n이어서 말해.`, 'nari', cast);
    assert.deepEqual(result, { text: '나리 | 응. 이어서 말해.', acceptedLines: 2, rejectedLines: 0, droppedLines: 0 });
  }
});
check('choices and unfinished thought blocks cannot become dialogue', () => {
  assert.equal(parseActorSupplement('나리 | 응.\n<choices>["초안"]</choices>', 'nari', cast).text, '나리 | 응.');
  assert.equal(parseActorSupplement('나리 | 응.\n<think>\n내부 내용.', 'nari', cast).text, '나리 | 응.');
});
check('self action continuation is retained, leading action is excluded', () => {
  assert.deepEqual(parseActorSupplement('*나리가 들어온다*\n나리 | 응.\n*나리가 고개를 끄덕인다*', 'nari', cast),
    { text: '나리 | 응. *나리가 고개를 끄덕인다*', acceptedLines: 2, rejectedLines: 1, droppedLines: 0 });
});
