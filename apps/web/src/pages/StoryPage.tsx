import { useEffect, useState } from 'react';
import { del, get, post } from '../lib/api';
import { back, navigate } from '../lib/router';
import type { Character, Conversation, Story, StoryCharacter } from '../types';
import { StoryEditor } from '../components/StoryEditor';
import { BottomSheet, Spinner, useUi } from '../components/ui';

export function StoryPage({ id }: { id: string }) {
  const ui = useUi();
  const [story, setStory] = useState<Story | null>(null);
  const [chars, setChars] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [pickId, setPickId] = useState('');
  const [starter, setStarter] = useState(false);
  const [startPick, setStartPick] = useState('');

  async function load() {
    setLoading(true);
    try {
      const [s, list] = await Promise.all([get<Story>(`/api/stories/${id}`), get<Character[]>('/api/characters')]);
      setStory(s);
      setChars(list);
    } catch (e) {
      ui.toast((e as Error).message, 'err');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, [id]);

  async function archiveStory() {
    if (!(await ui.confirm(`'${story?.name}' 스토리를 보관할까요? 목록에서 숨겨집니다.`, { danger: true, okLabel: '보관' }))) return;
    await del(`/api/stories/${id}`);
    navigate('/', { replace: true });
  }

  async function addMain() {
    if (!pickId) return;
    try {
      await post(`/api/stories/${id}/characters`, { characterId: pickId, role: 'main' });
      setPickId('');
      await load();
    } catch (e) {
      ui.toast((e as Error).message, 'err');
    }
  }

  async function removeMain(characterId: string) {
    if (!(await ui.confirm('이 메인 캐릭터를 스토리에서 뺄까요? 캐릭터 자체는 남습니다.', { okLabel: '빼기' }))) return;
    try {
      await del(`/api/stories/${id}/characters/${characterId}`);
      await load();
    } catch (e) {
      ui.toast((e as Error).message, 'err');
    }
  }

  async function startChat() {
    if (!startPick) return;
    try {
      const conv = await post<Conversation>('/api/conversations', {
        characterId: startPick,
        storyId: id,
        mode: 'story',
      });
      setStarter(false);
      navigate(`/chat/${conv.id}`);
    } catch (e) {
      ui.toast((e as Error).message, 'err');
    }
  }

  if (loading || !story) return <div className="screen"><div className="topbar"><button className="btn ghost icon" onClick={() => back('/')}>‹</button></div><Spinner /></div>;

  const hosted: StoryCharacter[] = story.characters ?? [];
  const hostedIds = new Set(hosted.map((c) => c.character_id));
  const available = chars.filter((c) => !hostedIds.has(c.id));

  return (
    <div className="screen">
      <div className="topbar">
        <button className="btn ghost icon" onClick={() => back('/')} aria-label="뒤로">‹</button>
        <div className="title"><h1>{story.name}</h1><div className="sub">{story.tagline}</div></div>
        <button className="btn ghost icon" onClick={() => setEditorOpen(true)} aria-label="편집">✎</button>
      </div>
      <div className="content">
        {story.setting ? <div className="card" style={{ marginBottom: 12, whiteSpace: 'pre-wrap' }}>{story.setting}</div> : <div className="muted small" style={{ marginBottom: 12 }}>설정이 없습니다.</div>}

        <div className="section-title">조연</div>
        {story.minor_cast.length === 0 ? (
          <div className="muted small" style={{ marginBottom: 12 }}>조연 없음</div>
        ) : (
          <div className="list" style={{ marginBottom: 12 }}>
            {story.minor_cast.map((m, i) => (
              <div key={`${m.name}-${i}`} className="list-item">
                <div className="body">
                  <div className="t">{m.name}</div>
                  <div className="p">{m.note || ' '}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="section-title">메인 캐릭터 {hosted.length > 0 && `(${hosted.length})`}</div>
        {hosted.length === 0 ? (
          <div className="muted small" style={{ marginBottom: 12 }}>메인 캐릭터를 추가하세요.</div>
        ) : (
          <div className="list" style={{ marginBottom: 12 }}>
            {hosted.map((c) => (
              <div key={c.character_id} className="list-item" onClick={() => navigate(`/character/${c.character_id}`)}>
                <div className="body">
                  <div className="t">{c.name}</div>
                  <div className="p muted">메인</div>
                </div>
                <button className="btn ghost icon" onClick={(e) => { e.stopPropagation(); void removeMain(c.character_id); }} aria-label="빼기">✕</button>
              </div>
            ))}
          </div>
        )}

        {available.length > 0 && (
          <div className="field">
            <label>메인 캐릭터 추가</label>
            <select value={pickId} onChange={(e) => setPickId(e.target.value)}>
              <option value="">선택</option>
              {available.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button className="btn block" style={{ marginTop: 8 }} disabled={!pickId} onClick={() => void addMain()}>추가</button>
          </div>
        )}

        {!story.archived && (
          <button
            className="btn primary block"
            disabled={hosted.length === 0}
            onClick={() => {
              setStartPick(hosted.length === 1 ? hosted[0].character_id : '');
              setStarter(true);
            }}
            style={{ marginTop: 18 }}
          >
            이 스토리로 대화 시작
          </button>
        )}
        <button className="btn danger block sm" onClick={() => void archiveStory()} style={{ marginTop: 18 }}>스토리 보관</button>
      </div>
      <StoryEditor open={editorOpen} story={story} onClose={() => setEditorOpen(false)} onSaved={() => { setEditorOpen(false); load(); }} />
      <BottomSheet open={starter} onClose={() => setStarter(false)}>
        <div className="sheet-body">
          <strong>이 스토리로 대화 시작</strong>
          <div className="field" style={{ marginTop: 12 }}>
            <label>메인 캐릭터</label>
            <select value={startPick} onChange={(e) => setStartPick(e.target.value)}>
              <option value="">선택</option>
              {hosted.map((c) => (
                <option key={c.character_id} value={c.character_id}>{c.name}</option>
              ))}
            </select>
          </div>
          <button className="btn primary block" disabled={!startPick} onClick={() => void startChat()}>시작</button>
        </div>
      </BottomSheet>
    </div>
  );
}
