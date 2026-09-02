/**
 * Freeze Accuracy N=200 and Reach N=100 JSON. Labels assigned here, independent of a run.
 * Do not re-run after seeing results to reshuffle mix (§0-2).
 * Usage: npx tsx bench/partyBench/build-fixtures.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAST, SCENE_GATE, SCENE_LAB, SCENE_LOBBY } from './cast.ts';
import type { AccuracyCase, ReachCase, Scene6 } from './types.ts';

const PEOPLE = [CAST[0], CAST[1], CAST[2], CAST[3]] as const; // exclude background
const FORBIDDEN_BG = ['npc_bg'];

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0');
}

function explicitText(person: (typeof PEOPLE)[number], i: number): string {
  const forms = [
    `${person.name}, 이쪽으로 와 줄래요? 표식 ${i}.`,
    `${person.name} 씨, 지금 창구에서 불러요. 표식 ${i}.`,
    `${person.name} 님 계시면 손 들어 주세요. 표식 ${i}.`,
    `저기 ${person.name}, 한 번만 봐 주세요. 표식 ${i}.`,
    `${person.aliases[0]} 호출합니다. 표식 ${i}.`,
  ];
  return forms[i % forms.length];
}

function dutyText(person: (typeof PEOPLE)[number], i: number): string {
  const d0 = person.duties[0];
  const forms = [
    `${d0} 절차를 이어서 진행해 주세요. 표식 ${i}.`,
    `오늘 ${d0} 업무 담당이 누구든 받아 주세요. 표식 ${i}.`,
    `${d0} 관련해서 다음 단계가 필요해요. 표식 ${i}.`,
    `이 건은 ${d0} 창구 일입니다. 표식 ${i}.`,
    `${d0}만 처리되면 됩니다. 표식 ${i}.`,
  ];
  return forms[i % forms.length];
}

function locationText(i: number): string {
  const forms = [
    `지금 이 방에 계신 분이 응대해 주시면 됩니다. 표식 ${i}.`,
    `여기 있는 담당자에게 물어볼게요. 표식 ${i}.`,
    `이 공간에서 다음을 진행하고 싶습니다. 표식 ${i}.`,
    `방 안에 남은 사람에게 말할게요. 표식 ${i}.`,
    `이 위치에서 진행해 주세요. 표식 ${i}.`,
  ];
  return forms[i % forms.length];
}

function ambiguousText(i: number): string {
  const forms = [
    `그래서 이제 어떻게 하죠? 표식 ${i}.`,
    `잠깐, 생각 좀 해볼게요. 표식 ${i}.`,
    `다음이 뭔지 잘 모르겠어요. 표식 ${i}.`,
    `누가 먼저 말해도 상관없어요. 표식 ${i}.`,
    `그냥 상황을 지켜볼게요. 표식 ${i}.`,
  ];
  return forms[i % forms.length];
}

function sceneForPerson(person: (typeof PEOPLE)[number]): Scene6 {
  if (person.place === '측정실') return { ...SCENE_LAB };
  if (person.place === '정문') return { ...SCENE_GATE };
  return { ...SCENE_LOBBY };
}

function accuracyCases(): AccuracyCase[] {
  const out: AccuracyCase[] = [];
  for (let i = 1; i <= 50; i++) {
    const person = PEOPLE[(i - 1) % PEOPLE.length];
    out.push({
      id: `A${pad(i, 2)}`,
      bucket: 'explicit_name',
      expected_stage: 1,
      expected_main_speaker_id: person.id,
      forbidden_speakers: FORBIDDEN_BG,
      user_text: explicitText(person, i),
      scene: sceneForPerson(person),
      cast: CAST,
    });
  }
  for (let i = 1; i <= 50; i++) {
    const person = PEOPLE[(i - 1) % PEOPLE.length];
    out.push({
      id: `B${pad(i, 2)}`,
      bucket: 'duty_fit',
      expected_stage: 2,
      expected_main_speaker_id: person.id,
      forbidden_speakers: FORBIDDEN_BG,
      user_text: dutyText(person, i),
      scene: { ...SCENE_LOBBY },
      cast: CAST,
    });
  }
  for (let i = 1; i <= 50; i++) {
    const person = i % 2 === 1 ? CAST[2] : CAST[3]; // 하린 측정실 / 도윤 정문 — unique occupant
    out.push({
      id: `C${pad(i, 2)}`,
      bucket: 'scene_position',
      expected_stage: 3,
      expected_main_speaker_id: person.id,
      forbidden_speakers: FORBIDDEN_BG,
      user_text: locationText(i),
      scene: person.place === '측정실' ? { ...SCENE_LAB } : { ...SCENE_GATE },
      cast: CAST,
    });
  }
  for (let i = 1; i <= 50; i++) {
    out.push({
      id: `D${pad(i, 2)}`,
      bucket: 'ambiguous',
      expected_stage: 4,
      expected_main_speaker_id: 'npc_mina',
      forbidden_speakers: FORBIDDEN_BG,
      user_text: ambiguousText(i),
      scene: { ...SCENE_LOBBY },
      cast: CAST,
    });
  }
  return out;
}

function reachCases(): ReachCase[] {
  const out: ReachCase[] = [];
  for (let i = 1; i <= 50; i++) {
    const person = PEOPLE[(i - 1) % PEOPLE.length];
    out.push({
      id: `R-E${pad(i, 2)}`,
      bucket: 'explicit_name',
      user_text: explicitText(person, 100 + i),
      scene: sceneForPerson(person),
      cast: CAST,
    });
  }
  for (let i = 1; i <= 30; i++) {
    const person = PEOPLE[(i - 1) % PEOPLE.length];
    out.push({
      id: `R-U${pad(i, 2)}`,
      bucket: 'duty_fit',
      user_text: dutyText(person, 200 + i),
      scene: { ...SCENE_LOBBY },
      cast: CAST,
    });
  }
  for (let i = 1; i <= 10; i++) {
    const person = i % 2 === 1 ? CAST[2] : CAST[3];
    out.push({
      id: `R-L${pad(i, 2)}`,
      bucket: 'scene_position',
      user_text: locationText(300 + i),
      scene: person.place === '측정실' ? { ...SCENE_LAB } : { ...SCENE_GATE },
      cast: CAST,
    });
  }
  for (let i = 1; i <= 10; i++) {
    out.push({
      id: `R-M${pad(i, 2)}`,
      bucket: 'ambiguous',
      user_text: ambiguousText(400 + i),
      scene: { ...SCENE_LOBBY },
      cast: CAST,
    });
  }
  return out;
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const acc = accuracyCases();
const reach = reachCases();
if (acc.length !== 200) throw new Error(`accuracy N=${acc.length} != 200`);
if (reach.length !== 100) throw new Error(`reach N=${reach.length} != 100`);
fs.mkdirSync(path.join(dir, 'fixtures'), { recursive: true });
fs.writeFileSync(path.join(dir, 'fixtures/accuracy.json'), JSON.stringify({ n: acc.length, cases: acc }, null, 2) + '\n');
fs.writeFileSync(path.join(dir, 'fixtures/reach.json'), JSON.stringify({ n: reach.length, cases: reach }, null, 2) + '\n');
console.log(`wrote fixtures/accuracy.json n=${acc.length}`);
console.log(`wrote fixtures/reach.json n=${reach.length}`);
