import { useEffect, useState } from 'react';
import { del, get, patch, post } from '../lib/api';
import { navigate } from '../lib/router';
import type { BudgetReport, Memory, PromptPreview, Summary } from '../types';
import { BottomSheet, useUi } from '../components/ui';

type Tab = 'budget' | 'memory' | 'summary';

export function ChatDrawer({ open, conversationId, draft, onClose, onApplied, initialTab }: { open: boolean; conversationId: string; draft: string; onClose: () => void; onApplied: () => void; initialTab?: Tab }) {
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
        {tab === 'budget' && <BudgetTab conversationId={conversationId} draft={draft} open={open} />}
        {tab === 'memory' && <MemoryTab conversationId={conversationId} open={open} onApplied={onApplied} onClose={onClose} />}
        {tab === 'summary' && <SummaryTab conversationId={conversationId} open={open} onApplied={onApplied} onClose={onClose} />}
      </div>
    </BottomSheet>
  );
}

function BudgetTab({ conversationId, draft, open }: { conversationId: string; draft: string; open: boolean }) {
  const [preview, setPreview] = useState<PromptPreview | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const q = draft.trim() ? `?draft=${encodeURIComponent(draft.trim())}` : '';
    get<PromptPreview>(`/api/conversations/${conversationId}/prompt-preview${q}`).then(setPreview).catch((e) => setErr((e as Error).message));
  }, [open, conversationId, draft]);

  if (err) return <div className="banner err">{err}</div>;
  if (!preview) return <div className="muted small">계산 중…</div>;
  const b = preview.budget;
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <span className="small muted">모델 {preview.model} · 프로필 {preview.profile.name}</span>
        <span className="small">{b.est_total} / {b.available}t</span>
      </div>
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

