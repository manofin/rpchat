/** npx tsx bench/storyEndingConditionsUi.test.ts
 * ADR-F8h 후속 "엔딩 조건 저작 UI (StoryEditor 확장)".
 * 구조 펜스는 ast-grep + tgrep (신규 원칙: 정규식 대신 AST 우선).
 * 폼 상태 변환은 순수 함수 단위 검증. React 렌더 없음.
 * Web-only slice: apps/web/src + bench. No server, no migration, no live DB.
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import {
  buildConditions,
  conditionsToDraft,
  emptyConditionsDraft,
  hasNarrativeHint,
} from '../apps/web/src/lib/endingConditions.ts';

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

/** ast-grep 구조 매칭 히트 수 (0 = 없음). 주석·문자열 오탐 원천 차단. */
function sg(pattern: string, file: string): number {
  try {
    const out = execSync(`ast-grep -p '${pattern}' --lang tsx ${file}`, { encoding: 'utf8' });
    return out.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    return 0; // ast-grep은 무매칭 시 exit 1
  }
}

/** tgrep 리터럴 매칭 히트 수. */
function tg(literal: string, file: string): number {
  try {
    const out = execSync(`tgrep search -F '${literal}' ${file}`, { encoding: 'utf8' });
    return out.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

const EDITOR = 'apps/web/src/components/StoryEditor.tsx';

async function main() {
  await t('buildConditions: full draft → wire shape', () => {
    const wire = buildConditions({
      minTurns: '10',
      stats: [{ key: '호감도', min: '3' }],
      flags: ['met_leader'],
      hint: '이름을 다시 불렀다',
    });
    assert.deepEqual(wire, {
      min_turns: 10,
      required_stats: { '호감도': { gte: 3 } },
      required_flags: ['met_leader'],
      narrative_hint: '이름을 다시 불렀다',
    });
  });

  await t('buildConditions: all empty → undefined ({} 송신 금지)', () => {
    assert.equal(buildConditions(emptyConditionsDraft()), undefined);
    assert.equal(buildConditions({ minTurns: '', stats: [], flags: ['  '], hint: '  ' }), undefined);
  });

  await t('buildConditions: min_turns 0/음수/NaN/소수 생략 (서버 400 방지)', () => {
    for (const v of ['0', '-3', 'abc', '2.5', '']) {
      assert.equal(buildConditions({ ...emptyConditionsDraft(), minTurns: v }), undefined, v);
    }
    assert.equal(buildConditions({ ...emptyConditionsDraft(), minTurns: '1' })?.min_turns, 1);
  });

  await t('buildConditions: 빈 Key·NaN 스탯 정제, 중복 키 1개, lte carrying', () => {
    const wire = buildConditions({
      ...emptyConditionsDraft(),
      stats: [
        { key: '', min: '5' },
        { key: '체력', min: 'NaN' },
        { key: ' 체력 ', min: '5', lte: '9' },
        { key: '체력', min: '7' },
      ],
    });
    assert.deepEqual(wire?.required_stats, { '체력': { gte: 5, lte: 9 } });
  });

  await t('buildConditions: flags trim + 빈 제거 + 중복 제거', () => {
    const wire = buildConditions({ ...emptyConditionsDraft(), flags: [' a ', '', 'a', 'b'] });
    assert.deepEqual(wire?.required_flags, ['a', 'b']);
  });

  await t('conditionsToDraft: wire → 폼, damaged → empty, never throws', () => {
    const d = conditionsToDraft({
      min_turns: 10,
      required_stats: { '호감도': { gte: 3, lte: 8 } },
      required_flags: ['x'],
      narrative_hint: 'h',
    });
    assert.equal(d.minTurns, '10');
    assert.deepEqual(d.stats, [{ key: '호감도', min: '3', lte: '8' }]);
    assert.deepEqual(d.flags, ['x']);
    assert.deepEqual(conditionsToDraft(undefined), emptyConditionsDraft());
    assert.deepEqual(conditionsToDraft(null as never), emptyConditionsDraft());
    assert.deepEqual(conditionsToDraft('garbage' as never), emptyConditionsDraft());
  });

  await t('round-trip: wire → draft → wire lossless (lte 포함)', () => {
    const wire = {
      min_turns: 7,
      required_stats: { '호감도': { gte: 2, lte: 6 } },
      required_flags: ['met'],
      narrative_hint: '힌트',
    };
    assert.deepEqual(buildConditions(conditionsToDraft(wire)), wire);
  });

  await t('hasNarrativeHint: 공백은 비용 고지 없음', () => {
    assert.equal(hasNarrativeHint({ ...emptyConditionsDraft(), hint: ' x ' }), true);
    assert.equal(hasNarrativeHint({ ...emptyConditionsDraft(), hint: '   ' }), false);
  });

  await t('sg: 저장 경로가 buildConditions(e.cond)로 정제 (AST, 주석 오탐 없음)', () => {
    assert.ok(sg('buildConditions($C)', EDITOR) >= 1, 'save path sanitizes via buildConditions');
    assert.ok(sg('conditionsToDraft($C)', EDITOR) >= 1, 'load path restores via conditionsToDraft');
    assert.ok(sg('patchCond($I, $F)', EDITOR) >= 1, 'per-ending draft updater');
  });

  await t('sg: 구 pass-through (conditions: e.conditions) 소멸 확인', () => {
    assert.equal(sg('conditions: e.conditions', EDITOR), 0, 'raw pass-through must be gone');
  });

  await t('tgrep: 비용 고지 문구 + 4종 폼 필드 존재 (리터럴)', () => {
    assert.ok(tg('백그라운드 LLM 판정', EDITOR) >= 1, 'cost notice');
    assert.ok(tg('도달 조건 — 최소 턴 수', EDITOR) >= 1, 'min_turns field');
    assert.ok(tg('도달 조건 — 필요 스탯', EDITOR) >= 1, 'stats field');
    assert.ok(tg('도달 조건 — 필요 플래그', EDITOR) >= 1, 'flags field');
    assert.ok(tg('도달 조건 — 서사 힌트', EDITOR) >= 1, 'hint field');
  });

  console.log(`PASS=${passed}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
