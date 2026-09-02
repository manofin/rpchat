/**
 * Isolated Bench-Latency prompts. Not apps/**. Not F9C pickSpeaker.ts.
 * Structure from preregistration.md §0-4. Bodies locked under f9-bench-latency.
 * Existing scene_json 6 string fields only (scene.time clock is F9B).
 */
import { CAST, SCENE_LOBBY } from './cast.ts';
import { LATENCY_CUT } from './score-latency.ts';
import type { Scene6 } from './types.ts';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type BuiltPrompt = {
  kind: 'A' | 'B';
  scene: Scene6;
  main_speaker_id: string;
  secondary_speaker_id: string;
  participant_ids: string[];
  recent: ChatMessage[];
  call1: ChatMessage[];
  call2: ChatMessage[];
  compressed_cast: boolean;
  est_tokens: number;
};

/** Conservative estimator copied from apps/server/src/prompt/tokens.ts (read-only; product file untouched). */
export function estimateTokensRaw(text: string): number {
  if (!text) return 0;
  let hangul = 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f)) hangul++;
    else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff)) cjk++;
    else other++;
  }
  return Math.ceil(hangul * 0.7 + cjk * 1.0 + other / 3.6);
}

export function estimateMessages(msgs: ChatMessage[]): number {
  return msgs.reduce((n, m) => n + estimateTokensRaw(m.content) + 5, 0);
}

export function countParticipants(p: BuiltPrompt): number {
  return p.participant_ids.length;
}

export function countRecent(p: BuiltPrompt): number {
  return p.recent.length;
}

const USER_TURN = '등록하려면 어디로 가면 되나요?';

const A_RECENT: ChatMessage[] = [
  { role: 'user', content: '안녕하세요. 아카데미 등록하러 왔습니다.' },
  { role: 'assistant', content: '"이쪽에서 받아 드릴게요." 민아가 명부를 연다.' },
  { role: 'user', content: '오늘 오전에 끝나는 줄 알고 왔는데요.' },
  { role: 'assistant', content: '"오전 접수는 아직 열려 있어요." 민아가 도장을 확인한다.' },
  { role: 'user', content: '줄이 길면 안내를 받을 수 있나요?' },
  { role: 'assistant', content: '"안내가 필요하면 지우가 동행합니다." 민아가 로비 쪽을 가리킨다.' },
  { role: 'user', content: '측정은 바로 하나요, 아니면 등록 다음인가요?' },
  { role: 'assistant', content: '"등록이 먼저입니다." 민아가 서류를 한 장 밀어 준다.' },
  { role: 'user', content: '대기 번호는 어디서 받죠?' },
  { role: 'assistant', content: '"여기서 번호를 드립니다." 민아가 표를 건넨다.' },
];

const B_RECENT_EXTRA: ChatMessage[] = [
  { role: 'user', content: '정문에서 출입 확인은 이미 했습니다.' },
  { role: 'assistant', content: '"정문 확인은 도윤이 처리했을 거예요." 민아가 명부를 대조한다.' },
  { role: 'user', content: '측정실 위치도 미리 알고 싶어요.' },
  { role: 'assistant', content: '"측정실은 복도 안쪽입니다. 지금은 등록만 하세요." 민아가 짧게 답한다.' },
  { role: 'user', content: '배경에 청소하는 분이 계시네요.' },
  { role: 'assistant', content: '설화는 로비 가장자리에서 대걸레만 정리하고, 대화에는 끼지 않는다.' },
  { role: 'user', content: '안내원은 지금 자리에 있나요?' },
  { role: 'assistant', content: '"지우, 등록 끝나면 로비에서 대기." 민아가 짧게 부른다.' },
  { role: 'user', content: '서류에 이름은 한글로만 쓰면 되나요?' },
  { role: 'assistant', content: '"한글이면 됩니다." 민아가 칸을 가리킨다.' },
];

function sceneBlock(s: Scene6): string {
  return [
    '### 현재 장면 (정본. 없는 항목을 창작하지 말 것)',
    `장소: ${s.place ?? ''}`,
    `시간: ${s.time ?? ''}`,
    `목표: ${s.goal ?? ''}`,
    `장르·분위기: ${s.genre ?? ''}`,
    `현재 갈등: ${s.conflict ?? ''}`,
    `현재 감정: ${s.mood ?? ''}`,
  ].join('\n');
}

