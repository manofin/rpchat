import { useEffect, useRef, useState } from 'react';
import { api, del, get, patch, post } from '../lib/api';
import { navigate } from '../lib/router';
import { readShortcuts, resolveShortcutSubmit } from '../lib/shortcutMacro';
import { currentApprovedState, diffWords, priorApprovedWhole, summaryBranchLabel } from '../lib/summaryDiff';
import { useSummaryRows } from '../lib/useSummaryRows';
import type { BudgetReport, Memory, Message, PromptPreview, Summary } from '../types';
import { BottomSheet, useUi } from '../components/ui';
import { MessageSourcePreview } from '../components/MessageSourcePreview';

function DiffText({ before, after }: { before: string; after: string }) {
  const segments = diffWords(before, after);
  return (
    <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 14 }}>
      {segments.map((seg, idx) => {
        if (seg.type === 'same') return <span key={idx}>{seg.text}</span>;
        if (seg.type === 'add') return <ins key={idx} style={{ background: 'rgba(51,180,167,0.16)', color: 'var(--role-teal-text)', textDecorationColor: 'var(--role-teal-text)' }}>{seg.text}</ins>;
        return <del key={idx} style={{ background: 'rgba(199,51,63,0.12)', color: 'var(--danger)' }}>{seg.text}</del>;
      })}
    </div>
  );
}

type Tab = 'budget' | 'memory' | 'summary';

export function ChatDrawer({ open, conversationId, draft, onClose, onApplied, initialTab, headMessageId, revision = 0 }: { open: boolean; conversationId: string; draft: string; onClose: () => void; onApplied: () => void; initialTab?: Tab; headMessageId?: string | null; revision?: string | number }) {
  const viewKey = JSON.stringify([conversationId, headMessageId]);
  const [tab, setTab] = useState<Tab>(initialTab ?? 'budget');
  useEffect(() => {
    if (open && initialTab) setTab(initialTab);
  }, [open, initialTab]);
  return (
    <BottomSheet open={open} onClose={onClose}>
      <div className="tabs">
        <button className={tab === 'budget' ? 'active' : ''} onClick={() => setTab('budget')}>컨텍스트</button>
        <button className={tab === 'memory' ? 'active' : ''} onClick={() => setTab('memory')}>기억</button>
        <button className={tab === 'summary' ? 'active' : ''} onClick={() => setTab('summary')}>요약</button>
      </div>
      <div className="sheet-body">
        {tab === 'budget' && <BudgetTab key={viewKey} revision={revision} conversationId={conversationId} draft={draft} open={open} />}
        {tab === 'memory' && <MemoryTab key={viewKey} revision={revision} conversationId={conversationId} open={open} onApplied={onApplied} onClose={onClose} />}
        {tab === 'summary' && <SummaryTab key={viewKey} headMessageId={headMessageId} revision={revision} conversationId={conversationId} open={open} onApplied={onApplied} onClose={onClose} />}
      </div>
    </BottomSheet>
  );
}

