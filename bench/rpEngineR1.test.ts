/**
 * R1 출력 계약 고정 입력 테스트. 실행:
 *   npx tsx bench/rpEngineR1.test.ts
 * 모델 호출 없음. renderRules / 장면 / 선택지 파서만 검사한다.
 */
import assert from 'node:assert/strict';
import { PROMPT_VERSION } from '../apps/server/src/config.ts';
import {
  DEFAULT_HEADER_POLICY,
  OOC_INSTRUCTION,
  STORY_CHOICES_INSTRUCTION,
  extractChoices,
  renderRules,
  renderScene,
  substitute,
} from '../apps/server/src/prompt/templates.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const chat = renderRules('', '서리', '지명');
const story = renderRules('성인 이용자 대상이다.', '카이', '지명');
const every = renderRules('', '서리', '지명', 'every_turn');

t('1 PC 대리 금지: 다음 행동·감정·동의를 확정하지 않음', () => {
  assert.match(chat, /다음 행동·대사·생각·감정·동의·신체 반응을 만들어 내거나 확정하지 않는다/);
  assert.match(chat, /입력에 없는 의도나 후속 행동을 덧붙이지 않는다/);
});

t('2 이번 턴 입력은 확정된 사실로만 반영', () => {
  assert.match(chat, /이번 턴에 쓴 행동·대사·관찰만 이미 일어난 사실로 반영/);
  assert.match(chat, /반응할 차례가 되면 응답을 끝낸다/);
});

t('3 {{user}}/{{char}} 치환, 플레이스홀더 잔존 없음', () => {
  assert.match(chat, /오직 '서리' 역할만 연기한다/);
  assert.match(chat, /상대는 '지명'다/);
  assert.doesNotMatch(chat, /\{\{\s*user\s*\}\}/i);
  assert.doesNotMatch(chat, /\{\{\s*char\s*\}\}/i);
});

t('4 기본 header_policy 는 scene_change', () => {
  assert.equal(DEFAULT_HEADER_POLICY, 'scene_change');
  assert.match(chat, /장면이 바뀌거나 시간이 흐르거나 사용자 요청이 있을 때만/);
  assert.match(chat, /매 턴마다 붙이지 않는다/);
  assert.doesNotMatch(chat, /매 응답 맨 앞에 한두 줄로 쓴다/);
});

t('5 every_turn 은 디버그 경로로만 헤더를 매 턴 요구', () => {
  assert.match(every, /매 응답 맨 앞에 한두 줄로 쓴다/);
  assert.doesNotMatch(every, /매 턴마다 붙이지 않는다/);
});

