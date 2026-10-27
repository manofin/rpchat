/**
 * 순수 요청 계획기 (named lock 코드-party-u2-plan-2-20261021 §5).
 *
 * U2 선행 결정표 v5 §1(계획 단계·판정 절차·실행 순서), §3의 3-1~3-3·3-7~3-13,
 * §4의 4-1·4-2·4-5~4-8, §5의 출력 형식을 구현한다. 기존 생성 경로에는 연결하지 않는다.
 *
 * 순수성(§5-1): import는 zod·node:crypto뿐. db/, config, routes/, model/, 파일 시스템,
 * 네트워크, 환경 변수, 시계, 난수를 쓰지 않는다. 같은 입력이면 같은 출력 JSON 바이트다.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// §5-2 수신 범위
// ---------------------------------------------------------------------------

export type Scope =
  | { visibility: 'public' }
  | { visibility: 'private'; recipient_ids: string[] };

export const PUBLIC_SCOPE: Scope = { visibility: 'public' };

function normalizeScope(scope: Scope): Scope {
  if (scope.visibility === 'public') return PUBLIC_SCOPE;
  return { visibility: 'private', recipient_ids: [...new Set(scope.recipient_ids)].sort() };
}

/** allowed가 scope를 모두 포함하는가. */
export function coversScope(allowed: Scope, scope: Scope): boolean {
  const a = normalizeScope(allowed);
  const s = normalizeScope(scope);
  if (a.visibility === 'public') return true;
  if (s.visibility === 'public') return false;
  const set = new Set(a.visibility === 'private' ? a.recipient_ids : []);
  return (s.visibility === 'private' ? s.recipient_ids : []).every((id) => set.has(id));
}

/** 합집합: public이 하나라도 있으면 public, 아니면 recipient_ids 합집합(정렬·중복 제거). */
export function unionScopes(scopes: Scope[]): Scope {
  const norm = scopes.map(normalizeScope);
  if (norm.some((s) => s.visibility === 'public')) return PUBLIC_SCOPE;
  const ids = new Set<string>();
  for (const s of norm) {
    if (s.visibility === 'private') for (const id of s.recipient_ids) ids.add(id);
  }
  return { visibility: 'private', recipient_ids: [...ids].sort() };
}

export function includesUser(scope: Scope): boolean {
  const s = normalizeScope(scope);
  if (s.visibility === 'public') return true;
  return s.recipient_ids.includes('user');
}

function scopesEqual(a: Scope, b: Scope): boolean {
  const x = normalizeScope(a);
  const y = normalizeScope(b);
  if (x.visibility !== y.visibility) return false;
  if (x.visibility === 'public') return true;
  const xi = x.visibility === 'private' ? x.recipient_ids : [];
  const yi = y.visibility === 'private' ? y.recipient_ids : [];
  return xi.length === yi.length && xi.every((id, i) => id === yi[i]);
}

// ---------------------------------------------------------------------------
// §5-4 과거 행 observation 유효성 — prompt/observation.ts audienceSchema와 같은 규칙.
// db를 끌어오는 observation.ts를 import할 수 없으므로(순수성) 같은 정의를 여기 둔다.
// 두 정의가 같은 규칙인지는 bench/partyRequestPlan.test.ts 시험 25가 대조한다.
// ---------------------------------------------------------------------------

const observationAudienceSchema = z.discriminatedUnion('visibility', [
  z.object({ visibility: z.literal('public') }).strict(),
  z
    .object({
      visibility: z.literal('private'),
      recipient_ids: z.array(z.string().min(1)).max(100),
      observer_ids: z.array(z.string().min(1)).max(100).default([]),
    })
    .strict(),
]);

export function isValidObservation(value: unknown): boolean {
  return observationAudienceSchema.safeParse(value).success;
}

// ---------------------------------------------------------------------------
// §5-3 입력 타입
// ---------------------------------------------------------------------------

export type PathRow = {
  id: string;
  generation_id: string | null;
  observation?: unknown;
};

export type ApprovedItem = {
  id: string;
  allowed?: Scope;
};

export type Snapshot = {
  snapshot_id: string;
  participants: string[];
  observation_filter: boolean;
  present_ids: string[];
  path: PathRow[];
  approved_items: ApprovedItem[];
};