function BudgetTab({ conversationId, draft, open, revision }: { conversationId: string; draft: string; open: boolean; revision?: string | number }) {
  const [preview, setPreview] = useState<PromptPreview | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const resolved = resolveShortcutSubmit(draft, readShortcuts());
    const params = new URLSearchParams();
    if (draft.trim()) params.set('draft', resolved.content.trim());
    if (resolved.inject_instruction) params.set('inject_instruction', resolved.inject_instruction);
    const q = params.size ? `?${params}` : '';
    let active = true;
    setErr(null);
    setPreview(null);
    get<PromptPreview>(`/api/conversations/${conversationId}/prompt-preview${q}`)
      .then((p) => { if (active) setPreview(p); }).catch((e) => { if (active) setErr((e as Error).message); });
    return () => { active = false; };
  }, [open, conversationId, draft, revision]);

  if (err) return <div className="banner err">{err}</div>;
  if (!preview) return <div className="muted small">계산 중…</div>;
  const b = preview.budget;
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <span className="small muted">모델 {preview.model} · 프로필 {preview.profile.name}</span>
        <span className="small">{b.est_total} / {b.available}t</span>
      </div>
      {preview.scene_delta?.pending && <div className="banner warn" style={{ marginBottom: 8 }}>현재 분기의 장면으로 계산했습니다. 생성 중 장면이 바뀌면 대본 프롬프트와 예산도 달라질 수 있습니다.</div>}
      {b.instruction_overflow && <div className="banner err" style={{ marginBottom: 8 }}>현재 입력과 고정 규칙이 컨텍스트 예산을 초과했습니다.</div>}
      <BudgetBars budget={b} />
      <div className="small muted" style={{ marginTop: 8 }}>
        컨텍스트 {b.context_tokens}t 중 응답용 {b.reply_reserve}t 예약 · 보정계수 ×{b.calibration.toFixed(2)}
      </div>
      {(() => {
        const g = b.diagnostics;
        if (!g) {
          return (
            <>
              <DebugList label="포함된 기억" items={b.included_memories} empty="없음 (pinned 0 또는 예산 탈락)" />
              <DebugList label="발동 로어" items={b.active_lore} empty="없음" />
              <DebugList label="제외 로어" items={b.dropped_lore} empty="없음" />
              <div className="small" style={{ marginTop: 8 }}>
                <div className="muted">사용 요약</div>
                {b.summary_used ? (b.summary_preview || '있음') : '없음 (승인된 요약 없음)'}
              </div>
              <DebugList label="예산 초과 탈락 기억" items={b.dropped_memories} empty="없음" />
            </>
          );
        }
        return (
          <>
            <div className="small" style={{ marginTop: 8 }}>
              <div className="muted">로어 · {g.lore.length}</div>
              {g.lore.length === 0 ? '없음' : (
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {g.lore.map((l) => {
                    const keys = l.alwaysOn ? 'always' : (l.matched.join(', ') || '(키워드 없음)');
                    if (l.status === 'no-match') {
                      return <li key={l.title} style={{ opacity: 0.5 }}>○ [{l.title}] 미매칭 · {keys}</li>;
                    }
                    if (l.status === 'dropped-budget') {
                      return <li key={l.title}>○ [{l.title}] {keys} · {l.tokens}t · 예산 초과</li>;
                    }
                    return <li key={l.title}>● [{l.title}] {keys} · {l.tokens}t</li>;
                  })}
                </ul>
              )}
            </div>
            <DebugList
              label="기억"
              items={g.memories.map((m) => `${m.status === 'included' ? '●' : '○'} ${m.content.slice(0, 60)} · 중요도 ${m.importance} · ${m.tokens}t`)}
              empty="없음"
            />
            <DebugList
              label="요약"
              items={g.summaries.map((s) => `${s.used ? '●' : '○'} ${s.tier} · ${s.tokens}t${s.note ? ` · ${s.note}` : ''}`)}
              empty="없음"
            />
          </>
        );
      })()}
      <div className="small" style={{ marginTop: 8 }}>
        <div className="muted">최근 범위</div>
        {b.included_messages}건 포함
        {b.recent_from_id && b.recent_to_id ? ` · ${b.recent_from_id.slice(0, 8)}… → ${b.recent_to_id.slice(0, 8)}…` : ''}
        {b.dropped_messages > 0 ? ` · 오래된 메시지 ${b.dropped_messages}건 제외` : ''}
      </div>
      {preview.isOoc && <div className="banner warn" style={{ marginTop: 8 }}>OOC 메시지로 감지됨 — 캐릭터 밖 응답 모드</div>}
      <button className="btn sm block" style={{ marginTop: 12 }} onClick={() => setShowRaw((v) => !v)}>{showRaw ? '원문 숨기기' : '조립된 프롬프트 보기'}</button>
      {showRaw && (
        <div className="mono" style={{ marginTop: 8, maxHeight: 320, overflow: 'auto', background: 'var(--bg)', padding: 10, borderRadius: 8 }}>
          {preview.messages.map((m, i) => `【${m.role}】\n${m.content}`).join('\n\n──────\n\n')}
        </div>
      )}
    </div>
  );
}

/** P5-R1: 섹션의 출처 라벨. kind 는 선택 필드라 없으면 태그 없이 기존 그대로 그린다. */
const KIND_LABEL: Record<NonNullable<BudgetReport['sections'][number]['kind']>, string> = {
  system: '시스템',
  story: '스토리',
  lore: '로어',
  memory: '기억',
  summary: '요약',
  recent: '최근',
};

