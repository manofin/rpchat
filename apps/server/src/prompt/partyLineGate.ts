/**
 * U3 출력 경계 — 다대일 대화 출력의 줄 단위 검증기(순수 모듈).
 *
 * 결정 근거: planning_documents/party-unification-U3-decisions.md v4 §4·§5·§6.
 * 모델 델타를 받아 완성된 줄만 검증하고, 검증을 통과한 단위만 돌려준다.
 * 호출부는 이 결과만 저장·전송한다. 원문 버퍼·제거된 줄은 밖으로 나가지 않는다.
 *
 * - 줄은 개행에서만 완성된다. 개행 없는 꼬리는 정상 종료(stop)일 때만 인정한다(D5).
 * - `이름 | 대사` 한 줄 문법만 인정한다. 허용 목록에서 정확히 한 인물에 맞아야 대사다(D6·D8).
 * - 위반 화자 줄은 서술로 바꾸지 않고 제거하며, 뒤따르는 무명 줄은 빈 줄이나
 *   다음 유효 대사까지 격리한다(D4·D7).
 * - 생각 태그·속마음 꼬리·선택지는 기존 sanitizeGeneratedContent 의 가시 문자열 기준으로
 *   걸러낸다. 이미 분류한 가시 줄이 바뀌면 닫는다(gate_nonmonotonic).
 * - 진단에는 사유별 개수만 둔다. 제거된 원문·이름·id를 담지 않는다(D14).
 *
 * 기존 parseScript(dialogScript.ts)는 바꾸지 않는다. 기존 경로는 그대로 금지 줄을 서술로 남긴다.
 *
 * Pure: no DB, no fetch, no model, no clock.
 */
import { CHAT_SCRIPT_MAX_LINES, type EventActor } from '../contracts/chatActor.js';
import { sanitizeGeneratedContent } from '../contracts/chatEventAdapter.js';
import { extractChoices } from './templates.js';

/** 화자 모양으로 볼 접두 이름의 최대 길이. 더 길면 `|`가 든 서술로 본다. */
export const LINE_GATE_MAX_NAME_CHARS = 24;
const SENTINELS = ['NO_LINE', 'NO_NARRATION'];

export type LineGateConfig = {
  /** 이번 요청에서 대사를 쓸 수 있는 인물. */
  allowed: EventActor[];
  /** 방 전체 cast. 허용 밖 인물을 식별하는 데만 쓴다. */
  roomCast: EventActor[];
  userName: string;
  /** Pass S·narrator 보충은 true, actor 보충은 false(D9). */
  allowNarration: boolean;
  maxLines?: number;
  outputMaxTokens: number;
  /** beat F·E: 접두 없는 줄도 이 인물의 대사다. */
  singleActor?: EventActor;
};

type UnitBody =
  | { kind: 'narration'; text: string }
  | { kind: 'line'; actor_id: string; name: string; text: string };

export type VerifiedUnit = UnitBody & { seq: number; break_before: boolean };

export type RemovalReason =
  | 'user_voice'
  | 'ambiguous_speaker'
  | 'forbidden_speaker'
  | 'unknown_speaker'
  | 'quarantine'
  | 'narration_not_allowed'
  | 'line_cap';

export const REMOVAL_REASONS: readonly RemovalReason[] = [
  'user_voice', 'ambiguous_speaker', 'forbidden_speaker', 'unknown_speaker',
  'quarantine', 'narration_not_allowed', 'line_cap',
];

export type EndReason = 'stop' | 'length' | 'timeout' | 'abort' | 'error';

export type GateStatus = 'ok' | 'empty' | 'speaker_violation_empty' | 'incomplete' | 'gate_error';

export type GateTerminal = {
  /** end 시점에 새로 풀린 단위(정상 종료의 개행 없는 꼬리 포함). gate_error면 빈 배열. */
  units: VerifiedUnit[];
  status: GateStatus;
  error_code: 'gate_buffer_overflow' | 'gate_nonmonotonic' | null;
  removed: Record<RemovalReason, number>;
  sentinels: number;
  /** 정상 종료(stop)이고 gate_error가 아닐 때만 채운다. 노출 규칙은 호출부 결정(U3 §6). */
  choices: string[] | null;
  choices_status: ChoiceValidation['status'] | 'none';
  request_failed: boolean;
  /** push·end로 낸 단위 전체 수. gate_error 전에 이미 낸 단위도 센다(호출부가 철회한다). */
  unit_count: number;
  line_count: number;
};