export function MemoryTab({ conversationId, open, onApplied, onClose }: { conversationId: string; open: boolean; onApplied: () => void; onClose: () => void }) {
  const ui = useUi();
  const [pinned, setPinned] = useState<Memory[]>([]);
  const [candidates, setCandidates] = useState<Memory[]>([]);
  const [text, setText] = useState('');
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  function jumpToEvidence(m: Memory) {
    const eid = m.evidence_message_ids?.[0];
    if (!eid) return;
    // SearchPage 와 동일 패턴. 같은 대화에선 pathname 불변이라 popstate 만으로는 ChatPage 가 안 다시 그린다 — onClose 가 리렌더를 만든다.
    navigate(`/chat/${conversationId}?jump=${eid}`);
    onClose();
  }

  async function load() {
    const r = await get<{ pinned: Memory[]; candidates: Memory[] }>(`/api/conversations/${conversationId}/memories`);
    setPinned(r.pinned);
    setCandidates(r.candidates);
  }
  useEffect(() => { if (open) load(); }, [open, conversationId]);

  async function setStatus(id: string, status: 'pinned' | 'rejected') {
    await patch(`/api/memories/${id}`, { status });
    await load();
    onApplied();
  }
  // 중복 병합: 기존(canonical) 기억이 후보면 채택(pin)하고, 중복 후보는 정리(reject) → 하나로 통합.
  // 판정은 플래그일 뿐이므로 사용자가 [병합]을 눌러야 실행된다(§8 자동변경 금지).
  async function merge(cand: Memory) {
    const canonicalId = cand.conflict?.withMemoryId ?? null;
    const canonical = canonicalId ? [...pinned, ...candidates].find((m) => m.id === canonicalId) : null;
    if (canonical && canonical.status === 'candidate') await patch(`/api/memories/${canonicalId}`, { status: 'pinned' });
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
    await post('/api/memories', { conversationId, content: text.trim(), status: 'pinned', scope: 'conversation' });
    setText('');
    await load();
    onApplied();
    ui.toast('기억 추가됨');
  }

  return (
    <div>
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

export function SummaryTab({ conversationId, open, onApplied, onClose }: { conversationId: string; open: boolean; onApplied: () => void; onClose: () => void }) {
  const ui = useUi();
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<{ id: string; content: string } | null>(null);
  const [stateHistoryOpen, setStateHistoryOpen] = useState(false);

  function jumpToCover(s: Summary) {
    const eid = s.covers_until_message_id;
    if (!eid) return;
    navigate(`/chat/${conversationId}?jump=${eid}`);
    onClose();
  }

  async function load() {
    setSummaries(await get<Summary[]>(`/api/conversations/${conversationId}/summaries`));
  }
  useEffect(() => { if (open) load(); }, [open, conversationId]);

  async function generate() {
    setBusy(true);
    try {
      const r = await post<{ summary: Summary; state?: Summary | null; candidates: Memory[]; inputMessages: number }>(`/api/conversations/${conversationId}/summarize`, {});
      ui.toast(`요약 초안 — 상태 + 장면 + 전체 + 기억 ${r.candidates.length}`);
      await load();
    } catch (e) {
      ui.toast((e as Error).message, 'err');
    } finally {
      setBusy(false);
    }
  }
  async function approve(id: string) {
    await patch(`/api/summaries/${id}`, { status: 'approved' });
    await load();
    onApplied();
    ui.toast('요약 승인됨 — 이후 프롬프트에 반영');
  }
  async function saveEdit() {
    if (!edit) return;
    await patch(`/api/summaries/${edit.id}`, { content: edit.content });
    setEdit(null);
    await load();
    onApplied();
  }
  async function remove(id: string) {
    if (!(await ui.confirm('요약을 삭제할까요?', { danger: true, okLabel: '삭제' }))) return;
    await del(`/api/summaries/${id}`);
    await load();
    onApplied();
  }
  async function rollup() {
    try { await post(`/api/conversations/${conversationId}/rollup-episode`, {}); await load(); onApplied(); ui.toast('에피소드 초안 생성 — 승인하면 장면이 접힙니다'); }
    catch (e) { ui.toast((e as Error).message, 'err'); }
  }
  async function restore(id: string) {
    await post(`/api/summaries/${id}/restore`, {});
    await load();
    onApplied();
    ui.toast('이전 상태로 복원됨 — 새 체크포인트로 저장');
  }

  const stateRows = summaries.filter((s) => s.tier === 'state');
  const sceneRows = summaries.filter((s) => s.tier === 'scene');
  const episodeRows = summaries.filter((s) => s.tier === 'episode');
  const wholeRows = summaries.filter((s) => s.tier !== 'state' && s.tier !== 'scene' && s.tier !== 'episode');
  const foldableScenes = summaries.filter((s) => s.tier === 'scene' && s.status === 'approved' && !s.rolled_up_into).length;

  function renderCard(s: Summary, kind: '상태' | '전체' | '장면' | '에피소드', opts?: { onRestore?: () => void }) {
    return (
      <div className="card" key={s.id} style={{ marginBottom: 10 }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
          <span className="row" style={{ gap: 6 }}>
            <span className="tag" style={{ background: 'var(--bg-3)', color: 'var(--fg-2)' }}>{kind}</span>
            <span className={`tag`} style={{ background: s.status === 'approved' ? 'rgba(61,220,151,0.15)' : 'var(--bg-3)', color: s.status === 'approved' ? 'var(--ok)' : 'var(--fg-2)' }}>{s.status === 'approved' ? '승인됨' : '초안'}</span>
          </span>
          <span className="small muted">{new Date(s.created_at).toLocaleString('ko-KR')}</span>
        </div>
        {edit?.id === s.id ? (
          <>
            <textarea value={edit.content} onChange={(e) => setEdit({ id: s.id, content: e.target.value })} style={{ width: '100%', minHeight: 120, background: 'var(--bg)', border: '1px solid var(--bg-3)', borderRadius: 8, padding: 10 }} />
            <div className="row end" style={{ gap: 8, marginTop: 8 }}><button className="btn sm" onClick={() => setEdit(null)}>취소</button><button className="btn sm primary" onClick={saveEdit}>저장</button></div>
          </>
        ) : (
          <>
            <div style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{s.content}</div>
            <div className="row end" style={{ gap: 6, marginTop: 8 }}>
              {s.covers_until_message_id && <button className="btn sm ghost" onClick={() => jumpToCover(s)}>원본</button>}
              {opts?.onRestore && <button className="btn sm ghost" onClick={opts.onRestore}>복원</button>}
              <button className="btn sm ghost" onClick={() => remove(s.id)}>삭제</button>
              <button className="btn sm" onClick={() => setEdit({ id: s.id, content: s.content })}>편집</button>
              {s.status !== 'approved' && <button className="btn sm primary" onClick={() => approve(s.id)}>승인</button>}
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div>
      <button className="btn primary block" disabled={busy} onClick={generate}>{busy ? '요약 생성 중… (모델 호출)' : '지금까지 대화 요약하기'}</button>
      {foldableScenes >= 5 && <button className="btn sm block" onClick={rollup}>에피소드로 묶기 ({foldableScenes})</button>}
      <div className="small muted" style={{ margin: '8px 0 14px' }}>요약과 자동 추출 기억은 <b>초안</b>으로 저장되며, 승인해야 프롬프트에 들어갑니다. 마지막 승인 이후의 새 메시지만 요약합니다.</div>
      {summaries.length === 0 && <div className="muted small">아직 요약이 없습니다.</div>}
      {(() => {
        const approved = stateRows.filter((s) => s.status === 'approved').sort((a, b) => b.created_at.localeCompare(a.created_at));
        const drafts = stateRows.filter((s) => s.status !== 'approved');
        const current = approved[0];
        const history = approved.slice(1);
        return (
          <>
            {drafts.map((s) => renderCard(s, '상태'))}
            {current && renderCard(current, '상태')}
            {history.length > 0 && (
              <>
                <button className="btn sm ghost block" style={{ marginBottom: 10 }} onClick={() => setStateHistoryOpen((v) => !v)}>
                  {stateHistoryOpen ? '이전 상태 이력 숨기기' : `이전 상태 이력 보기 (${history.length})`}
                </button>
                {stateHistoryOpen && history.map((s) => renderCard(s, '상태', { onRestore: () => restore(s.id) }))}
              </>
            )}
          </>
        );
      })()}
      {episodeRows.map((s) => renderCard(s, '에피소드'))}
      {sceneRows.map((s) => renderCard(s, '장면'))}
      {wholeRows.map((s) => renderCard(s, '전체'))}
    </div>
  );
}