function participantBlock(ids: string[], compressed: boolean): string {
  const rows = CAST.filter((c) => ids.includes(c.id));
  if (compressed) {
    return (
      '### 캐스트 (압축)\n' +
      rows.map((c) => `- ${c.name} (${c.role}/${c.place}): ${c.duties.join(',') || '배경'}`).join('\n')
    );
  }
  return (
    '### 참가자\n' +
    rows
      .map((c) => `- id=${c.id} 이름=${c.name} 역할=${c.role} 장소=${c.place} 업무=${c.duties.join(',') || '없음'}`)
      .join('\n')
  );
}

function historyBlock(recent: ChatMessage[]): string {
  return (
    '### 최근 메시지\n' +
    recent.map((m, i) => `${i + 1}. [${m.role}] ${m.content}`).join('\n')
  );
}

const CALL1_RULES = [
  '당신은 장면 상태 제안기다. 아래 JSON 객체 하나만 출력한다. 설명·코드펜스 금지.',
  '{"proposed_state_patch":{"place":"","time":"","goal":"","genre":"","conflict":"","mood":""}}',
  '허용 키는 위 6개뿐이다. 없는 값을 만들지 않는다. 검증 전에는 사실이 아니다.',
  'Model=proposal. Server=authority. State=result.',
].join('\n');

const CALL2_RULES = [
  '주 화자는 민아(npc_mina)다. 보조 화자는 지우(npc_jiu)다. 배경 인물은 발화하지 않는다.',
  '대사는 큰따옴표("") 안에 쓰고, 행동·표정은 서술문으로 쓴다. 한국어로 답한다.',
  '응답 길이는 4~10문장. 민아의 접수원 말투를 유지한다. 지우가 끼면 한 줄만.',
  '사용자 다음 행동·대사·생각을 만들지 않는다. AI·모델·프롬프트를 언급하지 않는다.',
  '소지품·능력·관계 변화·시간 경과를 장면에 없는 값으로 선언하지 않는다.',
].join('\n');

const COMPRESSED_LORE_UNIT =
  '압축로어: 아카데미 등록은 로비 접수(민아), 안내는 로비(지우), 기초 측정은 측정실(하린), 출입은 정문(도윤). 설화는 로비 배경이며 발화하지 않는다. 등록 서류는 한글 이름·대기번호·오전 접수 도장이면 충분하다. 측정은 등록 다음이다. 장면 6필드(장소·시간·목표·장르·갈등·감정) 외 시계 키는 쓰지 않는다. ';

/** Prompt-B pad target: 16K-adjacent, under CONTEXT_TOKENS. Locked. Do not retune after a run. */
export const PROMPT_B_TARGET_ESTIMATE = 12000;

function padLore(baseEst: number, target: number): string {
  if (baseEst >= target) return '';
  const unitEst = Math.max(1, estimateTokensRaw(COMPRESSED_LORE_UNIT));
  const n = Math.ceil((target - baseEst) / unitEst);
  return ('### 압축 로어\n' + COMPRESSED_LORE_UNIT.repeat(n)).trim();
}

function assemble(kind: 'A' | 'B', participantIds: string[], recent: ChatMessage[], compressed: boolean, pad: string): BuiltPrompt {
  const scene = SCENE_LOBBY;
  const sysExtra = [sceneBlock(scene), participantBlock(participantIds, compressed), historyBlock(recent), pad]
    .filter((s) => s.trim())
    .join('\n\n');
  const call1: ChatMessage[] = [
    { role: 'system', content: CALL1_RULES + '\n\n' + sysExtra },
    { role: 'user', content: USER_TURN },
  ];
  const call2: ChatMessage[] = [
    { role: 'system', content: CALL2_RULES + '\n\n' + sysExtra },
    { role: 'user', content: USER_TURN },
  ];
  return {
    kind,
    scene,
    main_speaker_id: 'npc_mina',
    secondary_speaker_id: 'npc_jiu',
    participant_ids: participantIds,
    recent,
    call1,
    call2,
    compressed_cast: compressed,
    est_tokens: Math.max(estimateMessages(call1), estimateMessages(call2)),
  };
}

export function buildPromptA(): BuiltPrompt {
  return assemble('A', ['npc_mina', 'npc_jiu', 'npc_bg'], A_RECENT, false, '');
}

export function buildPromptB(): BuiltPrompt {
  const ids = CAST.map((c) => c.id);
  const recent = [...A_RECENT, ...B_RECENT_EXTRA];
  const draft = assemble('B', ids, recent, true, '');
  const pad = padLore(draft.est_tokens, PROMPT_B_TARGET_ESTIMATE);
  const built = assemble('B', ids, recent, true, pad);
  if (built.est_tokens > LATENCY_CUT.context_tokens) {
    throw new Error(`Prompt-B est_tokens ${built.est_tokens} exceeds CONTEXT_TOKENS`);
  }
  return built;
}