export type LineGate = {
  push(delta: string): VerifiedUnit[];
  end(reason: EndReason): GateTerminal;
};

/** dialogScript.ts normalizeName 과 같은 장식 제거. */
function normalizeName(raw: string): string {
  return raw
    .replace(/^[\s>*_`\-–—]+|[\s*_`]+$/g, '')
    .replace(/[:：]\s*$/, '')
    .replace(/^\[|\]$/g, '')
    .trim();
}

/** chatActor.ts foldName 과 같은 비교 키. */
function fold(name: string): string {
  return name.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

function matchIds(key: string, actors: EventActor[]): string[] {
  const ids = actors
    .filter((actor) => [actor.name, ...(actor.aliases ?? [])].some((value) => fold(value) === key))
    .map((actor) => actor.id);
  return [...new Set(ids)];
}

/** 선택지와 본문에서 같은 화자 모양 문법을 쓴다. */
function speakerShape(line: string): { name: string; said: string } | null {
  const sep = line.indexOf('|');
  const name = sep > 0 ? normalizeName(line.slice(0, sep).trim()) : '';
  const said = sep > 0 ? line.slice(sep + 1).trim() : '';
  return name && said && name.length <= LINE_GATE_MAX_NAME_CHARS ? { name, said } : null;
}

export type ChoiceValidation =
  | { status: 'valid'; items: string[] }
  | { status: 'invalid'; items: [] };

export function validateChoices(items: string[]): ChoiceValidation {
  const cleaned = items.map((item) => item.trim()).filter(Boolean);
  if (!cleaned.length || cleaned.some((item) => item.split(/\r?\n/).some((line) => speakerShape(line) !== null))) {
    return { status: 'invalid', items: [] };
  }
  return { status: 'valid', items: cleaned.slice(0, 3) };
}

function terminalChoices(raw: string): ChoiceValidation | { status: 'none'; items: [] } {
  const parsed = extractChoices(raw).choices;
  if (!parsed) {
    return /<choices/i.test(raw) || /```(?:json|choices)?\s*\[[\s\S]*?\]\s*```\s*$/i.test(raw)
      ? { status: 'invalid', items: [] } : { status: 'none', items: [] };
  }
  // extractChoices caps at three; inspect the complete selected array before truncating.
  const candidates = [...raw.matchAll(/<choices>\s*(\[[\s\S]*?\])\s*<\/choices>/gi)];
  const fence = raw.match(/```(?:json|choices)?\s*(\[[\s\S]*?\])\s*```\s*$/i);
  if (fence && fence.index !== undefined) candidates.push({ ...fence, index: fence.index } as RegExpExecArray);
  for (const match of candidates.reverse()) {
    if (JSON.stringify(extractChoices(raw.slice(match.index)).choices) !== JSON.stringify(parsed)) continue;
    try {
      const values: unknown = JSON.parse(match[1]);
      if (Array.isArray(values)) return validateChoices(values.map((item) => String(item)));
    } catch { /* The existing extractor remains authoritative for parseability. */ }
  }
  return validateChoices(parsed);
}

export function createLineGate(config: LineGateConfig): LineGate {
  const maxLines = config.singleActor ? Infinity : config.maxLines ?? CHAT_SCRIPT_MAX_LINES;
  if (!Number.isInteger(config.outputMaxTokens) || config.outputMaxTokens <= 0) throw new Error('invalid output token limit');
  const maxBufferChars = Math.max(4000, 8 * config.outputMaxTokens);
  const allowed = config.singleActor ? [config.singleActor] : config.allowed;
  const userKey = fold(config.userName);

  let raw = '';
  /** 이미 분류한 가시 줄. 새 가시 문자열은 이 줄들로 시작해야 한다. */
  let consumed: string[] = [];
  let closed = false;
  let errorCode: GateTerminal['error_code'] = null;
  let quarantine = false;
  let pendingBreak = false;
  let seq = 0;
  let lineCount = 0;
  let sentinels = 0;
  const removed = Object.fromEntries(REMOVAL_REASONS.map((r) => [r, 0])) as Record<RemovalReason, number>;

  const remove = (reason: RemovalReason, startsQuarantine: boolean) => {
    removed[reason]++;
    if (startsQuarantine) quarantine = true;
  };

  const emit = (out: VerifiedUnit[], unit: UnitBody) => {
    seq++;
    out.push({ ...unit, seq, break_before: seq > 1 && pendingBreak });
    pendingBreak = false;
  };

  const classify = (rawLine: string, out: VerifiedUnit[]) => {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line) {
      quarantine = false;
      pendingBreak = true;
      return;
    }
    if (SENTINELS.includes(line)) {
      sentinels++;
      return;
    }
    const shape = speakerShape(line);
    if (shape) {
      const { name, said } = shape;
      const key = fold(name);
      const allowedIds = matchIds(key, allowed);
      if (key === userKey) return remove('user_voice', true);
      if (allowedIds.length > 1) return remove('ambiguous_speaker', true);
      if (allowedIds.length === 1) {
        if (lineCount >= maxLines) {
          quarantine = false;
          return remove('line_cap', false);
        }
        const actor = allowed.find((a) => a.id === allowedIds[0])!;
        quarantine = false;
        lineCount++;
        emit(out, { kind: 'line', actor_id: actor.id, name: actor.name, text: said });
        return;
      }
      if (matchIds(key, config.roomCast).length) return remove('forbidden_speaker', true);
      return remove('unknown_speaker', true);
    }
    if (quarantine) return remove('quarantine', false);
    if (config.singleActor) {
      if (lineCount >= maxLines) return remove('line_cap', false);
      lineCount++;
      emit(out, { kind: 'line', actor_id: config.singleActor.id, name: config.singleActor.name, text: line });
      return;
    }
    if (!config.allowNarration) return remove('narration_not_allowed', false);
    emit(out, { kind: 'narration', text: line });
  };

  const fail = (code: NonNullable<GateTerminal['error_code']>) => {
    errorCode = code;
    raw = '';
  };

  /**
   * text 의 가시 줄 가운데 아직 분류하지 않은 줄. 이미 분류한 줄이 바뀌었으면 null.
   * sanitizeGeneratedContent 는 끝 공백·개행을 잘라내므로 줄 완성은 원문 개행으로 정한다.
   */
  const fresh = (text: string, streaming: boolean): string[] | null => {
    // CRLF 는 분할 위치와 무관하도록 LF 로 맞춘 뒤 정리한다(끝 공백 잘림이 \r 을 먹는 차이 방지).
    const visible = sanitizeGeneratedContent(text.replace(/\r\n/g, '\n'), { streaming });
    const lines = visible ? visible.split('\n') : [];
    if (lines.length < consumed.length || consumed.some((line, i) => lines[i] !== line)) return null;
    const rest = lines.slice(consumed.length);
    consumed = lines;
    return rest;
  };

  return {
    push(delta: string): VerifiedUnit[] {
      if (closed) throw new Error('line gate closed');
      if (errorCode) return [];
      raw += delta;
      if (raw.length > maxBufferChars) {
        fail('gate_buffer_overflow');
        return [];
      }
      const cut = raw.lastIndexOf('\n');
      if (cut < 0) return [];
      const rest = fresh(raw.slice(0, cut + 1), true);
      if (rest === null) {
        fail('gate_nonmonotonic');
        return [];
      }
      const out: VerifiedUnit[] = [];
      for (const line of rest) classify(line, out);
      return out;
    },

    end(reason: EndReason): GateTerminal {
      if (closed) throw new Error('line gate closed');
      closed = true;
      const out: VerifiedUnit[] = [];
      let choices: ChoiceValidation | { status: 'none'; items: [] } = { status: 'none', items: [] };
      if (!errorCode && reason === 'stop') {
        const rest = fresh(raw, false);
        if (rest === null) fail('gate_nonmonotonic');
        else {
          for (const line of rest) classify(line, out);
          choices = terminalChoices(raw);
        }
      }
      raw = '';
      const removals = REMOVAL_REASONS.reduce((n, r) => n + removed[r], 0);
      const status: GateStatus = errorCode
        ? 'gate_error'
        : reason !== 'stop'
          ? 'incomplete'
          : seq > 0
            ? 'ok'
            : removals > 0 ? 'speaker_violation_empty' : 'empty';
      return {
        units: errorCode ? [] : out,
        status,
        error_code: errorCode,
        removed: { ...removed },
        sentinels,
        choices: errorCode || choices.status !== 'valid' ? null : choices.items,
        choices_status: errorCode ? 'none' : choices.status,
        request_failed: reason === 'abort' ? false : Boolean(errorCode) || reason === 'timeout' || reason === 'error' || (seq === 0 && removals > 0),
        unit_count: seq,
        line_count: lineCount,
      };
    },
  };
}