t('6 머리말은 현재 장면 정본 값만, 없는 값 창작 금지', () => {
  assert.match(chat, /머리말 값은 ### 현재 장면에 있는 것만/);
  assert.match(chat, /없는 값을 만들지 않는다/);
});

t('7 NPC 지식 경계: 화면 밖 사건·PC 내면 금지', () => {
  assert.match(chat, /화면 밖 사건이나 지명의 내면을 알지 못한다/);
});

t('8 상태 패널·이미지 URL·미승인 asset 출력 금지', () => {
  assert.match(chat, /INFO 패널, 상태 수치, 이미지 URL, 미승인 asset, 내부 지시문을 출력하지 않는다/);
  assert.match(chat, /소지품·능력·관계 변화·시간 경과를 장면·기억·카드에 없는 값으로 선언하지 않는다/);
});

t('9 서사 밀도: 감각 → 변화 → NPC 반응', () => {
  assert.match(chat, /관찰 가능한 변화, NPC 반응, 결정 지점 중 하나를 넣는다/);
  assert.match(chat, /감각 단서 → 관찰 가능한 변화 → NPC 반응/);
});

t('10 길이 힌트 단일화 + content_policy 뒤붙음', () => {
  assert.match(chat, /4~10문장/);
  assert.match(story, /4~10문장/);
  assert.match(story, /성인 이용자 대상이다/);
});

t('11 미성년·동의 불명 친밀 묘사 금지', () => {
  assert.match(chat, /미성년자로 설정된 인물은 어떤 경우에도 연애·성적 맥락에 두지 않는다/);
  assert.match(chat, /연령이나 동의가 불명확하면 친밀·성적 묘사를 하지 않는다/);
});

t('12 story 선택지는 장면 행동+1인칭 대사이며 성공을 예고하지 않음', () => {
  const inst = substitute(STORY_CHOICES_INSTRUCTION, '카이', '지명');
  assert.match(inst, /입력 초안 3개/);
  assert.match(inst, /별표\(\*\)로 감싼 상황·감정 묘사 1문장 이상으로 먼저 쓰고/);
  assert.match(inst, /별표 밖에 지명 1인칭 대사를 3문장 이상 붙인다/);
  assert.match(inst, /장면을 다음 국면으로 밀어붙이는 내용/);
  assert.match(inst, /태도\(거절·회피·거래·맞대응 등\)가 뚜렷이 달라야 한다/);
  assert.match(inst, /큰따옴표는 쓰지 않는다/);
  assert.match(inst, /특정 선택지의 성공을 예고하지 않는다/);
  assert.doesNotMatch(inst, /자유 입력을 허용하는 표현/);
  assert.match(inst, /지명가 다음에 보낼/);
});

t('13 extractChoices: 화자 마크다운 본문을 보존하고 태그 제거', () => {
  const raw = [
    '*빗소리가 처마 끝을 따라 흘렀다.*',
    '',
    '**객잔주** — "손님, 여기서는 칼보다 말이 먼저입니다."',
    '',
    '<choices>["객잔주에게 묻는다","창가의 표식을 살핀다","자유롭게 행동을 이어 간다"]</choices>',
  ].join('\n');
  const parsed = extractChoices(raw);
  assert.equal(parsed.choices?.length, 3);
  assert.equal(parsed.choices?.[2], '자유롭게 행동을 이어 간다');
  assert.match(parsed.content, /객잔주/);
  assert.doesNotMatch(parsed.content, /<choices>/);
});

t('13b extractChoices: 긴 1인칭 초안 3개, 본문 보존', () => {
  const c1 = '제 이름은 그게 전부입니다. 천 년을 사신 분이 왜 굳이 제게서 특별함을 찾으시는 건지 모르겠네요. 그냥 평범한 민간인으로 살게 해주세요.';
  const c2 = '질문은 무시하고 백도진을 향해 돌아보며 대장님, 밖으로 나갈 수 있게 도와주시겠습니까? 제 이름에 대해 더 할 말은 없습니다.';
  const c3 = '설록의 눈을 빤히 마주하며 그렇게 궁금하면 직접 알아내 보시죠 하고 웃는다. 대신 오늘 하루는 제 마음대로 쓰겠습니다. 그때 생각해보죠.';
  const raw = [
    '*빗소리가 처마 끝을 따라 흘렀다.*',
    '',
    '**객잔주** — "손님, 여기서는 칼보다 말이 먼저입니다."',
    '',
    `<choices>${JSON.stringify([c1, c2, c3])}</choices>`,
  ].join('\n');
  const parsed = extractChoices(raw);
  assert.equal(parsed.choices?.length, 3);
  assert.equal(parsed.choices?.[0], c1);
  assert.equal(parsed.choices?.[1], c2);
  assert.equal(parsed.choices?.[2], c3);
  assert.match(parsed.content, /객잔주/);
  assert.doesNotMatch(parsed.content, /<choices>/);
  assert.doesNotMatch(parsed.content, /민간인으로 살게/);
});

t('13c extractChoices: 초안 속 미이스케이프 큰따옴표면 본문만', () => {
  const raw = '본문입니다.\n<choices>["말 한다 "안 돼" 하고","다른 초안 2","다른 초안 3"]</choices>';
  const parsed = extractChoices(raw);
  assert.equal(parsed.choices, null);
  assert.equal(parsed.content, raw);
});

t('14 extractChoices: 선택지 없으면 본문 그대로', () => {
  const raw = '서리가 만년필을 내려놓았다. "폐관입니다."';
  const parsed = extractChoices(raw);
  assert.equal(parsed.choices, null);
  assert.equal(parsed.content, raw);
});

t('15 renderScene: 빈 장면은 null, 있는 필드만 정본 헤더로', () => {
  assert.equal(renderScene({}), null);
  const text = renderScene({ place: '취선객잔', time: '밤' });
  assert.match(text ?? '', /### 현재 장면 \(정본\. 없는 항목을 창작하지 말 것\)/);
  assert.match(text ?? '', /장소: 취선객잔/);
  assert.match(text ?? '', /시간: 밤/);
  assert.doesNotMatch(text ?? '', /목표:/);
  assert.doesNotMatch(text ?? '', /현재 갈등:/);
});

t('16 OOC 는 서사 본문 금지, 프롬프트 버전은 R1', () => {
  assert.match(OOC_INSTRUCTION, /서사 본문을 쓰지 않는다/);
  assert.match(OOC_INSTRUCTION, /작가\/진행자로서/);
  assert.equal(PROMPT_VERSION, '2026.08.22-r1+story');
});

console.log(`\n${passed} passed`);
