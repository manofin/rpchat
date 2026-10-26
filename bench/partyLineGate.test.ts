/**
 * npm run test:benches -- partyLineGate --output-dir <new directory>
 * (단독: npx tsx bench/partyLineGate.test.ts)
 *
 * U3 결정 문서 v1(planning_documents/party-unification-U3-decisions.md) §3·§4의 순수 검증기 시험.
 * DB·서버·모델 없음. 기대값은 이 파일 안에 사람이 쓴 상수다.
 * 재현 사례 문자열은 evidence/goal-dialog-output-probe-20261025/run.mjs 의 mixed·forbidden-first 와 같다.
 * 이 시험의 통과는 검증기 단계(B1·B2·B3·B7 대응)만 뜻한다. 중간 DB·GET·재열기 경계는 연결 단계 시험이다.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createLineGate,
  REMOVAL_REASONS,
  type EndReason,
  type GateTerminal,
  type LineGateConfig,
  type VerifiedUnit,
} from '../apps/server/src/prompt/partyLineGate.ts';
import { parseScript } from '../apps/server/src/prompt/dialogScript.ts';
import { resolveEventActor } from '../apps/server/src/contracts/chatActor.ts';

let checks = 0;
let assertions = 0;
const equal = (a: unknown, b: unknown, message?: string) => { assertions++; assert.deepEqual(a, b, message); };
const truth = (value: unknown, message?: string) => { assertions++; assert.ok(value, message); };
function t(name: string, fn: () => void) {
  const before = assertions; fn(); assert.ok(assertions > before, 'test must assert');
  console.log(`ok ${++checks} ${name}`);
}

const GOOD = 'SYNTH_ALLOWED_OUTPUT_20261025';
const BAD = 'SYNTH_FORBIDDEN_OUTPUT_20261025';
const PARTIAL = 'SYNTH_UNFINISHED_OUTPUT_20261025';

const HARIN = { id: 'actor-harin', name: '하린', aliases: ['하린이'] };
const NARIN = { id: 'actor-narin', name: '나린' };
const base: LineGateConfig = { allowed: [HARIN], roomCast: [HARIN, NARIN], userName: '서윤', allowNarration: true };

type Run = { pushed: VerifiedUnit[][]; term: GateTerminal; all: VerifiedUnit[] };
function run(deltas: string[], reason: EndReason = 'stop', config: LineGateConfig = base): Run {
  const gate = createLineGate(config);
  const pushed = deltas.map((d) => gate.push(d));
  const term = gate.end(reason);
  return { pushed, term, all: [...pushed.flat(), ...term.units] };
}
const shape = (units: VerifiedUnit[]) => units.map((u) => (u.kind === 'line' ? `${u.name}|${u.text}` : `~${u.text}`));
const zero = Object.fromEntries(REMOVAL_REASONS.map((r) => [r, 0]));
const removedOnly = (term: GateTerminal) => Object.fromEntries(Object.entries(term.removed).filter(([, n]) => n > 0));

t('allowed line and narration survive in order (positive control)', () => {
  const r = run(['문이 열린다.\n', `하린 | ${GOOD}\n`, '바람이 분다.\n']);
  equal(shape(r.all), ['~문이 열린다.', `하린|${GOOD}`, '~바람이 분다.']);
  equal(r.all.map((u) => u.seq), [1, 2, 3]);
  equal(r.term.status, 'ok');
  equal(r.term.removed, zero);
  const line = r.all[1];
  truth(line.kind === 'line' && line.actor_id === HARIN.id);
});

t('repro mixed: forbidden line and unfinished line never leave the gate while pending', () => {
  const gate = createLineGate(base);
  const first = gate.push(`하린 | ${GOOD}\n`);
  const second = gate.push(`금지인물 | ${BAD}\n하린 | ${PARTIAL}`);
  equal(shape(first), [`하린|${GOOD}`]);
  equal(second, [], 'nothing new is complete and valid yet');
  truth(!JSON.stringify([first, second]).includes(BAD));
  truth(!JSON.stringify([first, second]).includes(PARTIAL));
  const term = gate.end('stop');
  equal(shape(term.units), [`하린|${PARTIAL}`]);
  equal(term.status, 'ok');
  equal(removedOnly(term), { unknown_speaker: 1 });
  truth(!JSON.stringify(term).includes(BAD));
});

t('repro forbidden-first: first model line forbidden, valid tail kept on stop', () => {
  const r = run([`금지인물 | ${BAD}\n하린 | ${PARTIAL}`]);
  equal(r.pushed, [[]]);
  equal(shape(r.term.units), [`하린|${PARTIAL}`]);
  equal(r.term.status, 'ok');
  truth(!JSON.stringify(r).includes(BAD));
});

t('room cast member outside the allow-list is removed, not demoted to narration (new path only)', () => {
  const r = run([`나린 | ${BAD}\n`, `하린 | ${GOOD}\n`]);
  equal(shape(r.all), [`하린|${GOOD}`]);
  equal(removedOnly(r.term), { forbidden_speaker: 1 });
  // 기존 parseScript 는 같은 입력을 서술로 남긴다. 그 경로는 이 slice에서 바꾸지 않는다(D16).
  const legacy = parseScript(`나린 | ${BAD}\n하린 | ${GOOD}`, [HARIN], [HARIN, NARIN]);
  truth(legacy.items.some((i) => i.kind === 'narration' && i.text.includes(BAD)), 'legacy parser unchanged');
});

t('quarantine: unnamed lines after a removed speaker line are removed until a blank line', () => {
  const r = run([`나린 | ${BAD}\n${BAD}-continued\n\n다시 고요하다.\n`]);
  equal(shape(r.all), ['~다시 고요하다.']);
  equal(removedOnly(r.term), { forbidden_speaker: 1, quarantine: 1 });
  truth(!JSON.stringify(r).includes(BAD));
});

t('quarantine ends at the next valid speaker line', () => {
  const r = run([`나린 | ${BAD}\n하린 | ${GOOD}\n그녀가 웃는다.\n`]);
  equal(shape(r.all), [`하린|${GOOD}`, '~그녀가 웃는다.']);
  equal(removedOnly(r.term), { forbidden_speaker: 1 });
});

t('only forbidden lines -> speaker_violation_empty, zero units', () => {
  const r = run([`나린 | ${BAD}\n`, `금지인물 | ${BAD}`]);
  equal(r.all, []);
  equal(r.term.status, 'speaker_violation_empty');
  equal(r.term.unit_count, 0);
  equal(removedOnly(r.term), { forbidden_speaker: 1, unknown_speaker: 1 });
});

t('empty output -> empty; sentinel-only output -> empty', () => {
  equal(run([]).term.status, 'empty');
  equal(run(['   \n\n']).term.status, 'empty');
  const s = run(['NO_LINE\n']);
  equal(s.term.status, 'empty');
  equal(s.term.sentinels, 1);
});

const SPLIT_FIXTURE = '창밖에 비가 내린다.\r\n**하린** | 우산 가져왔어?\r\n금지인물 | ' + BAD + '\r\n' + BAD + ' 이어짐\r\n\r\n하린이 | 됐어, 가자.\n<choices>["가자","싫어","잠깐"]</choices>';

t('split invariance: every single split position gives the same units and terminal', () => {
  const whole = run([SPLIT_FIXTURE]);
  equal(shape(whole.all), ['~창밖에 비가 내린다.', '하린|우산 가져왔어?', '하린|됐어, 가자.']);
  equal(whole.term.choices, ['가자', '싫어', '잠깐']);
  for (let i = 0; i <= SPLIT_FIXTURE.length; i++) {
    const r = run([SPLIT_FIXTURE.slice(0, i), SPLIT_FIXTURE.slice(i)]);
    equal(r.all, whole.all, `split at ${i}`);
    equal({ ...r.term, units: [] }, { ...whole.term, units: [] }, `terminal at ${i}`);
  }
});

t('split invariance: one code point per delta gives the same result', () => {
  const whole = run([SPLIT_FIXTURE]);
  const r = run([...SPLIT_FIXTURE]);
  equal(r.all, whole.all);
  equal({ ...r.term, units: [] }, { ...whole.term, units: [] });
  truth(!JSON.stringify(r).includes(BAD));
});

t('CRLF and LF inputs give the same units', () => {
  const lf = run([`서술.\n하린 | ${GOOD}\n`]);
  const crlf = run([`서술.\r\n하린 | ${GOOD}\r\n`]);
  equal(crlf.all, lf.all);
});

t('tail without newline: kept on stop, dropped on every non-stop end', () => {
  equal(shape(run([`하린 | ${GOOD}\n하린 | ${PARTIAL}`], 'stop').all), [`하린|${GOOD}`, `하린|${PARTIAL}`]);
  for (const reason of ['length', 'timeout', 'abort', 'error'] as const) {
    const r = run([`하린 | ${GOOD}\n하린 | ${PARTIAL}`], reason);
    equal(shape(r.all), [`하린|${GOOD}`], reason);
    equal(r.term.status, 'incomplete', reason);
    equal(r.term.choices, null, reason);
    truth(!JSON.stringify(r).includes(PARTIAL), reason);
  }
});

t('user voice line is removed and starts quarantine', () => {
  const r = run([`서윤 | ${BAD}\n${BAD}\n`, `하린 | ${GOOD}\n`]);
  equal(shape(r.all), [`하린|${GOOD}`]);
  equal(removedOnly(r.term), { user_voice: 1, quarantine: 1 });
});

t('alias and NFKC/space folding resolve to the canonical server name', () => {
  const r = run([`하린이 | 하나\n`, `하 린 | 둘\n`, `ﾊ | 무시\n`]);
  const lines = r.all.filter((u) => u.kind === 'line');
  equal(lines.map((u) => u.kind === 'line' && [u.actor_id, u.name]), [[HARIN.id, '하린'], [HARIN.id, '하린']]);
  // 단일 일치 판정은 기존 resolveEventActor 와 같다.
  equal(resolveEventActor('하 린', [HARIN])?.id, HARIN.id);
});

t('a name shared by two allowed actors is never approved', () => {
  const twin = { id: 'actor-twin', name: '쌍둥이', aliases: ['하린이'] };
  const r = run([`하린이 | ${BAD}\n`, `하린 | ${GOOD}\n`], 'stop', { ...base, allowed: [HARIN, twin], roomCast: [HARIN, twin] });
  equal(shape(r.all), [`하린|${GOOD}`]);
  equal(removedOnly(r.term), { ambiguous_speaker: 1 });
});

t('decorated speaker names are normalized', () => {
  const r = run([`**하린** | 하나\n`, `> 하린: | 둘\n`, `[하린] | 셋\n`]);
  equal(shape(r.all), ['하린|하나', '하린|둘', '하린|셋']);
});

t('line cap removes lines past the cap without quarantining narration', () => {
  const r = run(['하린 | 1\n하린 | 2\n하린 | 3\n뒤이은 서술.\n'], 'stop', { ...base, maxLines: 2 });
  equal(shape(r.all), ['하린|1', '하린|2', '~뒤이은 서술.']);
  equal(removedOnly(r.term), { line_cap: 1 });
  equal(r.term.line_count, 2);
});

t('actor supplement mode: only that actor speaks, narration and continuation lines are removed', () => {
  const cfg: LineGateConfig = { ...base, allowed: [HARIN], allowNarration: false };
  const r = run([`하린 | ${GOOD}\n이어지는 말\n나린 | ${BAD}\nNO_LINE\n`], 'stop', cfg);
  equal(shape(r.all), [`하린|${GOOD}`]);
  equal(removedOnly(r.term), { narration_not_allowed: 1, forbidden_speaker: 1 });
  equal(r.term.sentinels, 1);
  equal(run(['NO_LINE'], 'stop', cfg).term.status, 'empty');
});

t('narration-only request (empty allow-list): every cast speaker line is removed', () => {
  const r = run([`하린 | ${BAD}\n안개가 짙다.\n`], 'stop', { ...base, allowed: [] });
  equal(shape(r.all), []);
  equal(removedOnly(r.term), { forbidden_speaker: 1, quarantine: 1 });
  equal(r.term.status, 'speaker_violation_empty');
});

t('thought tags and the 속마음 tail never reach a unit', () => {
  const r = run(['<think>\n', `나린 | ${BAD}\n`, '</think>\n', `하린 | ${GOOD}\n`, `속마음: ${BAD}\n`, `하린 | ${BAD}\n`]);
  equal(shape(r.all), [`하린|${GOOD}`]);
  equal(r.term.removed, zero, 'hidden text is not a speaker removal');
  equal(r.term.status, 'ok');
  truth(!JSON.stringify(r).includes(BAD));
});

t('a later hidden-text marker that rewrites an already classified line closes the gate (fail closed)', () => {
  // `속마음` 다음 줄이 `:` 로 시작하면 기존 정리 함수가 이미 분류한 줄까지 잘라낸다.
  const gate = createLineGate(base);
  equal(shape(gate.push('그는 속마음\n')), ['~그는 속마음']);
  equal(gate.push(`: ${BAD}\n하린 | ${GOOD}\n`), []);
  const term = gate.end('stop');
  equal([term.status, term.error_code, term.units], ['gate_error', 'gate_nonmonotonic', []]);
  truth(!JSON.stringify(term).includes(BAD));
});

t('choices are withheld from units and returned only on stop', () => {
  const text = `하린 | ${GOOD}\n<choices>["가","나","다"]</choices>`;
  const stop = run([text]);
  equal(shape(stop.all), [`하린|${GOOD}`]);
  equal(stop.term.choices, ['가', '나', '다']);
  truth(!JSON.stringify(stop.all).includes('choices'));
  equal(run([text], 'abort').term.choices, null);
});

t('buffer overflow closes the gate with gate_error and emits nothing after', () => {
  const gate = createLineGate({ ...base, maxBufferChars: 40 });
  equal(shape(gate.push(`하린 | ${GOOD}\n`)), [`하린|${GOOD}`]);
  equal(gate.push(`하린 | ${'가'.repeat(40)}\n`), []);
  equal(gate.push('하린 | 이후\n'), []);
  const term = gate.end('stop');
  equal([term.status, term.error_code, term.units, term.choices, term.unit_count], ['gate_error', 'gate_buffer_overflow', [], null, 1]);
});

t('overlong single line is removed', () => {
  const r = run([`하린 | ${'가'.repeat(30)}\n하린 | 짧다\n`], 'stop', { ...base, maxLineChars: 20 });
  equal(shape(r.all), ['하린|짧다']);
  equal(removedOnly(r.term), { overlong: 1 });
});

t('diagnostics carry counts only: no removed text, no forbidden names, no actor ids', () => {
  const r = run([`나린 | ${BAD}\n금지인물 | ${BAD}\n서윤 | ${BAD}\n`]);
  const serialized = JSON.stringify(r);
  for (const needle of [BAD, '나린', '금지인물', '서윤', NARIN.id]) truth(!serialized.includes(needle), needle);
  equal(Object.keys(r.term).sort(), ['choices', 'error_code', 'line_count', 'removed', 'sentinels', 'status', 'unit_count', 'units']);
});

t('calls after end throw', () => {
  const gate = createLineGate(base);
  gate.end('stop');
  assertions++; assert.throws(() => gate.push('x'), /closed/);
  assertions++; assert.throws(() => gate.end('stop'), /closed/);
});

t('long prefix before a pipe is prose, short unknown prefix is a removed speaker', () => {
  const prose = '이 길은 동쪽 성문으로 이어지는 오래된 상인의 길이다 | 표지판';
  const r = run([`${prose}\nA | B 구간\n\n끝.\n`]);
  equal(shape(r.all), [`~${prose}`, '~끝.']);
  equal(removedOnly(r.term), { unknown_speaker: 1 });
});

t('break_before marks a blank-line paragraph boundary', () => {
  const r = run(['첫 문단.\n\n둘째 문단.\n하린 | 말\n']);
  equal(r.all.map((u) => u.break_before), [false, true, false]);
});

t('module boundary: pure imports only', () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '../apps/server/src/prompt/partyLineGate.ts');
  const imports = [...fs.readFileSync(file, 'utf8').matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]).sort();
  equal(imports, ['../contracts/chatActor.js', '../contracts/chatEventAdapter.js', './templates.js']);
});

console.log(`${checks} checks passed`);
