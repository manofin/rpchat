import { useEffect, useRef, useState } from 'react';
import { ApiError, get, put } from '../lib/api';
import { useMemoryResource } from '../lib/useMemoryResource';
import { navigate } from '../lib/router';
import type { DialogKnowledgeEntry, DialogKnowledgeView, Memory, Message } from '../types';
import { Spinner } from './ui';
import { MessageSourcePreview } from './MessageSourcePreview';

const kinds: Record<DialogKnowledgeEntry['kind'], string> = {
  fact: '사실', injury: '부상', relationship: '관계', promise: '약속', goal: '미해결 목표',
};

export function knowledgeLabel(entry: DialogKnowledgeEntry | undefined, actors: DialogKnowledgeView['actors']) {
  if (!entry) return '범위 미지정';
  const names = new Map(actors.map(a => [a.id, a.name]));
  const scope = entry.known_by === 'public' ? '모두' : entry.known_by.map(id => names.get(id) || '없는 인물').join(', ') || '서술자만';
  return `${kinds[entry.kind]} · ${scope}${entry.status === 'resolved' ? ' · 종료' : ''}`;
}

const excludedReasons: Record<string, string> = {
  resolved: '종료한 지정입니다.',
  'invalid-contract': '지정 정보를 읽을 수 없습니다.',
  'invalid-anchor': '인식 범위를 지정한 대화를 찾지 못했습니다.',
  'assignment-off-branch': '다른 분기에서 지정한 인식 범위입니다.',
  'not-approved': '현재 채택된 기억이 아닙니다.',
  'foreign-scope': '이 대화에 적용할 수 없는 기억입니다.',
  'evidence-off-branch': '근거가 현재 분기와 연결되지 않았습니다.',
  'unknown-actor': '지정한 인물을 찾지 못했습니다.',
  budget: '맥락 예산을 초과했습니다.',
};

export function KnowledgeEntryDetails({ memory, view, entry, onOpenSource, busy = false }: {
  memory: Memory; view: DialogKnowledgeView; entry?: DialogKnowledgeEntry;
  onOpenSource: (messageId: string) => void; busy?: boolean;
}) {
  const names = new Map<string, string>([['user', view.userName], ...view.actors.map(actor => [actor.id, actor.name] as const)]);
  const name = (id: string | undefined) => id ? names.get(id) || '찾을 수 없는 인물' : '미지정';
  const excluded = view.excluded.find(item => item.memory_id === memory.id);
  const scope = !entry ? '미지정' : entry.known_by === 'public' ? '모두'
    : entry.known_by.map(id => name(id)).join(', ') || '서술자만';
  const evidence = memory.evidence_message_ids;
  return <div className="small" data-test="knowledge-entry-details" style={{ overflowWrap: 'anywhere' }}>
    <p>주체: {name(entry?.subject_id)}{entry?.target_id ? ` → 대상: ${name(entry.target_id)}` : ''}</p>
    <p>기억을 아는 인물: {scope} · 인식 상태: {!entry ? '미지정' : entry.status === 'active' ? '유지' : '종료'}</p>
    {excluded && <p className="muted" data-test="knowledge-excluded">{excludedReasons[excluded.reason] ?? '현재 분기에 적용할 수 없는 지정입니다.'}</p>}
    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
      {entry && <button type="button" className="btn sm ghost" disabled={busy} onClick={() => onOpenSource(entry.anchor_message_id)}>인식 범위를 지정한 위치</button>}
      {evidence?.map((id, index) => <button key={id} type="button" className="btn sm ghost" disabled={busy} onClick={() => onOpenSource(id)}>기억 근거 {index + 1} 원문</button>)}
    </div>
    {Array.isArray(evidence) && !evidence.length && <p className="muted">연결된 기억 근거가 없습니다. 지정 위치는 사실의 원문 근거와 다를 수 있습니다.</p>}
  </div>;
}

