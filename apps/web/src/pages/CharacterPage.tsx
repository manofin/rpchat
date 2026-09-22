import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { del, get, patch, post } from '../lib/api';
import { back, navigate } from '../lib/router';
import type { Character, Conversation, Persona, Scene, Story } from '../types';
import { DiscCover, relTime, softHue } from '../components/view';
import { CharacterEditor } from '../components/CharacterEditor';
import { BottomSheet, Spinner, useUi } from '../components/ui';
import { characterHeroEmpty, resolveConversationCount, resolveLastChatAt } from '../lib/characterChatStats';
import { loadCharacterStories } from '../lib/characterDetails';
import { publicTags } from '../lib/publicTags';
import { conversationTitleLabel } from '../lib/conversationTitleLabel';
import { stripDescSectionHeaders } from '../lib/stripDescSectionHeaders';

export function CharacterPage({ id }: { id: string }) {
  return <CharacterDetailPage key={id} id={id} />;
}

function CharacterDetailPage({ id }: { id: string }) {
  const ui = useUi();
  const [char, setChar] = useState<Character | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [stories, setStories] = useState<Story[]>([]);
  const [storiesLoading, setStoriesLoading] = useState(true);
  const [storiesError, setStoriesError] = useState(false);
  const [storiesRetry, setStoriesRetry] = useState(0);
  const [editorOpen, setEditorOpen] = useState(false);
  const [starter, setStarter] = useState<'choose' | 'new' | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    get<Character>(`/api/characters/${encodeURIComponent(id)}`).then((c) => {
      if (active) setChar(c);
    }).catch(() => {
      if (active) setError(true);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, revision]);

  useEffect(() => {
    let active = true;
    setStoriesLoading(true);
    setStoriesError(false);
    loadCharacterStories(id).then((result) => {
      if (!active) return;
      setStories(result.stories);
      setStoriesError(result.failed);
    }).catch(() => { if (active) setStoriesError(true); })
      .finally(() => { if (active) setStoriesLoading(false); });
    return () => { active = false; };
  }, [id, revision, storiesRetry]);

  async function archiveChar() {
    if (!(await ui.confirm(`'${char?.name}' 캐릭터를 보관할까요? 대화는 유지되지만 목록에서 숨겨집니다.`, { danger: true, okLabel: '보관' }))) return;
    try {
      await del(`/api/characters/${id}`);
      navigate('/?tab=character', { replace: true });
    } catch (e) { ui.toast((e as Error).message, 'err'); }
  }

  return (
    <div className="screen char-detail">
      <div className="topbar">
        <button className="btn ghost icon" onClick={() => back('/?tab=character')} aria-label="뒤로">‹</button>
        <div className="title"><h1>캐릭터 소개</h1></div>
        {char && <button className="btn ghost icon" onClick={() => setEditorOpen(true)} aria-label="캐릭터 편집">✎</button>}
      </div>
      <div className="content char-detail-content">
        {loading ? <Spinner /> : error || !char ? (
          <div className="empty-state" role="status">
            <p>캐릭터를 불러오지 못했습니다.</p>
            <button className="btn" onClick={() => setRevision((r) => r + 1)}>다시 시도</button>
          </div>
        ) : (
          <>
            <CharacterDetailView character={char} stories={stories} storiesLoading={storiesLoading} storiesError={storiesError} onRetryStories={() => setStoriesRetry((r) => r + 1)} />
            <details className="char-detail-manage">
              <summary>캐릭터 관리</summary>
              <button className="btn danger block sm" onClick={() => void archiveChar()}>캐릭터 보관</button>
            </details>
          </>
        )}
      </div>
      {char && !loading && !error && (
        <div className="char-detail-footer">
          <button className="btn primary block disc-start-cta" disabled={char.archived} onClick={() => setStarter('choose')}>
            {char.archived ? '보관된 캐릭터' : '대화 시작'}
          </button>
        </div>
      )}
      {char && <CharacterEditor open={editorOpen} character={char} onClose={() => setEditorOpen(false)} onSaved={() => { setEditorOpen(false); setRevision((r) => r + 1); }} />}
      {char && starter === 'choose' && <ConversationChooser character={char} onClose={() => setStarter(null)} onNew={() => setStarter('new')} />}
      {char && starter === 'new' && <NewConversationSheet character={char} onClose={() => setStarter(null)} onBack={() => setStarter('choose')} />}
    </div>
  );
}