export type ContextRef = {
  item_id: string;
  source: 'path' | 'approved' | 'story';
  required: boolean;
  allowed_override?: Scope;
};

export type Segment = { id: string; recipients: Scope };

export type Candidate = {
  id: string;
  kind: 'dialogue_output' | 'internal_control';
  role?: 'public_script' | 'input_response' | 'auxiliary';
  segments?: Segment[];
  state_effects?: string[];
  declared_scope?: Scope;
  context: ContextRef[];
  predecessors: string[];
};

export type Options = { own_generation_id: string | null };

// ---------------------------------------------------------------------------
// 출력 타입(§5-6)
// ---------------------------------------------------------------------------

export type ReasonCode =
  | 'duplicate_id'
  | 'missing_predecessor'
  | 'cycle'
  | 'field_mismatch'
  | 'required_context_excluded'
  | 'declared_scope_mismatch'
  | 'input_permission'
  | 'unsupported_in_needed';

export type ExcludeReason =
  | 'out_of_path'
  | 'legacy_unclassified'
  | 'audience_invalid'
  | 'audience_unknown';

export type ContextVerdict = {
  item_id: string;
  included: boolean;
  scope?: Scope;
  reason?: ExcludeReason;
};

export type CandidateVerdict = {
  verdict: 'kept' | 'omitted' | 'rejected';
  scope: Scope;
};

export type PlanEntry = {
  seq: number;
  candidate_id: string;
  kind: Candidate['kind'];
  grade: 'required';
  predecessors: string[];
  segments?: Segment[];
  state_effects?: string[];
  storage: 'messages' | 'none';
  exposure: 'public_verified_stream' | 'private_hold_until_turn_success' | 'none';
};

export type PlanResult = {
  status: 'ok' | 'invalid_plan' | 'plan_rejected';
  reason?: ReasonCode;
  reason_candidate_id?: string;
  snapshot_id: string;
  permission_version: string;
  candidates: Record<string, CandidateVerdict>;
  context: Record<string, ContextVerdict[]>;
  execution_plan?: PlanEntry[];
};

// ---------------------------------------------------------------------------
// §5-7 권한 버전
// ---------------------------------------------------------------------------

