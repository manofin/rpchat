import { useState } from 'react';
import { del, post, put } from '../lib/api';
import { useUi } from './ui';

export interface LoreEntry {
  id: string;
  title: string;
  keywords: string[];
  secondary_keys: string[];
  content: string;
  priority: number;
  always_on: boolean;
  token_cap: number;
  enabled: boolean;
  selective: boolean;
}

/**
 * Shared by CharacterEditor (캐릭터 로어) and StoryEditor (story-editor-tabs A8
 * 키워드북). `PUT /api/lore/:id`, `POST /api/lore/:id/clone`, and
 * `DELETE /api/lore/:id` are owner-agnostic — only entry creation differs by
 * owner, hence `createUrl` instead of a `characterId`/`storyId` prop.
 */
export function LorePanel({ createUrl, lore, setLore }: { createUrl: string; lore: LoreEntry[]; setLore: (l: LoreEntry[]) => void }) {
  const ui = useUi();
  const [editing, setEditing] = useState<LoreEntry | null>(null);
  const blank: LoreEntry = { id: '', title: '', keywords: [], secondary_keys: [], content: '', priority: 0, always_on: false, token_cap: 300, enabled: true, selective: false };

  async function saveEntry(e: LoreEntry) {
    if (!e.title.trim() || !e.content.trim()) return ui.toast('제목과 내용 필요', 'err');
    try {
      const payload = { title: e.title, keywords: e.keywords, secondary_keys: e.secondary_keys ?? [], content: e.content, priority: e.priority, always_on: e.always_on, token_cap: e.token_cap, enabled: e.enabled, selective: !!e.selective };
      const saved = e.id ? await put<LoreEntry>(`/api/lore/${e.id}`, payload) : await post<LoreEntry>(createUrl, payload);
      setLore(e.id ? lore.map((x) => (x.id === saved.id ? saved : x)) : [...lore, saved]);
      setEditing(null);
      ui.toast('로어 저장됨');
    } catch (err) {
      ui.toast((err as Error).message, 'err');
    }
  }

  async function clone(id: string) {
    try {
      const copy = await post<LoreEntry>(`/api/lore/${id}/clone`, {});
      setLore([...lore, copy]);
      ui.toast('로어가 복제됨');
    } catch (err) {
      ui.toast((err as Error).message, 'err');
    }
  }

  async function remove(id: string) {
    if (!(await ui.confirm('이 로어 항목을 삭제할까요?', { danger: true, okLabel: '삭제' }))) return;
    await del(`/api/lore/${id}`);
    setLore(lore.filter((x) => x.id !== id));
  }

  if (editing) {
    const e = editing;
    const upd = (patch: Partial<LoreEntry>) => setEditing({ ...e, ...patch });
    return (
      <div>
        <div className="field"><label>제목</label><input value={e.title} onChange={(ev) => upd({ title: ev.target.value })} /></div>
        <div className="field"><label>1차 키워드 (쉼표 구분)</label><input value={e.keywords.join(', ')} onChange={(ev) => upd({ keywords: ev.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} placeholder="발동 후보 단어" /><span className="hint">최근 6개 발화에 이 단어가 있으면 후보가 됩니다.</span></div>
        <div className="field"><label>2차 키워드 (쉼표 구분)</label><input value={(e.secondary_keys ?? []).join(', ')} onChange={(ev) => upd({ secondary_keys: ev.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} placeholder="선택적 발동용" /><span className="hint">선택적 발동이 켜져 있으면 2차 중 하나도 같은 구간에 있어야 삽입됩니다.</span></div>
        <div className="field"><label>내용</label><textarea value={e.content} onChange={(ev) => upd({ content: ev.target.value })} style={{ minHeight: 120 }} /></div>
        <div className="row wrap">
          <div className="field" style={{ flex: 1, minWidth: 120 }}><label>우선순위</label><input type="number" value={e.priority} onChange={(ev) => upd({ priority: Number(ev.target.value) || 0 })} /></div>
          <div className="field" style={{ flex: 1, minWidth: 120 }}><label>토큰 상한</label><input type="number" value={e.token_cap} onChange={(ev) => upd({ token_cap: Number(ev.target.value) || 300 })} /></div>
        </div>
        <label className="row" style={{ gap: 8, marginBottom: 10 }}><input type="checkbox" checked={e.always_on} onChange={(ev) => upd({ always_on: ev.target.checked })} style={{ width: 'auto', minHeight: 0 }} /> 항상 활성 (키워드 무관)</label>
        <label className="row" style={{ gap: 8, marginBottom: 10 }}><input type="checkbox" checked={!!e.selective} onChange={(ev) => upd({ selective: ev.target.checked })} style={{ width: 'auto', minHeight: 0 }} /> 선택적 발동 (1차 + 2차)</label>
        <label className="row" style={{ gap: 8, marginBottom: 14 }}><input type="checkbox" checked={e.enabled} onChange={(ev) => upd({ enabled: ev.target.checked })} style={{ width: 'auto', minHeight: 0 }} /> 사용</label>
        <div className="row end" style={{ gap: 8 }}><button className="btn" onClick={() => setEditing(null)}>취소</button><button className="btn primary" onClick={() => saveEntry(e)}>저장</button></div>
      </div>
    );
  }

  return (
    <div>
      <button className="btn primary block" onClick={() => setEditing(blank)} style={{ marginBottom: 10 }}>+ 로어 항목 추가</button>
      {lore.length === 0 && <div className="muted small">아직 로어가 없습니다. 세계관·설정·인물 정보를 키워드로 넣어두면 관련 대화에서 자동 삽입됩니다.</div>}
      <div className="list">
        {lore.map((e) => (
          <div key={e.id} className="list-item" onClick={() => setEditing(e)}>
            <div className="body">
              <div className="t">{e.enabled ? '' : '⏸ '}{e.title} {e.always_on && <span className="tag">항상</span>} {e.selective && <span className="tag">선택</span>}</div>
              <div className="p">{e.keywords.join(', ') || '키워드 없음'}{(e.secondary_keys ?? []).length ? ` · 2차 ${(e.secondary_keys ?? []).join(', ')}` : ''} · {e.token_cap}t</div>
            </div>
            <button className="btn ghost sm" onClick={(ev) => { ev.stopPropagation(); clone(e.id); }} aria-label="복제">복사</button>
            <button className="btn ghost icon" onClick={(ev) => { ev.stopPropagation(); remove(e.id); }} aria-label="삭제">🗑</button>
          </div>
        ))}
      </div>
    </div>
  );
}
