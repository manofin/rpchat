/**
 * f9-live-scene-delta — Turn Pipeline step 2 (Scene Delta Proposal).
 *
 * Pure: builds the proposal prompt, parses the model's reply, and reads the
 * scene's current version. No DB, no fetch, no model. Validation and application
 * stay in applySceneDelta (A-3 State Authority Matrix); nothing here is trusted.
 *
 * The prompt advertises only catalog-allowed values and only the
 * server-appliable keys. When catalog.cast is present, present_ids_add /
 * present_ids_remove are included (names and aliases, not UUIDs). Wholesale
 * present_ids is never advertised. Approval-gated fields (relationship,
 * memories) and server-owned counters are never mentioned.
 *
 * f9-extra-approve removed `secondary_triggers` from this prompt. §4.3: who is
 * worth interrupting for is not a model field. Extras are opened by a transition
 * the server itself applied, so asking the model to nominate them only produced
 * a nomination per scene regardless of need (`bench/dutyAttribution`).
 */
import { ADVANCE_MINUTES_MAX, type PartyCatalog } from './applySceneDelta.js';
import type { Scene } from '../types.js';

/** Reads the scene's canonical version. Anything not a non-negative integer is 0. */
export function currentSceneVersion(scene: Scene): number {
  const v = (scene as { scene_version?: unknown }).scene_version;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
}

function list(values: string[]): string {
  return values.length ? values.join(', ') : '(없음)';
}

function occupancyLine(scene: Scene, catalog: PartyCatalog): string | null {
  if (!catalog.cast?.length) return null;
  if (!Array.isArray(scene.present_ids)) return '- 참석: (미선언)';
  if (scene.present_ids.length === 0) return '- 참석: (없음)';
  const names = scene.present_ids.map(
    (id) => catalog.cast!.find((c) => c.id === id)?.name ?? id,
  );
  return `- 참석: ${names.join(', ')}`;
}

function presenceAllowLines(catalog: PartyCatalog): string[] {
  const cast = catalog.cast;
  if (!cast?.length) return [];
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const m of cast) {
    for (const tok of [m.name, ...(m.aliases ?? [])]) {
      if (!tok || seen.has(tok)) continue;
      seen.add(tok);
      tokens.push(tok);
    }
  }
  return [
    `- present_ids_add: 참석에 넣을 이름 배열. 허용: ${list(tokens)}`,
    `- present_ids_remove: 참석에서 뺄 이름 배열. 같은 허용 목록.`,
  ];
}

export function renderSceneDeltaPrompt(input: {
  scene: Scene;
  catalog: PartyCatalog;
  userText: string;
}): string {
  const { scene, catalog } = input;
  const version = currentSceneVersion(scene);
  const arc = scene.arc ?? '(미설정)';
  const stagesForArc = scene.arc ? (catalog.stagesByArc[scene.arc] ?? []) : [];
  const activeFlags = (scene.flags ?? []).map((f) => f.key);
  const flagKeys = Object.keys(catalog.flags);

  const occupancy = occupancyLine(scene, catalog);

  return [
    '너는 장면 진행 판정기다. 서사나 대사를 쓰지 않는다. 아래 사용자 입력으로 장면 상태가 실제로 바뀌었는지만 판정한다.',
    '',
    '## 현재 상태',
    `- 장소(location): ${scene.location ?? '(미설정)'}`,
    `- 날씨(weather): ${scene.weather ?? '(미설정)'}`,
    `- 아크(arc): ${arc}`,
    `- 단계(stage): ${scene.stage ?? '(미설정)'}`,
    `- 시각(clock_minutes): ${scene.clock_minutes ?? 0}`,
    `- 켜진 플래그: ${list(activeFlags)}`,
    ...(occupancy ? [occupancy] : []),
    '',
    '## 허용 값 (이 목록 밖의 값은 전부 무시된다)',
    `- location: ${list(catalog.locations)}`,
    `- weather: ${list(catalog.weathers)}`,
    `- arc: ${list(catalog.arcs)}`,
    `- 현재 arc의 stage: ${list(stagesForArc)}`,
    `- flags: ${list(flagKeys)} (각각 true/false)`,
    `- advance_minutes: 0 이상 ${ADVANCE_MINUTES_MAX} 이하의 정수`,
    `- hp_delta / money_delta: 정수. 결과 HP는 0..9999, money는 0 이상. 범위 밖이면 이전 값 유지`,
    `- inventory_add / inventory_remove: 아이템 id 문자열 또는 배열. 허용: ${list(catalog.items ?? [])}`,
    ...presenceAllowLines(catalog),
    '',
    '## 사용자 입력',
    input.userText,
    '',
    '## 출력 형식',
    '오직 JSON 하나만 출력한다. 설명·머리말·코드펜스 밖 문장을 쓰지 않는다.',
    `base_version 은 반드시 ${version} 이어야 한다. 다른 값이면 제안 전체가 폐기된다.`,
    '바뀐 것이 없으면 base_version 만 담은 객체를 낸다.',
    '',
    `{"base_version": ${version}}`,
    '',
    '바뀐 것이 있으면 바뀐 키만 추가한다. 모든 키는 최상위에 둔다(중첩 금지). 예:',
    `{"base_version": ${version}, "stage": "...", "flags": {"...": true}, "advance_minutes": 5}`,
  ].join('\n');
}

/**
 * Extracts the first JSON object from the model's reply.
 * Any failure returns null; the caller then discards the patch and keeps the turn alive (A-6).
 */
export function parseSceneDelta(text: string): Record<string, unknown> | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
