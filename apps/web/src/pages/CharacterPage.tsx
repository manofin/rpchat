import { useEffect, useState } from 'react';
import { del, get, patch, post } from '../lib/api';
import { back, navigate } from '../lib/router';
import type { Character, Conversation, Persona, Scene } from '../types';
import { Avatar, relTime } from '../components/view';
import { CharacterEditor } from '../components/CharacterEditor';
import { BottomSheet, Spinner, useUi } from '../components/ui';

export function CharacterPage({ id }: { id: string }) {
  const ui = useUi();
  const [char, setChar] = useState<Character | null>(null);
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [starter, setStarter] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [c, v] = await Promise.all([get<Character>(`/api/characters/${id}`), get<Conversation[]>(`/api/conversations?characterId=${id}`)]);
      setChar(c);
      setConvs(v);
    } catch (e) {
      ui.toast((e as Error).message, 'err');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, [id]);

  async function archiveChar() {
    if (!(await ui.confirm(`'${char?.name}' 캐릭터를 보관할까요? 대화는 유지되지만 목록에서 숨겨집니다.`, { danger: true, okLabel: '보관' }))) return;
    await del(`/api/characters/${id}`);
    navigate('/', { replace: true });
  }

  if (loading || !char) return <div className="screen"><div className="topbar"><button className="btn ghost icon" onClick={() => back('/')}>‹</button></div><Spinner /></div>;

  return (
    <div className="screen">
      <div className="topbar">
        <button className="btn ghost icon" onClick={() => back('/')} aria-label="뒤로">‹</button>
        <div className="title"><h1>{char.name}</h1><div className="sub">{char.tagline}</div></div>
        <button className="btn ghost icon" onClick={() => setEditorOpen(true)} aria-label="편집">✎</button>
      </div>
      <div className="content">
        <div style={{ textAlign: 'center', marginBottom: 12 }}>
          <Avatar name={char.name} avatar={char.avatar} size="lg" />
          {char.tags.length > 0 && <div className="tags" style={{ justifyContent: 'center', marginTop: 10 }}>{char.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>}
        </div>
        {char.description && <div className="card" style={{ marginBottom: 12, whiteSpace: 'pre-wrap' }}>{char.description}</div>}

        <button className="btn primary block" onClick={() => setStarter(true)} style={{ marginBottom: 8 }}>＋ 새 대화 시작</button>
        <button className="btn danger block sm" onClick={archiveChar} style={{ marginBottom: 18 }}>캐릭터 보관</button>

        <div className="section-title">대화 {convs.length > 0 && `(${convs.length})`}</div>
        {convs.length === 0 ? (
          <div className="muted small">아직 대화가 없습니다.</div>
        ) : (
          <div className="list">
            {convs.map((v) => (
              <ConversationRow key={v.id} conv={v} onChanged={load} />
            ))}
          </div>
        )}
      </div>

      <CharacterEditor open={editorOpen} character={char} onClose={() => setEditorOpen(false)} onSaved={() => { setEditorOpen(false); load(); }} />
      <NewConversationSheet open={starter} character={char} onClose={() => setStarter(false)} />
    </div>
  );
}

function ConversationRow({ conv, onChanged }: { conv: Conversation; onChanged: () => void }) {
  const ui = useUi();
  async function remove(e: React.MouseEvent) {
    e.stopPropagation();
    if (!(await ui.confirm('이 대화를 삭제할까요? 되돌릴 수 없습니다.', { danger: true, okLabel: '삭제' }))) return;
    await del(`/api/conversations/${conv.id}`);
    onChanged();
  }
  async function toggleFav(e: React.MouseEvent) {
    e.stopPropagation();
    await patch(`/api/conversations/${conv.id}`, { favorite: !conv.favorite });
    onChanged();
  }
  return (
    <div className="list-item" onClick={() => navigate(`/chat/${conv.id}`)}>
      <div className="body">
        <div className="t">{conv.favorite ? '★ ' : ''}{conv.title || '대화'}</div>
        <div className="p">{conv.preview || '메시지 없음'}</div>
        <div className="p muted">{relTime(conv.last_message_at || conv.created_at)}</div>
      </div>
      <button className="btn ghost icon" onClick={toggleFav} aria-label="즐겨찾기">{conv.favorite ? '★' : '☆'}</button>
      <button className="btn ghost icon" onClick={remove} aria-label="삭제">🗑</button>
    </div>
  );
}

function NewConversationSheet({ open, character, onClose }: { open: boolean; character: Character; onClose: () => void }) {
  const ui = useUi();
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [personaId, setPersonaId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [scene, setScene] = useState<Scene>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(''); setScene({});
    get<Persona[]>('/api/personas').then((ps) => {
      setPersonas(ps);
      setPersonaId(ps.find((p) => p.is_default)?.id ?? ps[0]?.id ?? null);
    });
  }, [open]);

  async function create() {
    setBusy(true);
    try {
      const conv = await post<Conversation>('/api/conversations', { characterId: character.id, personaId, mode: 'story', title: title.trim() || undefined, scene });
      onClose();
      navigate(`/chat/${conv.id}`);
    } catch (e) {
      ui.toast((e as Error).message, 'err');
    } finally {
      setBusy(false);
    }
  }

  const setScn = (k: keyof Scene, v: string) => setScene((p) => ({ ...p, [k]: v || undefined }));

  return (
    <BottomSheet open={open} onClose={onClose}>
      <div className="sheet-body">
        <strong>새 대화 · {character.name}</strong>
        <div className="field" style={{ marginTop: 12 }}>
          <label>내 페르소나</label>
          <select value={personaId ?? ''} onChange={(e) => setPersonaId(e.target.value || null)}>
            <option value="">(익명 · '나')</option>
            {personas.map((p) => <option key={p.id} value={p.id}>{p.name}{p.is_default ? ' (기본)' : ''}</option>)}
          </select>
          <span className="hint">페르소나는 설정에서 관리합니다.</span>
        </div>
        <div className="field"><label>대화 제목 (선택)</label><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="비우면 자동" /></div>
        <details style={{ marginBottom: 12 }}>
          <summary className="muted small">장면 설정 (선택)</summary>
          <div style={{ marginTop: 8 }}>
            <div className="field"><label>장소</label><input value={scene.place ?? ''} onChange={(e) => setScn('place', e.target.value)} /></div>
            <div className="field"><label>시간/상황</label><input value={scene.time ?? ''} onChange={(e) => setScn('time', e.target.value)} /></div>
            <div className="field"><label>목표/훅</label><input value={scene.goal ?? ''} onChange={(e) => setScn('goal', e.target.value)} /></div>
            <div className="field"><label>장르/톤</label><input value={scene.genre ?? ''} onChange={(e) => setScn('genre', e.target.value)} /></div>
          </div>
        </details>
        <button className="btn primary block" disabled={busy} onClick={create}>{busy ? '생성 중…' : '시작'}</button>
      </div>
    </BottomSheet>
  );
}
