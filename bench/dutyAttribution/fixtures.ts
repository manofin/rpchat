/**
 * f9-duty-attribution-eval — holdout fixtures.
 * New cast, new events. 한소연 / 유키 / 직원B are deliberately absent (prereg §2).
 * Setting: a hospital-adjacent research facility — unrelated to the bureau lobby scenes.
 */
export type Attr = {
  duties: string[];
  authority: string[];
  relationships: string[];
  exclusive_knowledge: string[];
  current_action: string[];
};
export type Cand = { id: string; name: string; attrs: Attr; type: 'A'|'B'|'C'|'D'|'E'|'F'|'G'|'H'|'P' };

const A = (p: Partial<Attr> = {}): Attr => ({
  duties: [], authority: [], relationships: [], exclusive_knowledge: [], current_action: [], ...p,
});

export const CAST: Record<string, Cand> = {
  // primary in most scenarios
  jin:    { id: 'jin',    name: '진 실장',   type: 'P', attrs: A({ duties: ['연구동 운영', '출입 승인'], authority: ['구역 폐쇄 지시'] }) },
  // A: has duties, unrelated
  ha:     { id: 'ha',     name: '하 회계',   type: 'A', attrs: A({ duties: ['시설 회계', '비품 구매'] }) },
  // B: lexical overlap, different meaning
  no:     { id: 'no',     name: '노 주임',   type: 'B', attrs: A({ duties: ['신규 직원 등록 관리'] }) },
  // C: negation in the attribute
  ban:    { id: 'ban',    name: '반 기사',   type: 'C', attrs: A({ duties: ['장비 운반'], authority: ['위험물 등록 권한 없음'] }) },
  // D: duty similar to primary's
  seok:   { id: 'seok',   name: '석 부실장', type: 'D', attrs: A({ duties: ['연구동 운영 보조'] }) },
  // E: no duties, but sole witness
  mi:     { id: 'mi',     name: '미 청소원', type: 'E', attrs: A({ exclusive_knowledge: ['사고 순간을 직접 목격한 유일한 사람'] }) },
  // F: relationship-based
  yeon:   { id: 'yeon',   name: '연 보호자', type: 'F', attrs: A({ relationships: ['쓰러진 연구원의 보호자'], exclusive_knowledge: ['당사자 지병 이력'] }) },
  // G: current-action based
  tae:    { id: 'tae',    name: '태 인턴',   type: 'G', attrs: A({ duties: ['자료 정리'], current_action: ['지금 비상 경보 패널을 조작하는 중'] }) },
  // H: relevant duty but primary already covered it
  gu:     { id: 'gu',     name: '구 안전관', type: 'H', attrs: A({ duties: ['안전 점검'] }) },
  // legitimate DUTY-type correct answers
  yun:    { id: 'yun',    name: '윤 대응관', type: 'P', attrs: A({ duties: ['시설 사고 대응', '인원 대피'], authority: ['대피 명령'] }) },
  do:     { id: 'do',     name: '도 의무관', type: 'P', attrs: A({ duties: ['응급 처치'], authority: ['이송 결정'] }) },
};

export type Scenario = {
  id: string; bucket: 'T'|'N'; event: string; primary: string;
  candidates: string[]; correct: string[];  // correct = ids that SHOULD be approved ([] for N)
};