export function permissionVersion(snapshot: Snapshot, ownGenerationId: string | null): string {
  const pathRows = snapshot.path
    .filter((row) => !(typeof ownGenerationId === 'string' && row.generation_id === ownGenerationId))
    .map((row) =>
      row.observation === undefined ? { id: row.id } : { id: row.id, observation: row.observation },
    );
  const approved = snapshot.approved_items
    .map((item) => ({ id: item.id, allowed: item.allowed === undefined ? null : item.allowed }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const doc = {
    participants: [...snapshot.participants].sort(),
    present_ids: [...snapshot.present_ids].sort(),
    observation_filter: snapshot.observation_filter,
    path: pathRows,
    approved_items: approved,
  };
  return createHash('sha256').update(JSON.stringify(doc), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// 내부: 상태 소비자 수신 범위 고정 표(1-8). 표에 없는 상태는 구조 오류다.
// ---------------------------------------------------------------------------

const STATE_CONSUMER_SCOPE: Record<string, Scope> = { scene: PUBLIC_SCOPE };

// ---------------------------------------------------------------------------
// 내부: 맥락 항목 판정(§5-4, 결정표 3-9~3-13)
// ---------------------------------------------------------------------------

function judgeContext(snapshot: Snapshot, ref: ContextRef): ContextVerdict {
  if (ref.source === 'path') {
    const row = snapshot.path.find((r) => r.id === ref.item_id);
    if (!row) return { item_id: ref.item_id, included: false, reason: 'out_of_path' };
    if (row.observation === undefined) {
      if (!snapshot.observation_filter) {
        return { item_id: ref.item_id, included: true, scope: PUBLIC_SCOPE };
      }
      return { item_id: ref.item_id, included: false, reason: 'legacy_unclassified' };
    }
    if (!isValidObservation(row.observation)) {
      return { item_id: ref.item_id, included: false, reason: 'audience_invalid' };
    }
    const obs = row.observation as { visibility: 'public' | 'private'; recipient_ids?: string[] };
    // observer_ids는 허용 범위에 넣지 않는다.
    const scope: Scope =
      obs.visibility === 'public'
        ? PUBLIC_SCOPE
        : { visibility: 'private', recipient_ids: [...(obs.recipient_ids ?? [])] };
    return { item_id: ref.item_id, included: true, scope: normalizeScope(scope) };
  }
  if (ref.source === 'approved') {
    const item = snapshot.approved_items.find((i) => i.id === ref.item_id);
    if (!item || item.allowed === undefined) {
      return { item_id: ref.item_id, included: false, reason: 'audience_unknown' };
    }
    return { item_id: ref.item_id, included: true, scope: normalizeScope(item.allowed) };
  }
  // story
  if (ref.allowed_override === undefined) {
    return { item_id: ref.item_id, included: false, reason: 'audience_unknown' };
  }
  return { item_id: ref.item_id, included: true, scope: normalizeScope(ref.allowed_override) };
}

// ---------------------------------------------------------------------------
// 내부: 권한 범위 S(C) — C와 C의 결과를 쓰는 쪽으로 도달 가능한 모든 후보의
// dialogue segments 수신자와 state_effects 소비자 범위의 합집합(1-8).
// ---------------------------------------------------------------------------

function computeScopes(candidates: Candidate[]): Record<string, Scope> {
  const followers = new Map<string, string[]>();
  for (const c of candidates) {
    for (const pred of c.predecessors) {
      const list = followers.get(pred) ?? [];
      list.push(c.id);
      followers.set(pred, list);
    }
  }
  const out: Record<string, Scope> = {};
  for (const c of candidates) {
    const reachable = new Set<string>([c.id]);
    const queue = [c.id];
    while (queue.length) {
      const cur = queue.pop() as string;
      for (const next of followers.get(cur) ?? []) {
        if (!reachable.has(next)) {
          reachable.add(next);
          queue.push(next);
        }
      }
    }
    const parts: Scope[] = [];
    for (const other of candidates) {
      if (!reachable.has(other.id)) continue;
      if (other.kind === 'dialogue_output') {
        for (const seg of other.segments ?? []) parts.push(seg.recipients);
      }
      for (const effect of other.state_effects ?? []) {
        const consumer = STATE_CONSUMER_SCOPE[effect];
        if (consumer) parts.push(consumer);
      }
    }
    out[c.id] = unionScopes(parts);
  }
  return out;
}

// ---------------------------------------------------------------------------
// §5-5 판정 절차
// ---------------------------------------------------------------------------

function byId(a: string, b: string): number {
  const left = Array.from(a, (ch) => ch.codePointAt(0)!);
  const right = Array.from(b, (ch) => ch.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}

export function planRequests(snapshot: Snapshot, candidates: Candidate[], options: Options): PlanResult {
  const version = permissionVersion(snapshot, options.own_generation_id);
  const sortedIds = candidates.map((c) => c.id).sort(byId);

  // Duplicate IDs cannot identify a unique candidate's context or scope.
  // Reject before evaluating either, rather than choosing the first array entry.
  const duplicates = sortedIds.filter((id, i) => i > 0 && id === sortedIds[i - 1]);
  if (duplicates.length) {
    return {
      status: 'invalid_plan',
      reason: 'duplicate_id',
      reason_candidate_id: duplicates[0],
      snapshot_id: snapshot.snapshot_id,
      permission_version: version,
      candidates: Object.fromEntries([...new Set(sortedIds)].map((id) => [
        id, { verdict: 'rejected' as const, scope: { visibility: 'private' as const, recipient_ids: [] } },
      ])),
      context: {},
    };
  }

  const context: Record<string, ContextVerdict[]> = {};
  for (const id of sortedIds) {
    const c = candidates.find((x) => x.id === id) as Candidate;
    context[id] = c.context.map((ref) => judgeContext(snapshot, ref));
  }

  const scopes = computeScopes(candidates);
  const verdicts: Record<string, CandidateVerdict> = {};
  const fail = (reason: ReasonCode, failing: string[], status: 'invalid_plan' | 'plan_rejected'): PlanResult => {
    const reasonId = [...failing].sort(byId)[0];
    for (const id of sortedIds) {
      verdicts[id] = { verdict: status === 'invalid_plan' || failing.includes(id) ? 'rejected' : 'omitted', scope: scopes[id] };
    }
    return {
      status,
      reason,
      reason_candidate_id: reasonId,
      snapshot_id: snapshot.snapshot_id,
      permission_version: version,
      candidates: verdicts,
      context,
    };
  };

  // 구조 검사: 없는 선행 후보 → 순환 → 필드 불일치 → required 맥락 제외

  const idSet = new Set(candidates.map((c) => c.id));
  const missingPred = candidates.filter((c) => c.predecessors.some((p) => !idSet.has(p))).map((c) => c.id);
  if (missingPred.length) return fail('missing_predecessor', missingPred, 'invalid_plan');

  {
    const indegree = new Map<string, number>();
    const followers = new Map<string, string[]>();
    for (const c of candidates) {
      indegree.set(c.id, (indegree.get(c.id) ?? 0));
      for (const p of c.predecessors) {
        indegree.set(c.id, (indegree.get(c.id) ?? 0) + 1);
        const list = followers.get(p) ?? [];
        list.push(c.id);
        followers.set(p, list);
      }
    }
    const queue = candidates.filter((c) => (indegree.get(c.id) ?? 0) === 0).map((c) => c.id);
    let done = 0;
    while (queue.length) {
      const cur = queue.pop() as string;
      done++;
      for (const next of followers.get(cur) ?? []) {
        indegree.set(next, (indegree.get(next) ?? 0) - 1);
        if (indegree.get(next) === 0) queue.push(next);
      }
    }
    if (done < candidates.length) {
      const onCycle = candidates.filter((c) => (indegree.get(c.id) ?? 0) > 0).map((c) => c.id);
      return fail('cycle', onCycle, 'invalid_plan');
    }
  }

  const fieldBad = candidates
    .filter((c) => {
      if (c.kind === 'dialogue_output') {
        if (!Array.isArray(c.segments) || c.segments.length === 0) return true;
        if (c.segments.some((s) => !s || typeof s.id !== 'string' || !s.recipients)) return true;
        return false;
      }
      if (c.declared_scope === undefined) return true;
      if ((c.state_effects ?? []).some((e) => !(e in STATE_CONSUMER_SCOPE))) return true;
      return false;
    })
    .map((c) => c.id);
  if (fieldBad.length) return fail('field_mismatch', fieldBad, 'invalid_plan');

  const requiredExcluded = candidates
    .filter((c) => c.context.some((ref, i) => ref.required && !context[c.id][i].included))
    .map((c) => c.id);
  if (requiredExcluded.length) return fail('required_context_excluded', requiredExcluded, 'invalid_plan');

  // 2. declared_scope 대조(internal_control)
  const declaredBad = candidates
    .filter((c) => c.kind === 'internal_control' && !scopesEqual(c.declared_scope as Scope, scopes[c.id]))
    .map((c) => c.id);
  if (declaredBad.length) return fail('declared_scope_mismatch', declaredBad, 'invalid_plan');

  // 3. 입력 권한: 제외되지 않은 각 맥락 항목의 허용 범위가 S(C)를 포함해야 한다
  const permissionBad = candidates
    .filter((c) =>
      c.context.some((ref, i) => {
        const v = context[c.id][i];
        return v.included && v.scope !== undefined && !coversScope(v.scope, scopes[c.id]);
      }),
    )
    .map((c) => c.id);
  if (permissionBad.length) return fail('input_permission', permissionBad, 'invalid_plan');

  // 4. 근 집합 R과 필요 집합 N(선행 관계를 따라 닿는 닫힘)
  const roots = new Set(
    candidates
      .filter(
        (c) =>
          (c.kind === 'dialogue_output' && (c.role === 'public_script' || c.role === 'input_response')) ||
          (c.state_effects ?? []).length > 0,
      )
      .map((c) => c.id),
  );
  const needed = new Set<string>(roots);
  {
    const queue = [...roots];
    while (queue.length) {
      const cur = queue.pop() as string;
      const c = candidates.find((x) => x.id === cur) as Candidate;
      for (const p of c.predecessors) {
        if (!needed.has(p)) {
          needed.add(p);
          queue.push(p);
        }
      }
    }
  }

  // 5. 지원하지 않는 후보(4-1): N 안에 있으면 계획 거부, 밖이면 생략
  const unsupported = (c: Candidate): boolean => {
    if (c.kind === 'dialogue_output') {
      return (c.segments ?? []).some((s) => !includesUser(s.recipients));
    }
    return !includesUser(scopes[c.id]);
  };
  const unsupportedNeeded = candidates.filter((c) => needed.has(c.id) && unsupported(c)).map((c) => c.id);
  if (unsupportedNeeded.length) return fail('unsupported_in_needed', unsupportedNeeded, 'plan_rejected');

  // 6. N 밖은 생략
  for (const id of sortedIds) {
    verdicts[id] = { verdict: needed.has(id) ? 'kept' : 'omitted', scope: scopes[id] };
  }

  // 7. 실행 순서: 선행이 모두 선택된 후보 가운데 id가 유니코드 코드포인트 사전순으로 가장 작은 것을 반복 선택
  const order: string[] = [];
  {
    const selected = new Set<string>();
    const remaining = [...needed];
    while (remaining.length) {
      const available = remaining.filter((id) => {
        const c = candidates.find((x) => x.id === id) as Candidate;
        return c.predecessors.every((p) => selected.has(p));
      });
      available.sort(byId);
      const next = available[0];
      order.push(next);
      selected.add(next);
      remaining.splice(remaining.indexOf(next), 1);
    }
  }

  const execution_plan: PlanEntry[] = order.map((id, i) => {
    const c = candidates.find((x) => x.id === id) as Candidate;
    if (c.kind === 'internal_control') {
      return {
        seq: i + 1,
        candidate_id: id,
        kind: c.kind,
        grade: 'required',
        predecessors: c.predecessors,
        state_effects: c.state_effects ?? [],
        storage: 'none',
        exposure: 'none',
      };
    }
    const segs = (c.segments ?? []).map((s) => ({ id: s.id, recipients: normalizeScope(s.recipients) }));
    const anyPrivate = segs.some((s) => s.recipients.visibility === 'private');
    return {
      seq: i + 1,
      candidate_id: id,
      kind: c.kind,
      grade: 'required',
      predecessors: c.predecessors,
      segments: segs,
      storage: 'messages',
      exposure: anyPrivate ? 'private_hold_until_turn_success' : 'public_verified_stream',
    };
  });

  return {
    status: 'ok',
    snapshot_id: snapshot.snapshot_id,
    permission_version: version,
    candidates: verdicts,
    context,
    execution_plan,
  };
}

// ---------------------------------------------------------------------------
// §5-6 사용자에게 보이는 투영(4-5·4-8: 식별자를 넣지 않는다)
// ---------------------------------------------------------------------------

export type UserProjection =
  | {
      status: 'ok';
      requests: {
        seq: number;
        kind: Candidate['kind'];
        segments?: { seq: number; recipients: Scope }[];
        storage: PlanEntry['storage'];
        exposure: PlanEntry['exposure'];
      }[];
      excluded_context: { reason: ExcludeReason }[];
    }
  | { status: 'unavailable'; code: 'party_plan_unavailable' };

export function userProjection(result: PlanResult): UserProjection {
  if (result.status !== 'ok') {
    return { status: 'unavailable', code: 'party_plan_unavailable' };
  }
  const requests = (result.execution_plan ?? []).map((e) => ({
    seq: e.seq,
    kind: e.kind,
    ...(e.kind === 'dialogue_output'
      ? { segments: (e.segments ?? []).map((s, i) => ({ seq: i + 1, recipients: normalizeScope(s.recipients) })) }
      : {}),
    storage: e.storage,
    exposure: e.exposure,
  }));
  // 허용 범위가 user를 포함한다고 확정할 수 있는 항목의 제외만 싣는다.
  // 현행 제외 사유(out_of_path·legacy_unclassified·audience_invalid·audience_unknown)는
  // 허용 범위를 확정할 수 없는 경우뿐이라, 그 밖의 항목은 존재 자체를 싣지 않는다(4-5).
  const excluded_context: { reason: ExcludeReason }[] = [];
  for (const id of Object.keys(result.context).sort(byId)) {
    for (const v of result.context[id]) {
      if (!v.included && v.scope !== undefined && includesUser(v.scope)) {
        excluded_context.push({ reason: v.reason as ExcludeReason });
      }
    }
  }
  return { status: 'ok', requests, excluded_context };
}