export function CharacterDetailView({ character: char, stories, storiesLoading, storiesError, onRetryStories }: {
  character: Character; stories: Story[]; storiesLoading: boolean; storiesError: boolean; onRetryStories: () => void;
}) {
  const heroDesc = stripDescSectionHeaders(char.description);
  const worlds = stories.filter((story) => story.setting.trim());
  return (
    <>
      <div className="char-hero">
        <div className={`char-hero-cover${char.avatar ? '' : ' is-empty'}`} style={{ '--disc-hue': String(softHue(char.name)) } as CSSProperties}>
          {char.avatar ? <img className="char-hero-cover-img" src={char.avatar} alt={`${char.name} 대표 이미지`} /> : <div className="char-hero-cover-soft" aria-hidden><span>{char.name.trim().charAt(0)}</span></div>}
          <div className="char-hero-cover-scrim" aria-hidden />
        </div>
        <div className="char-hero-body">
          <h2 className="char-hero-name">{char.name}</h2>
          {char.tagline && <p className="char-hero-tag">{char.tagline}</p>}
          {publicTags(char.tags).length > 0 && <div className="tags char-detail-tags">{publicTags(char.tags).map((t) => <span key={t} className="tag">#{t}</span>)}</div>}
        </div>
      </div>
      <section className="char-detail-section" aria-labelledby="character-intro">
        <h2 id="character-intro">캐릭터 소개</h2>
        <p className="char-hero-desc">{heroDesc || '아직 등록된 소개가 없습니다.'}</p>
        {char.personality.trim() && <><h3>성격</h3><p>{char.personality}</p></>}
        {char.speech_style.trim() && <><h3>말투</h3><p>{char.speech_style}</p></>}
      </section>
      <section className="char-detail-section" aria-labelledby="character-stories">
        <h2 id="character-stories">등장 스토리{stories.length > 0 && <span className="char-section-count">{stories.length}</span>}</h2>
        {storiesLoading ? <Spinner label="스토리를 불러오는 중…" /> : (
          <>
            {storiesError && <div className="char-detail-notice" role="status"><p>{stories.length ? '일부 스토리를 불러오지 못했습니다.' : '스토리를 불러오지 못했습니다.'}</p><button className="btn sm" onClick={onRetryStories}>스토리 다시 불러오기</button></div>}
            {stories.length > 0 ? <div className="char-detail-stories">{stories.map((story) => (
              <button key={story.id} className="char-story-card" onClick={() => navigate(`/story/${story.id}`)}>
                <DiscCover name={story.name} avatar={story.cover} kind="story" />
                <span className="char-story-caption">{story.tagline || '이 캐릭터가 등장하는 스토리'}</span>
                <span className="char-story-link">스토리 보기 →</span>
              </button>
            ))}</div> : !storiesError && <p className="muted">아직 연결된 스토리가 없습니다.</p>}
          </>
        )}
      </section>
      {worlds.length > 0 && <section className="char-detail-section" aria-labelledby="character-world"><h2 id="character-world">세계관</h2>{worlds.map((story, i) => (
        <details key={story.id} className="char-world-entry" open={i === 0}><summary>{story.name}</summary><p>{stripDescSectionHeaders(story.setting)}</p></details>
      ))}</section>}
      {char.scenario.trim() && <section className="char-detail-section"><h2>시작 상황</h2><p>{char.scenario}</p></section>}
      {char.play_guide.trim() && <section className="char-detail-section"><h2>플레이 안내</h2><p>{char.play_guide}</p></section>}
      {char.first_message.trim() && <section className="char-detail-section"><h2>첫 만남</h2><blockquote className="char-first-message">{char.first_message}</blockquote></section>}
    </>
  );
}

export function ConversationChooser({ character, onClose, onNew }: { character: Character; onClose: () => void; onNew: () => void }) {
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const id = encodeURIComponent(character.id);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    get<Conversation[]>(`/api/conversations?characterId=${id}&limit=200`).then((list) => {
      if (active) setConvs(list);
    }).catch(() => { if (active) setError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, revision]);
  const convCount = resolveConversationCount(character.conversation_count, convs.length);
  const lastChat = resolveLastChatAt(character.last_chat_at, convs);
  return <div className="char-conversation-sheet"><BottomSheet open onClose={onClose}>
    <div className="char-sheet-heading"><div><strong>{character.name} · 대화하기</strong><p>이어서 대화하거나 새롭게 시작하세요.</p></div><button className="btn ghost icon" onClick={onClose} aria-label="대화 선택 닫기">✕</button></div>
    <div className="sheet-body">
      <button autoFocus className="btn primary block char-new-conversation" onClick={onNew}>＋ 새 대화</button>
      <h3 className="char-conversations-title">이전 대화{!loading && !error && convs.length > 0 ? ` (${convCount})` : ''}</h3>
      {loading ? <Spinner label="대화를 불러오는 중…" /> : error ? <div className="empty-state compact" role="status"><p>대화 목록을 불러오지 못했습니다.</p><button className="btn" onClick={() => setRevision((r) => r + 1)}>다시 시도</button></div> : characterHeroEmpty(convCount) ? <div className="empty-state compact"><div className="empty-state-title">아직 대화 없음</div><p className="empty-state-sub">새 대화로 첫 만남을 시작하세요.</p></div> : <>
        {lastChat && <p className="muted small">마지막 대화 · {relTime(lastChat)}</p>}
        <div className="list">{convs.map((v) => <ConversationRow key={v.id} conv={v} onChanged={() => setRevision((r) => r + 1)} />)}</div>
      </>}
    </div>
  </BottomSheet></div>;
}

export function ConversationRow({ conv, onChanged }: { conv: Conversation; onChanged: () => void }) {
  const ui = useUi();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  async function change(kind: 'delete' | 'favorite') {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      if (kind === 'delete') {
        if (!(await ui.confirm('이 대화를 삭제할까요? 되돌릴 수 없습니다.', { danger: true, okLabel: '삭제' }))) return;
        await del(`/api/conversations/${conv.id}`);
      } else await patch(`/api/conversations/${conv.id}`, { favorite: !conv.favorite });
      onChanged();
    } catch (e) { ui.toast((e as Error).message, 'err'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <div className="list-item char-conversation-row">
    <button className="char-conversation-open body" onClick={() => navigate(`/chat/${conv.id}`)}>
      <span className="t">{conv.favorite ? '★ ' : ''}{conversationTitleLabel(conv)}</span>
      <span className="p">{conv.preview || '메시지 없음'}</span>
      <span className="p muted">{relTime(conv.last_message_at || conv.created_at)}</span>
    </button>
    <button className="btn ghost icon" disabled={busy} onClick={() => void change('favorite')} aria-label="즐겨찾기" aria-pressed={conv.favorite}>{conv.favorite ? '★' : '☆'}</button>
    <button className="btn ghost icon" disabled={busy} onClick={() => void change('delete')} aria-label="삭제">🗑</button>
  </div>;
}

export function NewConversationSheet({ character, onClose, onBack }: { character: Character; onClose: () => void; onBack: () => void }) {
  const ui = useUi();
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [personaId, setPersonaId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [scene, setScene] = useState<Scene>({});
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(false);
    get<Persona[]>('/api/personas').then((ps) => {
      if (!active) return;
      setPersonas(ps);
      setPersonaId(ps.find((p) => p.is_default)?.id ?? ps[0]?.id ?? null);
    }).catch(() => { if (active) setError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [retry]);

  async function create() {
    if (pending.current || loading || error) return;
    pending.current = true;
    setBusy(true);
    try {
      const conv = await post<Conversation>('/api/conversations', { characterId: character.id, personaId, mode: 'story', title: title.trim() || undefined, scene });
      if (!active.current) return;
      onClose();
      navigate(`/chat/${conv.id}`);
    } catch (e) { if (active.current) ui.toast((e as Error).message, 'err'); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  const setScn = (k: keyof Scene, v: string) => setScene((p) => ({ ...p, [k]: v || undefined }));
  return <div className="char-conversation-sheet"><BottomSheet open onClose={() => { if (!pending.current) onClose(); }}>
    <div className="char-sheet-heading"><button className="btn ghost icon" disabled={busy} onClick={onBack} aria-label="대화 선택으로 돌아가기">‹</button><strong>새 대화 · {character.name}</strong><button className="btn ghost icon" disabled={busy} onClick={onClose} aria-label="새 대화 닫기">✕</button></div>
    <div className="sheet-body">
      {error && <div className="char-detail-notice" role="status"><p>페르소나를 불러오지 못했습니다.</p><button className="btn sm" onClick={() => setRetry((r) => r + 1)}>다시 시도</button></div>}
      <div className="field"><label htmlFor="character-start-persona">내 페르소나</label><select id="character-start-persona" value={personaId ?? ''} disabled={loading || busy || error} onChange={(e) => setPersonaId(e.target.value || null)}><option value="">{loading ? '불러오는 중…' : "(익명 · '나')"}</option>{personas.map((p) => <option key={p.id} value={p.id}>{p.name}{p.is_default ? ' (기본)' : ''}</option>)}</select><span className="hint">페르소나는 설정에서 관리합니다.</span></div>
      <div className="field"><label htmlFor="character-start-title">대화 제목 (선택)</label><input id="character-start-title" value={title} disabled={busy} onChange={(e) => setTitle(e.target.value)} placeholder="비우면 자동" /></div>
      <details className="char-start-scene"><summary>장면 설정 (선택)</summary><div>
        {([['place', '장소'], ['time', '시간/상황'], ['goal', '목표/훅'], ['genre', '장르/톤']] as const).map(([key, label]) => <div className="field" key={key}><label htmlFor={`character-start-${key}`}>{label}</label><input id={`character-start-${key}`} value={scene[key] ?? ''} disabled={busy} onChange={(e) => setScn(key, e.target.value)} /></div>)}
      </div></details>
      <button className="btn primary block" disabled={busy || loading || error} onClick={create}>{busy ? '생성 중…' : '시작'}</button>
    </div>
  </BottomSheet></div>;
}
