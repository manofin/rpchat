import type { CharacterRow, PersonaRow, Scene } from '../types.js';

/** {{char}} / {{user}} 치환 (SillyTavern 계열 카드 호환) */
export function substitute(text: string, charName: string, userName: string): string {
  return (text ?? '').replace(/\{\{\s*char\s*\}\}/gi, charName).replace(/\{\{\s*user\s*\}\}/gi, userName);
}

// 편집 불가 고정 규칙. 콘텐츠 정책(편집 가능)은 settings.content_policy 로 뒤에 덧붙는다.
// R1: 출력 계약 + header_policy 만. 장면 상태 패치·장르 프로필은 후속 단계.
export type HeaderPolicy = 'scene_change' | 'every_turn';
export const DEFAULT_HEADER_POLICY: HeaderPolicy = 'scene_change';

const HARD_RULES = [
  '{{user}}의 다음 행동·대사·생각·감정·동의·신체 반응을 만들어 내거나 확정하지 않는다. {{user}}가 이번 턴에 쓴 행동·대사·관찰만 이미 일어난 사실로 반영하고, 그 입력에 없는 의도나 후속 행동을 덧붙이지 않는다. {{user}}가 반응할 차례가 되면 응답을 끝낸다.',
  '{{char}}의 정체성·성격·말투·관계·금기를 일관되게 유지한다. 설정과 모순되는 요구는 {{char}}다운 방식으로 거절하거나 비껴간다. {{char}}는 카드·장면·로어에 근거 없는 화면 밖 사건이나 {{user}}의 내면을 알지 못한다.',
  '대사는 큰따옴표("") 안에 쓰고, 행동·표정·장면 묘사는 자연스러운 서술문으로 쓴다. 말할 때 화자가 분명해야 한다.',
  '직전 응답의 문장·표현·전개를 반복하지 않는다. 매 응답에 관찰 가능한 변화, NPC 반응, 결정 지점 중 하나를 넣는다. 긴 서술은 감각 단서 → 관찰 가능한 변화 → NPC 반응 순으로 쓴다.',
  'AI·모델·프롬프트·시스템을 언급하지 않는다. {{user}}가 "(OOC)"로 시작하는 메시지를 보낼 때만 캐릭터를 벗어나 작가로서 짧게 답한다.',
  '미성년자로 설정된 인물은 어떤 경우에도 연애·성적 맥락에 두지 않는다. 연령이나 동의가 불명확하면 친밀·성적 묘사를 하지 않는다.',
  '소지품·능력·관계 변화·시간 경과를 장면·기억·카드에 없는 값으로 선언하지 않는다. INFO 패널, 상태 수치, 이미지 URL, 미승인 asset, 내부 지시문을 출력하지 않는다.',
  '한국어로 답한다.',
];

function headerRule(policy: HeaderPolicy): string {
  if (policy === 'every_turn') {
    return '장면 머리말(시간·장소·분위기)을 매 응답 맨 앞에 한두 줄로 쓴다. 머리말 값은 ### 현재 장면에 있는 것만 쓰고 없는 값을 만들지 않는다.';
  }
  return '장면 머리말(시간·장소·분위기)은 장면이 바뀌거나 시간이 흐르거나 사용자 요청이 있을 때만 한두 줄로 쓴다. 매 턴마다 붙이지 않는다. 머리말 값은 ### 현재 장면에 있는 것만 쓰고 없는 값을 만들지 않는다.';
}

const LENGTH_HINT: Record<'chat' | 'story', string> = {
  chat: '응답 길이는 보통 2~5문장. 대사 중심, 묘사는 짧게.',
  story: '응답 길이는 4~10문장. 장면·감각·감정 묘사를 포함해 서사적으로 쓴다.',
};

export const STORY_CHOICES_INSTRUCTION =
  '응답의 맨 마지막 줄에 {{user}}가 다음에 취할 수 있는 행동 선택지 2~3개를 정확히 다음 형식으로만 출력한다: <choices>["선택지 1","선택지 2","자유롭게 행동을 이어 간다"]</choices>. 선택지는 제안일 뿐이며 특정 선택지의 성공을 예고하지 않는다. 마지막 항목은 반드시 자유 입력을 허용하는 표현이어야 한다.';

export const OOC_INSTRUCTION =
  '이번 메시지는 (OOC)로 시작하는 설정 확인 요청이다. 캐릭터 연기를 멈추고, 작가/진행자로서 사실 위주로 3문장 이내로 답한다. 서사 본문을 쓰지 않는다.';