export const SCENARIOS: Scenario[] = [
  // ---- T: exactly one legitimate secondary ----
  { id:'T01', bucket:'T', event:'통제 실패로 주변 인원이 위험해졌습니다. 어떻게 하죠?', primary:'jin', candidates:['yun','ha','no'], correct:['yun'] },
  { id:'T02', bucket:'T', event:'연구원 한 명이 갑자기 쓰러졌어요.', primary:'jin', candidates:['do','ha','seok'], correct:['do'] },
  { id:'T03', bucket:'T', event:'아무도 못 봤다는데, 사고가 어떻게 시작됐는지 알아야 해요.', primary:'jin', candidates:['mi','ha','no'], correct:['mi'] },
  { id:'T04', bucket:'T', event:'쓰러진 분한테 지병이 있는지 확인해야 합니다.', primary:'jin', candidates:['yeon','ha','ban'], correct:['yeon'] },
  { id:'T05', bucket:'T', event:'경보를 지금 꺼야 대화가 됩니다.', primary:'jin', candidates:['tae','ha','no'], correct:['tae'] },
  { id:'T06', bucket:'T', event:'가스가 새는 것 같아요. 사람들을 내보내야 하나요?', primary:'jin', candidates:['yun','seok','ha'], correct:['yun'] },
  { id:'T07', bucket:'T', event:'출혈이 멈추질 않습니다.', primary:'jin', candidates:['do','no','ban'], correct:['do'] },
  { id:'T08', bucket:'T', event:'CCTV가 꺼져 있었대요. 목격자가 필요해요.', primary:'jin', candidates:['mi','seok','ha'], correct:['mi'] },
  { id:'T09', bucket:'T', event:'환자 가족한테 연락이 닿아야 동의를 받습니다.', primary:'jin', candidates:['yeon','no','gu'], correct:['yeon'] },
  { id:'T10', bucket:'T', event:'패널이 계속 울려서 안내 방송이 안 들려요.', primary:'jin', candidates:['tae','ha','ban'], correct:['tae'] },
  { id:'T11', bucket:'T', event:'2층 전체를 비워야 할 것 같습니다.', primary:'jin', candidates:['yun','no','ha'], correct:['yun'] },
  { id:'T12', bucket:'T', event:'의식이 없는데 옮겨도 되나요?', primary:'jin', candidates:['do','seok','ha'], correct:['do'] },
  { id:'T13', bucket:'T', event:'사고 직전에 누가 그 방에 들어갔는지 아무 기록이 없어요.', primary:'jin', candidates:['mi','no','ban'], correct:['mi'] },
  { id:'T14', bucket:'T', event:'보호자 동의 없이는 처치를 못 한다고 들었습니다.', primary:'jin', candidates:['yeon','gu','ha'], correct:['yeon'] },
  { id:'T15', bucket:'T', event:'지금 알람 조작하는 사람한테 상태를 물어봐야 합니다.', primary:'jin', candidates:['tae','no','seok'], correct:['tae'] },
  { id:'T16', bucket:'T', event:'대피 명령을 내릴 권한이 누구한테 있나요?', primary:'jin', candidates:['yun','ban','ha'], correct:['yun'] },
  { id:'T17', bucket:'T', event:'응급 이송을 부를지 말지 결정해야 합니다.', primary:'jin', candidates:['do','gu','no'], correct:['do'] },
  { id:'T18', bucket:'T', event:'그 순간에 복도에 있던 사람이 한 명 있었다고 합니다.', primary:'jin', candidates:['mi','ha','seok'], correct:['mi'] },
  { id:'T19', bucket:'T', event:'당사자가 평소에 약을 먹었는지 알아야 해요.', primary:'jin', candidates:['yeon','no','ban'], correct:['yeon'] },
  { id:'T20', bucket:'T', event:'경보 패널을 만지고 있는 사람이 뭘 하는지 모르겠어요.', primary:'jin', candidates:['tae','gu','ha'], correct:['tae'] },

  // ---- N: no legitimate secondary; distractors only ----
  { id:'N01', bucket:'N', event:'출입 승인 절차가 어떻게 되나요?', primary:'jin', candidates:['ha','no','ban'], correct:[] },
  { id:'N02', bucket:'N', event:'연구동 운영 시간이 어떻게 되죠?', primary:'jin', candidates:['seok','ha','no'], correct:[] },
  { id:'N03', bucket:'N', event:'등록되지 않은 위험물이 발견됐다는데 절차가 뭔가요?', primary:'jin', candidates:['no','ban','ha'], correct:[] },
  { id:'N04', bucket:'N', event:'비품 신청은 어디에 하나요?', primary:'jin', candidates:['ha','seok','gu'], correct:[] },
  { id:'N05', bucket:'N', event:'출입증을 잃어버렸어요.', primary:'jin', candidates:['no','ha','ban'], correct:[] },
  { id:'N06', bucket:'N', event:'실장님이 방금 다 설명해 주셔서 이해했습니다. 감사합니다.', primary:'jin', candidates:['gu','ha','no'], correct:[] },
  { id:'N07', bucket:'N', event:'연구동 배치도를 볼 수 있을까요?', primary:'jin', candidates:['seok','ha','ban'], correct:[] },
  { id:'N08', bucket:'N', event:'위험물 등록은 누가 하나요?', primary:'jin', candidates:['ban','no','ha'], correct:[] },
  { id:'N09', bucket:'N', event:'회계 정산은 월말인가요?', primary:'jin', candidates:['ha','no','seok'], correct:[] },
  { id:'N10', bucket:'N', event:'신규 직원 등록은 며칠 걸리나요?', primary:'jin', candidates:['no','ha','gu'], correct:[] },
  { id:'N11', bucket:'N', event:'구역 폐쇄는 어떤 기준으로 하나요?', primary:'jin', candidates:['seok','ban','ha'], correct:[] },
  { id:'N12', bucket:'N', event:'장비를 어디로 옮기면 되나요?', primary:'jin', candidates:['ban','ha','no'], correct:[] },
  { id:'N13', bucket:'N', event:'안전 점검은 이미 끝났다고 실장님이 알려주셨어요.', primary:'jin', candidates:['gu','seok','ha'], correct:[] },
  { id:'N14', bucket:'N', event:'자료 정리는 어디에 보관하나요?', primary:'jin', candidates:['ha','no','seok'], correct:[] },
  { id:'N15', bucket:'N', event:'운영 보조 업무 범위가 어떻게 되나요?', primary:'jin', candidates:['seok','ha','ban'], correct:[] },
  { id:'N16', bucket:'N', event:'주차는 어디에 하면 되죠?', primary:'jin', candidates:['ha','no','gu'], correct:[] },
  { id:'N17', bucket:'N', event:'등록 서류 양식이 바뀌었나요?', primary:'jin', candidates:['no','ha','ban'], correct:[] },
  { id:'N18', bucket:'N', event:'점검 결과는 방금 들었습니다. 더 필요한 건 없어요.', primary:'jin', candidates:['gu','no','ha'], correct:[] },
  { id:'N19', bucket:'N', event:'비품 구매 승인은 얼마까지 가능한가요?', primary:'jin', candidates:['ha','seok','no'], correct:[] },
  { id:'N20', bucket:'N', event:'운반 일정은 언제인가요?', primary:'jin', candidates:['ban','ha','no'], correct:[] },
];
