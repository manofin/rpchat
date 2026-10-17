import { estimateTokens } from './tokens.js';

export type PartyCard = {
  name: string;
  tagline: string;
  description: string;
  personality: string;
  speech_style: string;
  taboos: string;
  scenario: string;
};

export type PartyContextInput = {
  storySnapshot: { setting: string; minorCast: unknown[] };
  cards: Record<string, PartyCard>;
  allowedSpeakerIds: string[];
  presentIds: string[];
  sceneState: string;
  items: Array<{ id: string; kind: string; text: string; allowedRecipients: string[] }>;
  requestRecipients: string[];
  // 입력 한도는 출력 예약을 제외한 값이다. 호출자는 지시문·사용자 입력도 따로 예약한다.
  budget: { inputLimitTokens: number; outputReserveTokens: number; calibration: number };
  estimate?: typeof estimateTokens;
};

export type PartyContextSection = {
  key: string;
  title: string;
  text: string;
  sourceIds: string[];
  estTokens: number;
};

export type PartyContextDiagnostic = {
  key: string;
  sourceIds: string[];
  status: 'included_full' | 'truncated' | 'omitted';
  reason: 'full' | 'not_permitted' | 'budget' | 'empty';
  estTokens: number;
};

export class PartyContextOverflowError extends Error {
  readonly code = 'party_context_overflow';
  readonly shortfallTokens: number;

  constructor(readonly requiredTokens: number, readonly inputLimitTokens: number) {
    super(`party_context_overflow: ${requiredTokens - inputLimitTokens} tokens short`);
    this.name = 'PartyContextOverflowError';
    this.shortfallTokens = requiredTokens - inputLimitTokens;
  }
}

type SectionDraft = Omit<PartyContextSection, 'estTokens'>;

export function renderPartyContextSections(sections: readonly SectionDraft[]): string {
  return sections.map((s) => `## ${s.title}\n${s.text}`).join('\n\n');
}

/** 값으로 받은 동결 맥락만 구성한다. DB·설정 조회나 생성 경로 연결은 하지 않는다. */
export function buildPartyContext(input: PartyContextInput) {
  const { inputLimitTokens, outputReserveTokens, calibration } = input.budget;
  if (!Number.isSafeInteger(inputLimitTokens) || inputLimitTokens < 0
    || !Number.isSafeInteger(outputReserveTokens) || outputReserveTokens < 0
    || !Number.isFinite(calibration) || calibration <= 0) {
    throw new RangeError('Invalid party context budget');
  }
  if (!input.requestRecipients.length || input.requestRecipients.some((id) => !id)) {
    throw new TypeError('requestRecipients must contain explicit recipient IDs');
  }
  const estimate = input.estimate ?? estimateTokens;
  const tokens = (sections: readonly SectionDraft[]) => {
    const n = estimate(renderPartyContextSections(sections), calibration);
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('Invalid token estimate');
    return n;
  };
  const sections: PartyContextSection[] = [];
  const diagnostics: PartyContextDiagnostic[] = [];
  const omit = (key: string, sourceIds: string[], reason: 'not_permitted' | 'budget' | 'empty') => {
    diagnostics.push({ key, sourceIds, status: 'omitted', reason, estTokens: 0 });
  };
  const cardOf = (id: string) => {
    if (!Object.hasOwn(input.cards, id)) throw new TypeError(`Missing card for ${id}`);
    return input.cards[id];
  };
  let used = 0;
  const include = (s: SectionDraft, required: boolean): boolean => {
    if (!s.text.trim()) {
      omit(s.key, s.sourceIds, 'empty');
      return true;
    }
    const total = tokens([...sections, s]);
    if (!required && total > inputLimitTokens) {
      omit(s.key, s.sourceIds, 'budget');
      return false;
    }
    // 헤더·구분자와 반올림을 포함한 누적 증가분이라 구간 합이 전체 추정치와 같다.
    const estTokens = total - used;
    if (estTokens < 0) throw new RangeError('Token estimator must be monotone');
    sections.push({ ...s, estTokens });
    diagnostics.push({ key: s.key, sourceIds: s.sourceIds, status: 'included_full', reason: 'full', estTokens });
    used = total;
    return true;
  };

  include({ key: 'scene', title: '서버 확정 상태', text: input.sceneState, sourceIds: ['sceneState'] }, true);
  const presentIds = [...new Set(input.presentIds)];
  const roster = presentIds.map((id) => `${cardOf(id).name} [${id}]`).join('\n');
  include({ key: 'roster', title: '현재 장면의 현장 명단', text: roster, sourceIds: presentIds }, true);
  include({ key: 'setting', title: '스토리 설정', text: input.storySnapshot.setting, sourceIds: ['storySnapshot.setting'] }, true);

  const fields: Array<[keyof PartyCard, string]> = [
    ['name', '이름'], ['tagline', '한 줄 소개'], ['description', '설명'],
    ['personality', '성격'], ['speech_style', '말투'], ['taboos', '금기'], ['scenario', '배경'],
  ];
  for (const id of [...new Set(input.allowedSpeakerIds)]) {
    const card = cardOf(id);
    const lines: string[] = [];
    for (const [field, label] of fields) {
      const value = card[field];
      if (typeof value !== 'string') throw new TypeError(`Invalid card field: ${id}.${field}`);
      if (value.trim()) lines.push(`${label}: ${value}`);
      else omit(`card:${id}:${field}`, [id], 'empty');
    }
    include({ key: `card:${id}`, title: `허용 화자 카드 [${id}]`, text: lines.join('\n'), sourceIds: [id] }, true);
  }
  // 필수 구간 전체를 계산한 뒤 오류를 낸다. 부분 sections는 반환하지 않는다.
  if (used > inputLimitTokens) throw new PartyContextOverflowError(used, inputLimitTokens);

  let prefixDropped = false;
  input.storySnapshot.minorCast.forEach((entry, index) => {
    const key = `minor:${index}`;
    if (prefixDropped) {
      omit(key, [key], 'budget');
      return;
    }
    const text = entry == null ? '' : typeof entry === 'string' ? entry : JSON.stringify(entry);
    if (typeof text !== 'string') throw new TypeError('minorCast entry is not JSON serializable');
    if (!include({ key, title: `조연 ${index + 1}`, text, sourceIds: [key] }, false)) prefixDropped = true;
  });
  for (const item of input.items) {
    const key = `item:${item.id}`;
    if (!input.requestRecipients.every((id) => item.allowedRecipients.includes(id))) {
      omit(key, [item.id], 'not_permitted');
      continue;
    }
    include({ key, title: `추가 맥락 (${item.kind})`, text: item.text, sourceIds: [item.id] }, false);
  }
  return {
    sections,
    diagnostics: {
      requestRecipients: [...new Set(input.requestRecipients)],
      sections: diagnostics,
      totalEstimatedTokens: used,
      inputLimitTokens,
      outputReserveTokens,
      calibration,
      usage: null,
    },
  };
}
