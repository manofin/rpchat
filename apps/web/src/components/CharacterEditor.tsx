import { useEffect, useState } from 'react';
import { del, get, post, postBinary, put } from '../lib/api';
import type { Character } from '../types';
import { Modal, useUi } from './ui';

const FROST_CHARACTER_ID = 'f89ace9b-8684-4d97-96dc-e00c4b25a819';
const AVATAR_ACCEPT = 'image/jpeg,image/png,image/webp';

type Draft = Omit<Character, 'id' | 'created_at' | 'updated_at' | 'archived' | 'conversation_count' | 'last_chat_at'>;

const EMPTY: Draft = {
  name: '', tagline: '', avatar: null, description: '', personality: '', speech_style: '', scenario: '',
  first_message: '', example_dialogue: '', taboos: '', tags: [], // scene/voice optional
} as unknown as Draft;

interface LoreEntry {
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

export function CharacterEditor({ open, character, onClose, onSaved }: { open: boolean; character: Character | null; onClose: () => void; onSaved: (c: Character) => void }) {
  const ui = useUi();
  const [d, setD] = useState<Draft>(EMPTY);
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [lore, setLore] = useState<LoreEntry[]>([]);
  const [tab, setTab] = useState<'card' | 'lore'>('card');
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTab('card');
    if (character) {
      const { id, created_at, updated_at, archived, conversation_count, last_chat_at, ...rest } = character;
      setD(rest as Draft);
      get<LoreEntry[]>(`/api/characters/${character.id}/lore`).then(setLore).catch(() => setLore([]));
    } else {
      setD(EMPTY);
      setLore([]);
    }
  }, [open, character]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));

  async function save() {
    if (!d.name.trim()) return ui.toast('이름은 필수', 'err');
    setSaving(true);
    try {
      const saved = character ? await put<Character>(`/api/characters/${character.id}`, d) : await post<Character>('/api/characters', d);
      ui.toast('저장됨');
      onSaved(saved);
    } catch (e) {
      ui.toast((e as Error).message, 'err');
    } finally {
      setSaving(false);
    }
  }

  function addTag() {
    const t = tagInput.trim();
    if (t && !d.tags.includes(t)) set('tags', [...d.tags, t]);
    setTagInput('');
  }

  return (
    <Modal
      open={open}
      title={character ? '캐릭터 편집' : '새 캐릭터'}
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>취소</button><button className="btn primary" disabled={saving || uploading} onClick={save}>{saving ? '저장 중…' : '저장'}</button></>}
    >
      <div className="sheet tabs" style={{ padding: '0 0 10px' }}>
        <button className={tab === 'card' ? 'active' : ''} onClick={() => setTab('card')}>카드</button>
        <button className={tab === 'lore' ? 'active' : ''} onClick={() => setTab('lore')} disabled={!character}>로어{character ? ` (${lore.length})` : ' (저장 후)'}</button>
      </div>

      {tab === 'card' ? (
        <>
          <div className="field"><label>이름 *</label><input value={d.name} onChange={(e) => set('name', e.target.value)} maxLength={80} /></div>
          <div className="field"><label>한 줄 소개</label><input value={d.tagline} onChange={(e) => set('tagline', e.target.value)} maxLength={200} /></div>
          <div className="field"><label>아바타 URL (선택)</label><input value={d.avatar ?? ''} onChange={(e) => set('avatar', e.target.value || null)} placeholder="비워두면 이니셜 표시" /></div>
          {character && character.id !== FROST_CHARACTER_ID && (
            <div className="field">
              <label>아바타 파일</label>
              <input
                type="file"
                accept={AVATAR_ACCEPT}
                disabled={uploading}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  setUploading(true);
                  try {
                    const saved = await postBinary<Character>(`/api/characters/${character.id}/avatar`, file, file.type || 'application/octet-stream');
                    set('avatar', saved.avatar);
                    ui.toast('아바타 업로드됨');
                  } catch (err) {
                    ui.toast((err as Error).message, 'err');
                  } finally {
                    setUploading(false);
                  }
                }}
              />
              <span className="hint">jpeg/png/webp · 최대 2MB. 변환 없음.</span>
            </div>
          )}
          <div className="field"><label>설명 / 배경</label><textarea value={d.description} onChange={(e) => set('description', e.target.value)} /></div>
          <div className="field"><label>성격</label><textarea value={d.personality} onChange={(e) => set('personality', e.target.value)} /></div>
          <div className="field"><label>말투</label><textarea value={d.speech_style} onChange={(e) => set('speech_style', e.target.value)} placeholder="예: 반말, 짧고 툭툭 던지는 말투. 문장 끝을 흐림." /></div>
          <div className="field"><label>기본 장면 / 시나리오</label><textarea value={d.scenario} onChange={(e) => set('scenario', e.target.value)} /></div>
          <div className="field"><label>첫 메시지</label><textarea value={d.first_message} onChange={(e) => set('first_message', e.target.value)} placeholder="{{char}}, {{user}} 치환 가능" /></div>
          <div className="field"><label>예시 대화</label><textarea value={d.example_dialogue} onChange={(e) => set('example_dialogue', e.target.value)} style={{ minHeight: 120 }} placeholder={'{{user}}: ...\n{{char}}: ...'} /><span className="hint">컨텍스트가 부족하면 이 블록이 먼저 잘립니다.</span></div>
          <div className="field"><label>금기 / 하지 말 것</label><textarea value={d.taboos} onChange={(e) => set('taboos', e.target.value)} /></div>
          <div className="field">
            <label>태그</label>
            <div className="row"><input value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addTag())} placeholder="입력 후 Enter" /><button className="btn sm" onClick={addTag}>추가</button></div>
            <div className="tags" style={{ marginTop: 6 }}>{d.tags.map((t) => <span key={t} className="tag" onClick={() => set('tags', d.tags.filter((x) => x !== t))}>{t} ✕</span>)}</div>
          </div>
        </>
      ) : (
        character && <LorePanel characterId={character.id} lore={lore} setLore={setLore} />
      )}
    </Modal>
  );
}

function LorePanel({ characterId, lore, setLore }: { characterId: string; lore: LoreEntry[]; setLore: (l: LoreEntry[]) => void }) {
  const ui = useUi();
  const [editing, setEditing] = useState<LoreEntry | null>(null);
  const blank: LoreEntry = { id: '', title: '', keywords: [], secondary_keys: [], content: '', priority: 0, always_on: false, token_cap: 300, enabled: true, selective: false };

  async function saveEntry(e: LoreEntry) {
    if (!e.title.trim() || !e.content.trim()) return ui.toast('제목과 내용 필요', 'err');
    try {
      const payload = { title: e.title, keywords: e.keywords, secondary_keys: e.secondary_keys ?? [], content: e.content, priority: e.priority, always_on: e.always_on, token_cap: e.token_cap, enabled: e.enabled, selective: !!e.selective };
      const saved = e.id ? await put<LoreEntry>(`/api/lore/${e.id}`, payload) : await post<LoreEntry>(`/api/characters/${characterId}/lore`, payload);
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