export function BudgetBars({ budget }: { budget: BudgetReport }) {
  return (
    <div>
      {budget.sections.map((s) => (
        <div className="budget-row" key={s.name} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="row" style={{ gap: 6, minWidth: 0 }}>
              {s.kind && <span className="tag" style={{ background: 'var(--bg-3)', color: 'var(--fg-2)' }}>{KIND_LABEL[s.kind]}</span>}
              <span>{s.name}</span>
            </span>
            <span className="muted">{s.est_tokens}/{s.budget}t</span>
          </div>
          <div className="bar"><i style={{ width: `${Math.min(100, s.budget ? (s.est_tokens / s.budget) * 100 : 0)}%`, background: s.est_tokens > s.budget ? 'var(--danger)' : 'var(--accent)' }} /></div>
          {s.note && <span className="small muted">{s.note}</span>}
        </div>
      ))}
    </div>
  );
}

function DebugList({ label, items, empty }: { label: string; items: string[]; empty: string }) {
  return (
    <div className="small" style={{ marginTop: 8 }}>
      <div className="muted">{label} · {items.length}</div>
      {items.length === 0 ? empty : (
        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          {items.map((t, i) => <li key={i}>{t.length > 120 ? `${t.slice(0, 120)}…` : t}</li>)}
        </ul>
      )}
    </div>
  );
}

