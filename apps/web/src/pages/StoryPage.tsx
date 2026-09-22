import { useEffect, useRef, useState } from 'react';
import { ApiError, del, get, post } from '../lib/api';
import { activeStoryCast, buildStoryStartRequest } from '../lib/storyStartRequest';
import { back, navigate } from '../lib/router';
import type { Character, Conversation, Story, StoryInjectPreview } from '../types';
import { StoryEditor } from '../components/StoryEditor';
import { StoryCover } from '../components/StoryCover';
import { Avatar } from '../components/view';
import { BottomSheet, Spinner, useUi } from '../components/ui';
import { ConversationRow } from './CharacterPage';

const ARCHIVED_START_MSG = '보관된 스토리에서는 새 대화를 시작할 수 없습니다.\n스토리를 다시 활성화한 뒤 시도해 주세요.';
type PreviewKind = 'idle' | 'loading' | 'ok' | 'archived' | 'missing' | 'error';

export function isArchivedError(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.status !== 409) return false;
  if (e.message === 'archived') return true;
  return typeof e.body === 'object' && e.body !== null && (e.body as { error?: unknown }).error === 'archived';
}

export function StoryPage({ id }: { id: string }) {
  return <StoryDetailPage key={id} id={id} />;
}

export function StoryDetailPage({ id }: { id: string }) {
  const ui = useUi();
  const [story, setStory] = useState<Story | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [editor, setEditor] = useState<'profile' | 'opening' | null>(null);
  const [starter, setStarter] = useState<'choose' | 'new' | null>(null);
  useEffect(() => {
    let active = true;
    setError(false);
    get<Story>(`/api/stories/${id}`).then((s) => { if (active) setStory(s); })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [id, retry]);
  useEffect(() => {
    let active = true;
    get<Character[]>('/api/characters').then((cs) => { if (active) setCharacters(cs); }).catch(() => {});
    return () => { active = false; };
  }, [id, retry]);

  function closeEditor() { setEditor(null); setRetry((n) => n + 1); }
  function editCast() { setStarter(null); setEditor('opening'); }
  async function archiveStory() {
    if (!(await ui.confirm(`'${story?.name}' 스토리를 보관할까요? 목록에서 숨겨집니다.`, { danger: true, okLabel: '보관' }))) return;
    try { await del(`/api/stories/${id}`); navigate('/?tab=story', { replace: true }); }
    catch (e) { ui.toast((e as Error).message, 'err'); }
  }

  return <div className="screen story-detail">
    <div className="topbar">
      <button className="btn ghost icon" onClick={() => back('/?tab=story')} aria-label="뒤로">‹</button>
      <div className="title"><h1>스토리 소개</h1></div>
      {story && <button className="btn ghost sm" onClick={() => setEditor('profile')}>스토리 수정</button>}
    </div>
    <div className="content story-detail-content">
      {error && <div className="story-notice" role="alert"><p>스토리를 불러오지 못했습니다.</p><button className="btn sm" onClick={() => setRetry((n) => n + 1)}>다시 시도</button></div>}
      {!story && !error && <Spinner />}
      {story && <StoryDetailView story={story} characters={characters} />}
      {story && !story.archived && <details className="story-manage"><summary>스토리 관리</summary><button className="btn danger sm" onClick={() => void archiveStory()}>스토리 보관</button></details>}
    </div>
    {story && <footer className="story-detail-footer"><button className="btn primary block" onClick={() => setStarter('choose')}>대화 시작</button></footer>}
    {story && <StoryEditor open={editor !== null} initialTab={editor ?? 'profile'} story={story} hosted={story.characters ?? []} onClose={closeEditor} onSaved={closeEditor} />}
    {story && starter === 'choose' && <StoryConversationChooser story={story} onClose={() => setStarter(null)} onNew={() => setStarter('new')} />}
    {story && starter === 'new' && <NewStoryConversationSheet id={id} onClose={() => setStarter(null)} onBack={() => setStarter('choose')} onEdit={editCast} onArchived={() => setRetry((n) => n + 1)} />}
  </div>;
}

export function StoryDetailView({ story, characters = [] }: { story: Story; characters?: Character[] }) {
  const hosted = story.characters ?? [];
  return <>
    <header className="story-hero">
      <div className="story-hero-cover"><StoryCover name={story.name} cover={story.cover} /></div>
      <div className="story-hero-body"><span className="story-eyebrow">STORY</span><h2>{story.name}</h2>
        {story.tagline.trim() && <p>{story.tagline}</p>}
        <div className="story-facts"><span>등장 캐릭터 {hosted.length}명</span>{(story.endings ?? []).length > 0 && <span>엔딩 {(story.endings ?? []).length}개 수록</span>}{story.archived && <span>보관된 스토리</span>}</div>
      </div>
    </header>
    <section className="story-section" aria-labelledby="story-world"><h2 id="story-world">세계관 소개</h2><p>{story.setting.trim() || '아직 등록된 세계관 소개가 없습니다.'}</p></section>
    <section className="story-section" aria-labelledby="story-cast"><h2 id="story-cast">등장 캐릭터</h2>
      {hosted.length ? <div className="story-cast-grid">{hosted.map((c) => {
        const card = characters.find((item) => item.id === c.character_id);
        return <button key={c.character_id} className="story-cast-card" onClick={() => navigate(`/character/${c.character_id}`)}><Avatar name={c.name} avatar={card?.avatar} size="lg" /><span>{c.name}</span>{card?.tagline && <small>{card.tagline}</small>}</button>;
      })}</div> : <p>아직 등록된 등장 캐릭터가 없습니다.</p>}
      {story.minor_cast.length > 0 && <div className="story-minor-cast">{story.minor_cast.map((c, i) => <div key={`${c.name}-${i}`}><h3>{c.name}</h3>{c.note && <p>{c.note}</p>}</div>)}</div>}
    </section>
    {story.opening?.scenario.trim() && <section className="story-section" aria-labelledby="story-opening"><h2 id="story-opening">이야기의 시작</h2><p>{story.opening.scenario}</p></section>}
    {(story.scene_catalog?.places ?? []).length > 0 && <section className="story-section" aria-labelledby="story-places"><h2 id="story-places">이야기 속 장소</h2><div className="story-place-list">{story.scene_catalog.places.map((place) => <span key={place.id}>{place.name || place.id}</span>)}</div></section>}
  </>;
}

export function StoryConversationChooser({ story, onClose, onNew }: { story: Story; onClose: () => void; onNew: () => void }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const pagePending = useRef(true);
  useEffect(() => {
    let active = true;
    pagePending.current = true;
    setLoading(true); setError(false);
    if (offset === 0) setConversations([]);
    get<Conversation[]>(`/api/conversations?storyId=${encodeURIComponent(story.id)}&limit=50&offset=${offset}`).then((rows) => {
      if (!active) return;
      setConversations((previous) => offset === 0 ? rows : [...previous, ...rows.filter((row) => !previous.some((p) => p.id === row.id))]);
      setMore(rows.length === 50);
    }).catch(() => { if (active) setError(true); }).finally(() => { if (active) { pagePending.current = false; setLoading(false); } });
    return () => { active = false; };
  }, [story.id, offset, retry]);
  function refresh() { setOffset(0); setRetry((n) => n + 1); }
  return <div className="story-conversation-sheet"><BottomSheet open onClose={onClose}>
    <div className="story-sheet-heading"><div><strong>{story.name}</strong><p>이어서 대화하거나 새롭게 시작하세요.</p></div><button className="btn ghost icon" onClick={onClose} aria-label="대화 선택 닫기">✕</button></div>
    <div className="sheet-body">
      <button className="btn primary block" autoFocus disabled={story.archived} onClick={onNew}>＋ 새 대화</button>
      {story.archived && <p className="muted small">보관된 스토리입니다. 기존 대화는 이어갈 수 있습니다.</p>}
      <h3 className="story-conversations-title">이전 대화</h3>
      {conversations.length > 0 && <div className="list">{conversations.map((conv) => <ConversationRow key={conv.id} conv={conv} onChanged={refresh} />)}</div>}
      {loading && <Spinner />}
      {error && <div className="story-notice" role="alert"><p>대화 목록을 불러오지 못했습니다.</p><button className="btn sm" onClick={() => setRetry((n) => n + 1)}>다시 시도</button></div>}
      {!loading && !error && conversations.length === 0 && <p className="muted">아직 대화가 없습니다. 새 대화로 이야기를 시작해 보세요.</p>}
      {!error && more && <button className="btn block" disabled={loading} onClick={() => { if (pagePending.current) return; pagePending.current = true; setOffset((n) => n + 50); }}>이전 대화 더 보기</button>}
    </div>
  </BottomSheet></div>;
}

export function NewStoryConversationSheet({ id, onClose, onBack, onEdit, onArchived }: { id: string; onClose: () => void; onBack: () => void; onEdit: () => void; onArchived: () => void }) {
  const ui = useUi();
  const [story, setStory] = useState<Story | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [openingPick, setOpeningPick] = useState('');
  const [previewKind, setPreviewKind] = useState<PreviewKind>('idle');
  const [preview, setPreview] = useState<StoryInjectPreview | null>(null);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [starting, setStarting] = useState(false);
  const pending = useRef(false);
  const active = useRef(true);
  const previewSeq = useRef(0);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(false); setPreviewKind('idle');
    Promise.all([get<Story>(`/api/stories/${id}`), get<Character[]>('/api/characters')]).then(([s, cs]) => {
      if (cancelled) return;
      setStory(s); setCharacters(cs);
      setOpeningPick((pick) => (s.openings_extra ?? []).some((extra) => extra.id === pick) ? pick : '');
    }).catch(() => { if (!cancelled) setError(true); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id, retry]);
  const hosted = story ? activeStoryCast(story, characters) : [];
  const rosterIds = hosted.map((c) => c.character_id);
  const startPick = hosted[0]?.character_id ?? '';
  useEffect(() => {
    const seq = ++previewSeq.current;
    setPreview(null);
    if (loading || error || !story || !startPick || hosted.length > 12) { setPreviewKind('idle'); return; }
    if (story.archived) { setPreviewKind('archived'); return; }
    let cancelled = false;
    setPreviewKind('loading');
    get<StoryInjectPreview>(`/api/stories/${id}/inject-preview?characterId=${encodeURIComponent(startPick)}`).then((data) => {
      if (cancelled || seq !== previewSeq.current) return;
      setPreview(data); setPreviewKind('ok');
    }).catch((e) => {
      if (cancelled || seq !== previewSeq.current) return;
      if (isArchivedError(e)) { setPreviewKind('archived'); onArchived(); }
      else if (e instanceof ApiError && e.status === 404) setPreviewKind('missing');
      else setPreviewKind('error');
    });
    return () => { cancelled = true; };
  }, [id, story, startPick, loading, error, hosted.length, previewRetry]);

  const startReady = Boolean(story && !story.archived && startPick && hosted.length <= 12) && !loading && !error && previewKind === 'ok' && !starting;
  async function startChat() {
    if (pending.current || !startReady) return;
    pending.current = true; setStarting(true);
    try {
      const conv = await post<Conversation>('/api/conversations', buildStoryStartRequest({ characterId: startPick, storyId: id, selectedIds: rosterIds, openingId: openingPick }));
      if (!active.current) return;
      onClose(); navigate(`/chat/${conv.id}`);
    } catch (e) {
      if (!active.current) return;
      if (isArchivedError(e)) { setPreviewKind('archived'); setPreview(null); onArchived(); }
      else ui.toast((e as Error).message, 'err');
    } finally { pending.current = false; if (active.current) setStarting(false); }
  }
  return <div className="story-conversation-sheet"><BottomSheet open onClose={() => { if (!pending.current) onClose(); }}>
    <div className="story-sheet-heading"><button className="btn ghost icon" disabled={starting} onClick={onBack} aria-label="대화 선택으로 돌아가기">‹</button><strong>새 대화{story ? ` · ${story.name}` : ''}</strong><button className="btn ghost icon" disabled={starting} onClick={onClose} aria-label="새 대화 닫기">✕</button></div>
    <div className="sheet-body">
      {loading && <Spinner />}
      {error && <div className="story-notice" role="alert"><p>시작 설정을 불러오지 못했습니다.</p><button className="btn sm" onClick={() => setRetry((n) => n + 1)}>다시 시도</button></div>}
      {story && !loading && !error && <>
        {hosted.length === 0 ? <div className="story-notice"><p>함께할 캐릭터를 먼저 등록해 주세요.</p><button className="btn" onClick={onEdit}>참여 캐릭터 설정</button></div>
          : hosted.length > 12 ? <div className="story-notice" role="alert"><p>한 대화에는 최대 12명이 참여할 수 있습니다. 스토리 수정에서 참여 명단을 줄여 주세요.</p><button className="btn" onClick={onEdit}>참여 캐릭터 설정</button></div>
          : <>
            <div className="story-start-cast"><h3>함께할 캐릭터</h3><p>{hosted.map((c) => c.name).join(' · ')}</p><button className="btn ghost sm" disabled={starting} onClick={onEdit}>스토리 수정에서 변경</button></div>
            {(story.openings_extra ?? []).length > 0 && <div className="field"><label htmlFor="story-opening-pick">시작 설정</label><select id="story-opening-pick" value={openingPick} disabled={starting} onChange={(e) => setOpeningPick(e.target.value)}><option value="">기본</option>{(story.openings_extra ?? []).map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select></div>}
            {previewKind === 'ok' ? <details className="story-preview"><summary>대화에 적용될 설정 확인</summary><StartPreview kind={previewKind} preview={preview} onRetry={() => setPreviewRetry((n) => n + 1)} /></details> : <StartPreview kind={previewKind} preview={preview} onRetry={() => { setPreviewRetry((n) => n + 1); setRetry((n) => n + 1); }} />}
            <button className="btn primary block" disabled={!startReady} onClick={() => void startChat()}>{starting ? '생성 중…' : '시작'}</button>
          </>}
      </>}
    </div>
  </BottomSheet></div>;
}

export function StartPreview({
  kind,
  preview,
  onRetry,
}: {
  kind: PreviewKind;
  preview: StoryInjectPreview | null;
  onRetry: () => void;
}) {
  if (kind === 'idle') {
    return <p className="muted small" role="status" aria-live="polite">시작 설정을 확인하고 있습니다.</p>;
  }
  if (kind === 'loading') {
    return <div role="status" aria-live="polite" aria-busy="true"><Spinner label="미리보기를 불러오는 중…" /></div>;
  }
  if (kind === 'archived') {
    return (
      <div className="banner err" role="alert" style={{ whiteSpace: 'pre-wrap', marginBottom: 12 }}>
        {ARCHIVED_START_MSG}
      </div>
    );
  }
  if (kind === 'missing' || kind === 'error') {
    return (
      <div className="banner err" role="alert" style={{ marginBottom: 12 }}>
        <div>{kind === 'missing' ? '미리보기를 불러올 수 없습니다.' : '미리보기를 불러오지 못했습니다.'}</div>
        <button type="button" className="btn sm" style={{ marginTop: 8 }} onClick={onRetry}>다시 시도</button>
      </div>
    );
  }
  if (!preview) return null;
  const included = preview.cast.filter((c) => c.included).length;
  const excluded = preview.cast.filter((c) => !c.included).length;
  const excerpt = preview.settingExcerpt.trim();
  return (
    <div className="card" role="status" aria-live="polite" style={{ marginBottom: 12 }}>
      <div className="small" style={{ marginBottom: 8 }}>대화에 적용될 스토리 설정</div>
      {excerpt
        ? <div style={{ whiteSpace: 'pre-wrap', marginBottom: 8 }}>{excerpt}</div>
        : <div className="muted small" style={{ marginBottom: 8 }}>설정이 없습니다.</div>}
      <div className="muted small">설정: {preview.settingTruncated ? '일부 잘림' : '전체 포함'}</div>
      <div className="muted small">
        {preview.cast.length === 0
          ? '설정 이름: 없음'
          : `설정 이름: ${included}명 포함, ${excluded}명 제외`}
      </div>
      <div className="muted small">예상 사용량: 약 {preview.estTokens} 토큰</div>
      <div className="muted small" style={{ marginTop: 8 }}>
        대화를 시작하면 현재 설정이 이 대화에 동결됩니다.
        이후 스토리를 수정해도 이미 시작한 대화에는 반영되지 않습니다.
      </div>
    </div>
  );
}