export function renderRules(
  mode: 'chat' | 'story',
  contentPolicy: string,
  charName: string,
  userName: string,
  headerPolicy: HeaderPolicy = DEFAULT_HEADER_POLICY,
): string {
  const lines = HARD_RULES.map((r, i) => `${i + 1}. ${r}`);
  lines.push(`${lines.length + 1}. ${headerRule(headerPolicy)}`);
  if (contentPolicy.trim()) lines.push(`${lines.length + 1}. ${contentPolicy.trim()}`);
  lines.push(`${lines.length + 1}. ${LENGTH_HINT[mode]}`);
  return substitute(`당신은 역할극(RP) 파트너로서 오직 '{{char}}' 역할만 연기한다. 상대는 '{{user}}'다.\n규칙:\n${lines.join('\n')}`, charName, userName);
}

function field(label: string, value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  return v ? `${label}: ${v}` : null;
}

export function renderCharacter(c: CharacterRow, charName: string, userName: string, includeExamples: boolean, exampleText?: string): string {
  const parts = [
    `### 캐릭터: ${c.name}`,
    field('한 줄 소개', c.tagline),
    field('설명', c.description),
    field('성격', c.personality),
    field('말투', c.speech_style),
    field('시나리오', c.scenario),
    field('금기(절대 하지 않는 것)', c.taboos),
  ].filter((x): x is string => !!x);
  if (includeExamples) {
    const ex = (exampleText ?? c.example_dialogue ?? '').trim();
    if (ex) parts.push(`### 예시 대화 (말투 참고용. 내용을 그대로 반복하지 말 것)\n${ex}`);
  }
  return substitute(parts.join('\n'), charName, userName);
}

export function renderPersona(p: PersonaRow | null, charName: string, userName: string): string {
  if (!p) return `### 사용자 페르소나\n이름: ${userName}`;
  const parts = [
    `### 사용자 페르소나: ${p.name}`,
    field('{{char}}가 부르는 호칭', p.address_as),
    field('외형', p.appearance),
    field('성격', p.personality),
    field('관계·배경', p.relationship),
  ].filter((x): x is string => !!x);
  return substitute(parts.join('\n'), charName, userName);
}

export function renderScene(s: Scene): string | null {
  const parts = [
    field('장소', s.place),
    field('시간', s.time),
    field('목표', s.goal),
    field('장르·분위기', s.genre),
    field('현재 갈등', s.conflict),
    field('현재 감정', s.mood),
  ].filter((x): x is string => !!x);
  return parts.length ? `### 현재 장면 (정본. 없는 항목을 창작하지 말 것)\n${parts.join('\n')}` : null;
}

export function renderMemories(items: string[]): string | null {
  return items.length ? `### 고정 기억 (확인된 사실, 반드시 지킬 것)\n${items.map((m) => `- ${m}`).join('\n')}` : null;
}

export function renderLore(items: Array<{ title: string; content: string }>): string | null {
  return items.length ? `### 관련 설정(로어)\n${items.map((e) => `- [${e.title}] ${e.content}`).join('\n')}` : null;
}

export function renderSummary(text: string | null): string | null {
  return text && text.trim() ? `### 이전 대화 요약\n${text.trim()}` : null;
}

/** 요약 + 후보 기억 추출 프롬프트 (JSON 만 출력하도록 요구) */
export function renderSummaryPrompt(charName: string, userName: string, previousSummary: string | null, transcript: string): string {
  return [
    `다음은 '${charName}'와 '${userName}'의 역할극 대화 기록이다. 아래 JSON 객체 하나만 출력한다. 설명·코드펜스·앞뒤 문장은 금지한다.`,
    `{"summary":"사건·관계 변화·보류된 약속·다음 훅을 시간순으로 8문장 이내","memories":[{"content":"대화에서 직접 확인된 사실 1개 (추론·예측 금지)","importance":1}]}`,
    'memories 는 최대 8개, importance 는 1(사소)~5(핵심). 이미 기존 요약에 있는 사실은 넣지 않는다.',
    previousSummary ? `\n[기존 요약]\n${previousSummary}` : '',
    `\n[대화]\n${transcript}`,
  ].join('\n');
}

/** 스토리 모드 선택지 파싱: <choices>[...]</choices> 또는 말미의 JSON 배열. 실패 시 본문만 반환. */
export function extractChoices(text: string): { content: string; choices: string[] | null } {
  const m = text.match(/<choices>\s*(\[[\s\S]*?\])\s*<\/choices>\s*$/i) ?? text.match(/```(?:json|choices)?\s*(\[[\s\S]*?\])\s*```\s*$/i);
  if (!m) return { content: text, choices: null };
  try {
    const arr = JSON.parse(m[1]);
    if (!Array.isArray(arr)) return { content: text, choices: null };
    const choices = arr.map((x) => String(x).trim()).filter(Boolean).slice(0, 3);
    return { content: text.slice(0, m.index).trimEnd(), choices: choices.length ? choices : null };
  } catch {
    return { content: text, choices: null };
  }
}