export function MemoryTab({ conversationId, open, onApplied, onClose, revision }: { conversationId: string; open: boolean; onApplied: () => void; onClose: () => void; revision?: string | number }) {
  const ui = useUi();
  const [pinned, setPinned] = useState<Memory[]>([]);
  const [candidates, setCandidates] = useState<Memory[]>([]);
  const [text, setText] = useState('');
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [source, setSource] = useState<{ conversationId: string; messageId: string } | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const sourceRequest = useRef<AbortController | null>(null);

  async function jumpToEvidence(m: Memory) {
    const eid = m.evidence_message_ids?.[0];
    if (!eid) return;
    sourceRequest.current?.abort();
    const controller = new AbortController();
    sourceRequest.current = controller;
    setSourceError(null);
    try {
      const message = await api<Message>(`/api/messages/${encodeURIComponent(eid)}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setSource({ conversationId: message.conversation_id, messageId: message.id });
    } catch (error) {
      if (!controller.signal.aborted) setSourceError(error instanceof Error ? error.message : '원문을 불러오지 못했습니다.');
    }
  }
  useEffect(() => {
    setSource(null); setSourceError(null);
    return () => { sourceRequest.current?.abort(); };
  }, [conversationId, open]);

  const [loadError, setLoadError] = useState<string | null>(null);
  const memoryRequest = useRef<AbortController | null>(null);
  async function load() {
    memoryRequest.current?.abort();
    const controller = new AbortController();
    memoryRequest.current = controller;
    setLoadError(null);
    try {
      const r = await api<{ pinned: Memory[]; candidates: Memory[] }>(`/api/conversations/${conversationId}/memories`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setPinned(r.pinned);
      setCandidates(r.candidates);
    } catch (e) {
      if (!controller.signal.aborted) setLoadError((e as Error).message);
    }
  }
  useEffect(() => {
    if (open) void load();
    return () => { memoryRequest.current?.abort(); };
  }, [open, conversationId, revision]);

  async function setStatus(id: string, status: 'pinned' | 'rejected') {
    if (status === 'pinned') {
      const r = await patch<{ pinned?: boolean; warn?: string; conflict?: Memory['conflict']; status?: string }>(
        `/api/memories/${id}`,
        { status: 'pinned' },
      );
      if (r && r.pinned === false && r.warn === 'duplicate') {
        const reason = r.conflict?.reason ? ` (${r.conflict.reason})` : '';
        const ok = await ui.confirm(
          `기존 기억과 중복 가능성이 있습니다.${reason} 그래도 채택할까요?`,
          { okLabel: '채택' },
        );
        if (!ok) return;
        await patch(`/api/memories/${id}?confirm=1`, { status: 'pinned' });
      }
    } else {
      await patch(`/api/memories/${id}`, { status });
    }
    await load();
    onApplied();
  }
  // 중복 병합: 기존(canonical) 기억이 후보면 채택(pin)하고, 중복 후보는 정리(reject) → 하나로 통합.
  // 판정은 플래그일 뿐이므로 사용자가 [병합]을 눌러야 실행된다(§8 자동변경 금지).
  async function merge(cand: Memory) {
    const canonicalId = cand.conflict?.withMemoryId ?? null;
    const canonical = canonicalId ? [...pinned, ...candidates].find((m) => m.id === canonicalId) : null;
    // User already chose 병합 — pin with confirm=1 so dup-warn does not re-prompt.
    if (canonical && canonical.status === 'candidate') await patch(`/api/memories/${canonicalId}?confirm=1`, { status: 'pinned' });
    await patch(`/api/memories/${cand.id}`, { status: 'rejected' });
    await load();
    onApplied();
    ui.toast(canonical ? '중복 병합 — 기존 기억을 채택하고 후보를 정리했습니다' : '중복 후보를 정리했습니다');
  }
  function dismiss(id: string) {
    setDismissed((s) => new Set(s).add(id));
  }
  const byId = new Map<string, Memory>([...pinned, ...candidates].map((m) => [m.id, m]));
  async function remove(id: string) {
    await del(`/api/memories/${id}`);
    await load();
    onApplied();
  }
  async function add() {
    if (!text.trim()) return;
    const body = { conversationId, content: text.trim(), status: 'pinned' as const, scope: 'conversation' as const };
    const r = await post<{ pinned?: boolean; warn?: string; conflict?: Memory['conflict']; id?: string; status?: string }>(
      '/api/memories',
      body,
    );
    if (r && r.pinned === false && r.warn === 'duplicate') {
      const reason = r.conflict?.reason ? ` (${r.conflict.reason})` : '';
      const ok = await ui.confirm(
        `기존 기억과 중복 가능성이 있습니다.${reason} 그래도 추가할까요?`,
        { okLabel: '추가' },
      );
      if (!ok) return;
      await post('/api/memories?confirm=1', body);
    }
    setText('');
    await load();
    onApplied();
    ui.toast('기억 추가됨');
  }

  return (
    <div>
      {sourceError && <div className="banner err" role="alert">{sourceError}</div>}
      <MessageSourcePreview conversationId={source?.conversationId ?? conversationId} messageId={source?.messageId ?? null} onClose={() => setSource(null)} />
      {loadError && <div className="banner err" role="alert">{loadError}<button className="btn sm" onClick={() => void load()}>다시 불러오기</button></div>}
      <div className="row" style={{ marginBottom: 10 }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="기억할 사실을 직접 추가" onKeyDown={(e) => e.key === 'Enter' && add()} style={{ flex: 1, background: 'var(--bg-2)', border: '1px solid var(--bg-3)', borderRadius: 10, padding: '9px 12px', minHeight: 40 }} />
        <button className="btn sm primary" onClick={add}>추가</button>
      </div>

      {candidates.length > 0 && (
        <>
          <div className="section-title" style={{ marginTop: 4 }}>승인 대기 ({candidates.length})</div>
          {candidates.map((m) => {
            const dup = m.conflict?.kind === 'duplicate' && !dismissed.has(m.id);
            const matched = dup && m.conflict?.withMemoryId ? byId.get(m.conflict.withMemoryId) : null;
            return (
              <div key={m.id}>
                <div className="mem-item">
                  <div className="body">
                    <div>{m.content}</div>
                    <div className="imp">중요도 {m.importance} · {m.source === 'model' ? '자동 추출' : '직접'}{dup ? ' · 중복 가능성' : ''}</div>
                  </div>
                  <button className="btn sm" onClick={() => setStatus(m.id, 'pinned')}>채택</button>
                  <button className="btn sm ghost" onClick={() => setStatus(m.id, 'rejected')}>버림</button>
                  {m.evidence_message_ids?.[0] && (
                    <button className="btn sm ghost" onClick={() => jumpToEvidence(m)}>원본</button>
                  )}
                </div>
                {dup && (
                  <div className="banner warn" style={{ marginTop: 6 }}>
                    <div className="small">기존 기억과 중복 가능성 · {m.conflict!.reason}</div>
                    {matched && <div className="small" style={{ marginTop: 4, opacity: 0.85 }}>기존: 「{matched.content}」</div>}
                    <div className="row" style={{ gap: 6, marginTop: 8, justifyContent: 'flex-end' }}>
                      <button className="btn sm ghost" onClick={() => dismiss(m.id)}>무시</button>
                      <button className="btn sm primary" onClick={() => merge(m)}>병합</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}

      <div className="section-title">고정 기억 ({pinned.length})</div>
      {pinned.length === 0 ? (
        <div className="muted small">고정된 기억이 없습니다. 요약 탭에서 자동 추출하거나 위에서 직접 추가하세요.</div>
      ) : (
        pinned.map((m) => (
          <div className="mem-item" key={m.id}>
            <div className="body">
              <div>{m.content}</div>
              <div className="imp">중요도 {m.importance}{m.scope === 'character' ? ' · 캐릭터 공용' : ''}</div>
            </div>
            <button className="btn sm ghost" onClick={() => remove(m.id)} aria-label="삭제">🗑</button>
            {m.evidence_message_ids?.[0] && (
              <button className="btn sm ghost" onClick={() => jumpToEvidence(m)}>원본</button>
            )}
          </div>
        ))
      )}
    </div>
  );
}

export function SummaryTab({ conversationId, open, onApplied, onClose, headMessageId, revision = 0 }: { conversationId: string; open: boolean; onApplied: () => void; onClose: () => void; headMessageId?: string | null; revision?: string | number }) {
  const ui = useUi();
  const { summaries: loaded, error, reload } = useSummaryRows(conversationId, open, headMessageId, revision);
  const summaries = loaded ?? [];
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<{ id: string; content: string } | null>(null);
  const [stateHistoryOpen, setStateHistoryOpen] = useState(false);
  const active = useRef(false);
  useEffect(() => { active.current = open; return () => { active.current = false; }; }, [open]);

  function jumpToCover(messageId: string) {
    navigate(`/chat/${conversationId}?jump=${encodeURIComponent(messageId)}`);
    onClose();
  }

  async function change(action: () => Promise<unknown>, message?: string) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      if (!active.current) return;
      setEdit(null);
      reload();
      onApplied();
      if (message) ui.toast(message);
    } catch (e) {
      if (active.current) ui.toast((e as Error).message, 'err');
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function generate() {
    await change(async () => {
      const r = await post<{ candidates: Memory[] }>(`/api/conversations/${conversationId}/summarize`, {});
      if (active.current) ui.toast(`요약 초안과 기억 후보 ${r.candidates.length}개가 저장되었습니다.`);
    });
  }
  async function remove(id: string) {
    if (!(await ui.confirm('요약을 삭제할까요?', { danger: true, okLabel: '삭제' })) || !active.current) return;
    await change(() => del(`/api/summaries/${id}`));
  }

  const stateRows = summaries.filter((s) => s.tier === 'state');
  const sceneRows = summaries.filter((s) => s.tier === 'scene');
  const episodeRows = summaries.filter((s) => s.tier === 'episode');
  const wholeRows = summaries.filter((s) => s.tier !== 'state' && s.tier !== 'scene' && s.tier !== 'episode');
  const foldableScenes = sceneRows.filter((s) => s.branch_scope === 'current' && s.status === 'approved' && !s.rolled_up_into).length;

  function renderCard(s: Summary, kind: '상태' | '전체' | '장면' | '에피소드', opts?: { restore?: boolean; diffBefore?: string | null }) {
    return (
      <div className="card" key={s.id} data-summary-id={s.id} style={{ marginBottom: 10 }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6, flexWrap: 'wrap', gap: 6 }}>
          <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span className="tag" style={{ background: 'var(--bg-3)', color: 'var(--fg-2)' }}>{kind}</span>
            <span className="tag" style={{ background: s.status === 'approved' ? 'rgba(44,156,145,0.16)' : 'var(--bg-3)', color: s.status === 'approved' ? 'var(--role-teal-text)' : 'var(--fg-2)' }}>{s.status === 'approved' ? '승인됨' : '초안'}</span>
            <span className="tag">{summaryBranchLabel(s)}</span>
          </span>
          <span className="small muted">{new Date(s.created_at).toLocaleString('ko-KR')}</span>
        </div>
        {edit?.id === s.id ? (
          <>
            <textarea aria-label="요약 내용" value={edit.content} onChange={(e) => setEdit({ id: s.id, content: e.target.value })} style={{ width: '100%', minHeight: 120, background: 'var(--bg)', border: '1px solid var(--bg-3)', borderRadius: 8, padding: 10 }} />
            <div className="row end" style={{ gap: 8, marginTop: 8 }}><button className="btn sm" disabled={busy} onClick={() => setEdit(null)}>취소</button><button className="btn sm primary" disabled={busy} onClick={() => change(() => patch(`/api/summaries/${s.id}`, { content: edit.content }))}>저장</button></div>
          </>
        ) : (
          <>
            {opts?.diffBefore != null ? (
              <><div className="small muted" style={{ marginBottom: 4 }}>현재 분기의 이전 승인 내용과 비교</div><DiffText before={opts.diffBefore} after={s.content} /></>
            ) : (
              <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 14 }}>{s.content}</div>
            )}
            <div className="row end" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              {s.covers_from_message_id && s.covers_from_message_id !== s.covers_until_message_id && <button className="btn sm ghost" onClick={() => jumpToCover(s.covers_from_message_id!)}>범위 시작</button>}
              {s.covers_until_message_id && <button className="btn sm ghost" onClick={() => jumpToCover(s.covers_until_message_id!)}>범위 끝 원문</button>}
              {opts?.restore && <button className="btn sm ghost" disabled={busy} onClick={() => change(() => post(`/api/summaries/${s.id}/restore`, {}), '이전 상태를 새 체크포인트로 저장했습니다.')}>복원</button>}
              <button className="btn sm ghost" disabled={busy} onClick={() => remove(s.id)}>삭제</button>
              <button className="btn sm" disabled={busy} onClick={() => setEdit({ id: s.id, content: s.content })}>편집</button>
              {s.status !== 'approved' && <button className="btn sm primary" disabled={busy} onClick={() => change(() => patch(`/api/summaries/${s.id}`, { status: 'approved' }), '승인됨. 현재 분기와 맥락 예산에 따라 사용됩니다.')}>승인</button>}
            </div>
          </>
        )}
      </div>
    );
  }

  const current = currentApprovedState(summaries);
  const drafts = stateRows.filter((s) => s.status !== 'approved');
  const history = stateRows.filter((s) => s.status === 'approved' && s.branch_scope === 'current' && s.id !== current?.id);
  const otherStates = stateRows.filter((s) => s.status === 'approved' && s.branch_scope !== 'current');
  return (
    <div>
      <button className="btn primary block" disabled={busy || loaded === null} onClick={generate}>{busy ? '처리 중…' : '지금까지 대화 요약하기'}</button>
      {foldableScenes >= 5 && <button className="btn sm block" disabled={busy} onClick={() => change(() => post(`/api/conversations/${conversationId}/rollup-episode`, {}), '에피소드 초안 생성 — 승인하면 장면이 접힙니다')}>에피소드로 묶기 ({foldableScenes})</button>}
      <div className="small muted" style={{ margin: '8px 0 14px' }}>요약은 초안으로 저장됩니다. 승인된 요약도 현재 분기와 맥락 예산에 따라 선택됩니다. 실제 포함 여부는 컨텍스트 탭에서 확인하세요. 원문 버튼은 요약 범위를 보여 주며, 각 문장의 사실 확인을 뜻하지 않습니다.</div>
      {error ? <div className="banner err" role="alert">{error}<button className="btn sm" onClick={reload}>다시 불러오기</button></div> : loaded === null ? <div className="muted small" role="status">요약을 불러오는 중…</div> : <>
        <div className="section-title">현재 분기의 승인 상태</div>
        {current ? renderCard(current, '상태') : <div className="muted small" style={{ marginBottom: 12 }}>현재 분기에서 확인된 승인 상태가 없습니다.</div>}
        {drafts.length > 0 && <div className="section-title">상태 초안</div>}
        {drafts.map((s) => renderCard(s, '상태', { diffBefore: s.branch_scope === 'current' ? current?.content ?? null : null }))}
        {history.length > 0 && <>
          <button className="btn sm ghost block" style={{ marginBottom: 10 }} onClick={() => setStateHistoryOpen((v) => !v)}>
            {stateHistoryOpen ? '이전 상태 이력 숨기기' : `현재 분기의 이전 상태 이력 (${history.length})`}
          </button>
          {stateHistoryOpen && history.map((s) => renderCard(s, '상태', { restore: true, diffBefore: current?.content ?? null }))}
        </>}
        {otherStates.length > 0 && <div className="section-title">다른 분기 · 근거 미확인 상태</div>}
        {otherStates.map((s) => renderCard(s, '상태', { restore: true }))}
        {episodeRows.map((s) => renderCard(s, '에피소드'))}
        {sceneRows.map((s) => renderCard(s, '장면'))}
        {wholeRows.map((s) => renderCard(s, '전체', { diffBefore: priorApprovedWhole(summaries, s)?.content ?? null }))}
      </>}
    </div>
  );
}