export function KnowledgeForm({ memory, view, entry, busy, onSave, onCancel }: {
  memory: Memory; view: DialogKnowledgeView; entry?: DialogKnowledgeEntry; busy: boolean;
  onSave: (entry: DialogKnowledgeEntry | null) => void; onCancel: () => void;
}) {
  const [kind, setKind] = useState<DialogKnowledgeEntry['kind']>(entry?.kind || 'fact');
  const [scope, setScope] = useState<'narrator' | 'public' | 'actors'>(entry?.known_by === 'public' ? 'public' : entry?.known_by.length ? 'actors' : 'narrator');
  const [holders, setHolders] = useState<string[]>(Array.isArray(entry?.known_by) ? entry.known_by : []);
  const [subject, setSubject] = useState(entry?.subject_id || (entry && entry.kind !== 'fact' ? 'user' : ''));
  const [target, setTarget] = useState(entry?.target_id || view.actors[0]?.id || '');
  const [status, setStatus] = useState<DialogKnowledgeEntry['status']>(entry?.status || 'active');
  const directional = kind === 'promise' || kind === 'relationship';
  const showTarget = directional || Boolean(entry?.target_id);
  const entities = [{ id: 'user', name: view.userName }, ...view.actors];
  const canSave = Boolean(view.headMessageId) && (scope !== 'actors' || holders.length > 0)
    && (kind === 'fact' || Boolean(subject)) && (!directional || Boolean(target));
  return (
    <form onSubmit={e => {
      e.preventDefault();
      if (!canSave || busy) return;
      onSave({ memory_id: memory.id, anchor_message_id: view.headMessageId!, kind,
        known_by: scope === 'public' ? 'public' : scope === 'actors' ? holders : [], status,
        ...(subject ? { subject_id: subject } : {}), ...(showTarget && target ? { target_id: target } : {}) });
    }} className="card" style={{ padding: 16, marginBottom: 12 }}>
      <p>{memory.content}</p>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="field"><label>기억 종류<select value={kind} onChange={e => {
          const next = e.target.value as DialogKnowledgeEntry['kind'];
          setKind(next);
          if (next !== 'fact' && !subject) setSubject('user');
        }}>
          {Object.entries(kinds).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select></label></div>
        <div className="field"><label>인물 인식 범위<select value={scope} onChange={e => setScope(e.target.value as typeof scope)}>
          <option value="narrator">서술자만</option><option value="actors">지정한 인물만</option><option value="public">모두</option>
        </select></label></div>
        {scope === 'actors' && <fieldset style={{ border: 0, padding: 0 }}><legend>기억을 아는 인물</legend>
          {view.actors.map(a => <label key={a.id} style={{ display: 'flex', gap: 8, padding: '8px 0' }}>
            <input type="checkbox" checked={holders.includes(a.id)} onChange={e => setHolders(e.target.checked ? [...holders, a.id] : holders.filter(id => id !== a.id))} />{a.name}
          </label>)}
        </fieldset>}
        <div className="field"><label>{kind === 'fact' ? '관련 인물 (선택)' : directional ? '주체 (누가)' : '해당 인물'}<select value={subject} onChange={e => setSubject(e.target.value)}>
          {kind === 'fact' && <option value="">미지정</option>}
          {entities.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select></label></div>
        {showTarget && <div className="field"><label>{directional ? '대상 (누구에게)' : '대상 (선택)'}<select value={target} onChange={e => setTarget(e.target.value)}>
          {!directional && <option value="">미지정</option>}
          {entities.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select></label></div>}
        <div className="field"><label>진행 상태<select value={status} onChange={e => setStatus(e.target.value as typeof status)}>
          <option value="active">유지</option><option value="resolved">종료</option>
        </select></label></div>
        <p className="small muted">현재 분기에서 이 기억을 아는 인물과 유지할 상태를 지정합니다. 이미 대화에서 공개한 내용은 되돌리지 않습니다. 실제 응답 반영은 맥락과 예산에 따라 달라질 수 있습니다.</p>
        {!view.headMessageId && <p className="small">첫 대화를 저장한 뒤 지정할 수 있습니다.</p>}
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <button type="submit" className="btn primary" disabled={!canSave}>{busy ? '저장 중…' : '인식 범위 저장'}</button>
          <button type="button" className="btn ghost" onClick={onCancel}>취소</button>
          {entry && <button type="button" className="btn ghost" onClick={() => onSave(null)}>지정 해제</button>}
        </div>
      </fieldset>
    </form>
  );
}

export function DialogKnowledgeEditor({ conversationId, headMessageId }: { conversationId: string; headMessageId?: string | null }) {
  const { data: loadedView, loading, error: loadError, refresh } = useMemoryResource<DialogKnowledgeView>(
    `/api/conversations/${encodeURIComponent(conversationId)}/knowledge`, headMessageId);
  const branchChanged = Boolean(loadedView && headMessageId !== undefined && loadedView.headMessageId !== headMessageId);
  const view = branchChanged ? null : loadedView;
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [source, setSource] = useState<{ conversationId: string; messageId: string } | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const sourceRequest = useRef(0);
  const action = useRef(0);
  const scope = `${conversationId}:${view?.headMessageId ?? ''}:${headMessageId ?? ''}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  useEffect(() => {
    action.current++;
    sourceRequest.current++;
    setEditing(null); setError(null); setSaved(false); setBusy(false);
    setSource(null); setSourceLoading(false);
    return () => { action.current++; sourceRequest.current++; };
  }, [scope]);
  async function openSource(messageId: string) {
    const sequence = ++sourceRequest.current;
    setSourceLoading(true); setError(null);
    try {
      // Character-scoped memory can cite a different conversation; use the message's actual owner.
      const message = await get<Message>(`/api/messages/${encodeURIComponent(messageId)}`);
      if (sequence === sourceRequest.current && scope === currentScope.current) {
        setSource({ conversationId: message.conversation_id, messageId: message.id });
      }
    } catch (failure) {
      if (sequence === sourceRequest.current && scope === currentScope.current) {
        setError(failure instanceof Error ? failure.message : '원문을 불러오지 못했습니다.');
      }
    } finally {
      if (sequence === sourceRequest.current && scope === currentScope.current) setSourceLoading(false);
    }
  }
  async function save(entry: DialogKnowledgeEntry | null) {
    if (!view || !editing || busy || loading) return;
    const sequence = ++action.current;
    const stillCurrent = () => sequence === action.current && scope === currentScope.current;
    setBusy(true); setError(null); setSaved(false);
    try {
      await put(`/api/conversations/${encodeURIComponent(conversationId)}/knowledge/${encodeURIComponent(editing)}`, { headMessageId: view.headMessageId, entry });
      if (!stillCurrent()) return;
      const latest = await refresh();
      if (!stillCurrent()) return;
      setEditing(null);
      setSaved(Boolean(latest && latest.headMessageId === view.headMessageId));
    } catch (e) {
      if (!stillCurrent()) return;
      setError(e instanceof ApiError ? e.message : '저장하지 못했습니다. 다시 확인해 주세요.');
      if (e instanceof ApiError && e.status === 409) void refresh();
    } finally { if (stillCurrent()) setBusy(false); }
  }
  async function reload() {
    setEditing(null); setSaved(false); setError(null);
    await refresh();
  }
  const memory = view?.memories.find(m => m.id === editing);
  return <section aria-label="인물별 기억">
    {branchChanged && <div role="alert" className="banner warn" data-test="knowledge-branch-changed">
      대화 분기가 바뀌어 인식 범위 편집을 멈췄습니다. 대화로 돌아가 현재 분기를 확인해 주세요.
      <button type="button" className="btn sm ghost" onClick={() => navigate(`/chat/${encodeURIComponent(conversationId)}`)}>대화로 돌아가기</button>
    </div>}
    {(error || loadError) && <div role="alert" className="banner err">{error || loadError} <button type="button" className="btn sm ghost" disabled={busy || loading} onClick={reload}>다시 불러오기</button></div>}
    {saved && !loading && <div role="status" className="banner">인식 범위를 저장했습니다. 응답에 포함되는 기억은 맥락 예산에 따라 달라집니다.</div>}
    {loading && <div role="status"><Spinner /><span className="small muted">현재 분기의 인식 범위를 확인하는 중…</span></div>}
    {sourceLoading && <p role="status" className="small">근거 원문을 확인하는 중…</p>}
    {view && !view.enabled && <p className="muted">인물별 기억 지정은 스토리 대본 형식에서 사용할 수 있습니다.</p>}
    {view?.enabled && <>
      <p className="small">기억을 아는 인물과 부상·약속의 주체를 직접 정합니다. 지정하지 않은 기억은 서술자 참고로 사용됩니다.</p>
      <p className="small muted">이미 대화에서 공개한 내용을 되돌리지는 않습니다.</p>
      {view.invalidContract && <div role="alert" className="banner err">기존 기억 지정 정보를 읽을 수 없어 편집할 수 없습니다.</div>}
      {!view.memories.length && <p className="muted">기억 탭에서 먼저 기억을 추가하거나 후보를 채택해 주세요.</p>}
      {memory && <KnowledgeForm key={`${memory.id}:${view.headMessageId}`} memory={memory} view={view} entry={view.entries.find(e => e.memory_id === memory.id)} busy={busy || loading} onSave={save} onCancel={() => setEditing(null)} />}
      {view.memories.filter(m => m.id !== editing).map(m => <div key={m.id} className="mem-item" style={{ flexWrap: 'wrap' }}>
        <div className="body"><div>{m.content}</div><div className="imp">{knowledgeLabel(view.entries.find(e => e.memory_id === m.id), view.actors)}</div>
          <KnowledgeEntryDetails memory={m} view={view} entry={view.entries.find(e => e.memory_id === m.id)} onOpenSource={id => void openSource(id)} busy={loading || sourceLoading} />
        </div>
        <button type="button" className="btn sm" disabled={busy || loading || view.invalidContract} onClick={() => { setEditing(m.id); setSaved(false); }}>인식 범위 지정</button>
      </div>)}
    </>}
    <MessageSourcePreview conversationId={source?.conversationId ?? conversationId} messageId={branchChanged ? null : source?.messageId ?? null} onClose={() => setSource(null)} />
  </section>;
}
