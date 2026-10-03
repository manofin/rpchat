import { useEffect, useState } from 'react';
import { ApiError, get, put } from '../lib/api';
import type { DialogKnowledgeEntry, DialogKnowledgeView, Memory } from '../types';
import { Spinner } from './ui';

const kinds: Record<DialogKnowledgeEntry['kind'], string> = {
  fact: '사실', injury: '부상', relationship: '관계', promise: '약속', goal: '미해결 목표',
};

export function knowledgeLabel(entry: DialogKnowledgeEntry | undefined, actors: DialogKnowledgeView['actors']) {
  if (!entry) return '범위 미지정';
  const names = new Map(actors.map(a => [a.id, a.name]));
  const scope = entry.known_by === 'public' ? '모두' : entry.known_by.map(id => names.get(id) || '없는 인물').join(', ') || '서술자만';
  return `${kinds[entry.kind]} · ${scope}${entry.status === 'resolved' ? ' · 종료' : ''}`;
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
        <div className="field"><label>기억을 아는 범위<select value={scope} onChange={e => setScope(e.target.value as typeof scope)}>
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
        <p className="small muted">현재 분기에서 확인한 내용으로 저장합니다. 다른 분기에 자동으로 공개하지 않습니다.</p>
        {!view.headMessageId && <p className="small">첫 대화를 저장한 뒤 지정할 수 있습니다.</p>}
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <button type="submit" className="btn primary" disabled={!canSave}>{busy ? '저장 중…' : '기억 범위 저장'}</button>
          <button type="button" className="btn ghost" onClick={onCancel}>취소</button>
          {entry && <button type="button" className="btn ghost" onClick={() => onSave(null)}>지정 해제</button>}
        </div>
      </fieldset>
    </form>
  );
}

export function DialogKnowledgeEditor({ conversationId }: { conversationId: string }) {
  const [view, setView] = useState<DialogKnowledgeView | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let live = true;
    setView(null); setEditing(null); setError(null); setSaved(false);
    get<DialogKnowledgeView>(`/api/conversations/${conversationId}/knowledge`).then(v => { if (live) setView(v); })
      .catch(e => { if (live) setError(e instanceof ApiError ? e.message : '기억 정보를 불러오지 못했습니다.'); });
    return () => { live = false; };
  }, [conversationId]);
  async function save(entry: DialogKnowledgeEntry | null) {
    if (!view || !editing || busy) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      await put(`/api/conversations/${conversationId}/knowledge/${editing}`, { headMessageId: view.headMessageId, entry });
      setView(await get<DialogKnowledgeView>(`/api/conversations/${conversationId}/knowledge`));
      setEditing(null); setSaved(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '저장하지 못했습니다. 다시 확인해 주세요.');
    } finally { setBusy(false); }
  }
  async function reload() {
    setBusy(true); setEditing(null); setSaved(false);
    try {
      setView(await get<DialogKnowledgeView>(`/api/conversations/${conversationId}/knowledge`));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '기억 정보를 불러오지 못했습니다.');
    } finally { setBusy(false); }
  }
  const memory = view?.memories.find(m => m.id === editing);
  return <section aria-label="인물별 기억">
    {error && <div role="alert" className="banner err">{error} <button type="button" className="btn sm ghost" disabled={busy} onClick={reload}>다시 불러오기</button></div>}
    {saved && <div role="status" className="banner">저장했습니다. 다음 응답부터 반영됩니다.</div>}
    {!view && !error && <Spinner />}
    {view && !view.enabled && <p className="muted">인물별 기억 지정은 스토리 대본 형식에서 사용할 수 있습니다.</p>}
    {view?.enabled && <>
      <p className="small">기억을 아는 인물과 부상·약속의 주체를 직접 정합니다. 지정하지 않은 기억은 서술자 참고로 사용됩니다.</p>
      <p className="small muted">이미 대화에서 공개한 내용을 되돌리지는 않습니다.</p>
      {view.invalidContract && <div role="alert" className="banner err">기존 기억 지정 정보를 읽을 수 없어 편집할 수 없습니다.</div>}
      {!view.memories.length && <p className="muted">기억 탭에서 먼저 기억을 추가하거나 후보를 채택해 주세요.</p>}
      {memory && <KnowledgeForm key={memory.id} memory={memory} view={view} entry={view.entries.find(e => e.memory_id === memory.id)} busy={busy} onSave={save} onCancel={() => setEditing(null)} />}
      {view.memories.filter(m => m.id !== editing).map(m => <div key={m.id} className="mem-item" style={{ flexWrap: 'wrap' }}>
        <div className="body"><div>{m.content}</div><div className="imp">{knowledgeLabel(view.entries.find(e => e.memory_id === m.id), view.actors)}</div>
          {view.excluded.some(e => e.memory_id === m.id) && <div className="small muted">현재 분기에서 사용할 수 없는 지정입니다.</div>}
        </div>
        <button type="button" className="btn sm" disabled={busy || view.invalidContract} onClick={() => { setEditing(m.id); setSaved(false); }}>범위 지정</button>
      </div>)}
    </>}
  </section>;
}
