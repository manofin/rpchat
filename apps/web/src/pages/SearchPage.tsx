import { useEffect, useMemo, useRef, useState } from 'react';
import { get } from '../lib/api';
import { navigate, query, useLocation } from '../lib/router';
import type { Character, Story } from '../types';
import { Avatar, relTime } from '../components/view';
import { Spinner, useUi } from '../components/ui';
import { TopNav } from '../components/TopNav';

interface SearchHit {
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  characterName: string;
  role: string;
  snippet: string;
  bookmarked: boolean;
  createdAt: string;
}

type SearchScope = 'all' | 'messages' | 'characters' | 'stories' | 'bookmarks';

/** «…» 하이라이트를 <mark> 로 변환 (이스케이프 후) */
function Highlight({ snippet }: { snippet: string }) {
  const parts = snippet.split(/«|»/);
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>))}
    </>
  );
}

function matchesQuery(hay: string, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return false;
  return hay.toLowerCase().includes(needle);
}

export function SearchPage() {
  const ui = useUi();
  const loc = useLocation();
  const [q, setQ] = useState(() => query().get('q') ?? '');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [chars, setChars] = useState<Character[] | null>(null);
  const [stories, setStories] = useState<Story[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<SearchScope>('all');
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const fromUrl = new URLSearchParams(loc.search).get('q') ?? '';
    setQ((prev) => (prev === fromUrl ? prev : fromUrl));
  }, [loc.search]);

  useEffect(() => {
    void (async () => {
      try {
        const [c, s] = await Promise.all([
          get<Character[]>('/api/characters'),
          get<Story[]>('/api/stories'),
        ]);
        setChars(c);
        setStories(s);
      } catch {
        setChars([]);
        setStories([]);
      }
    })();
  }, []);

  useEffect(() => {
    window.clearTimeout(timer.current);
    const queryText = q.trim();
    if ([...queryText].length < 1) {
      setHits(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    timer.current = window.setTimeout(async () => {
      try {
        const r = await get<{ results: SearchHit[] }>(`/api/search?q=${encodeURIComponent(queryText)}&limit=30`);
        setHits(r.results);
        const next = `/search?q=${encodeURIComponent(queryText)}`;
        if (`${loc.pathname}${loc.search}` !== next) navigate(next, { replace: true });
      } catch (e) {
        ui.toast((e as Error).message, 'err');
      } finally {
        setBusy(false);
      }
    }, 300);
    return () => window.clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const charHits = useMemo(() => {
    if (!chars || !q.trim()) return [];
    return chars.filter((c) =>
      matchesQuery([c.name, c.tagline, c.description, ...(c.tags ?? [])].join('\n'), q),
    );
  }, [chars, q]);

  const storyHits = useMemo(() => {
    if (!stories || !q.trim()) return [];
    return stories.filter((s) =>
      matchesQuery([s.name, s.tagline, s.setting].join('\n'), q),
    );
  }, [stories, q]);

  const messageHits = useMemo(() => {
    if (!hits) return [];
    if (scope === 'bookmarks') return hits.filter((h) => h.bookmarked);
    return hits;
  }, [hits, scope]);

  const showChars = scope === 'all' || scope === 'characters';
  const showStories = scope === 'all' || scope === 'stories';
  const showMessages = scope === 'all' || scope === 'messages' || scope === 'bookmarks';

  const counts = {
    all: charHits.length + storyHits.length + (hits?.length ?? 0),
    characters: charHits.length,
    stories: storyHits.length,
    messages: hits?.length ?? 0,
    bookmarks: hits?.filter((h) => h.bookmarked).length ?? 0,
  };

  async function open(hit: SearchHit) {
    try {
      const d = await get<{ messages: { id: string }[] }>(`/api/conversations/${hit.conversationId}`);
      const onHead = d.messages.some((m) => m.id === hit.messageId);
      navigate(`/chat/${hit.conversationId}?jump=${hit.messageId}`);
      if (!onHead) ui.toast('이 메시지는 다른 분기에 있습니다 — 스와이프로 분기를 옮기면 볼 수 있어요', 'warn');
    } catch (e) {
      ui.toast((e as Error).message, 'err');
    }
  }

  const hasQuery = q.trim().length > 0;
  const empty =
    hasQuery &&
    !busy &&
    hits !== null &&
    (showMessages ? messageHits.length === 0 : true) &&
    (showChars ? charHits.length === 0 : true) &&
    (showStories ? storyHits.length === 0 : true) &&
    (scope !== 'all' || (charHits.length === 0 && storyHits.length === 0 && messageHits.length === 0));

  return (
    <div className="screen">
      <TopNav />
      <div className="search-hero">
        <h1 className="search-hero-title">
          {hasQuery ? (
            <>
              <span className="search-hero-q">“{q.trim()}”</span> 검색 결과
            </>
          ) : (
            '검색'
          )}
        </h1>
        <p className="search-hero-sub">캐릭터 · 스토리 · 대화 메시지를 찾아보세요</p>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="검색어를 입력하세요"
          className="search-input"
          aria-label="검색어"
        />
        {hasQuery && (
          <div className="filter-chips" role="toolbar" aria-label="검색 범위">
            {(
              [
                ['all', '전체', counts.all],
                ['characters', '캐릭터', counts.characters],
                ['stories', '스토리', counts.stories],
                ['messages', '메시지', counts.messages],
                ['bookmarks', '북마크', counts.bookmarks],
              ] as const
            ).map(([id, label, n]) => (
              <button
                key={id}
                type="button"
                className={`filter-chip${scope === id ? ' is-active' : ''}`}
                onClick={() => setScope(id)}
              >
                {label}
                <span className="filter-chip-count">{n}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="content">
        {!hasQuery && (
          <div className="empty-state">
            <div className="empty-state-ico" aria-hidden>🔍</div>
            <div className="empty-state-title">무엇을 찾을까요?</div>
            <p className="empty-state-sub">캐릭터 이름, 태그, 스토리, 대화 내용을 검색할 수 있어요</p>
          </div>
        )}
        {busy && hits === null && <Spinner />}
        {empty && (
          <div className="empty-state">
            <div className="empty-state-title">검색 결과가 없습니다</div>
            <p className="empty-state-sub">다른 키워드로 다시 검색해 보세요</p>
          </div>
        )}

        {hasQuery && showChars && charHits.length > 0 && (
          <section className="search-section">
            <div className="section-title">캐릭터</div>
            <div className="disc-grid">
              {charHits.map((c) => (
                <button key={c.id} type="button" className="disc-card" onClick={() => navigate(`/character/${c.id}`)}>
                  <div className="disc-card-top">
                    <Avatar name={c.name} avatar={c.avatar} size="sm" />
                    <div className="disc-card-head">
                      <div className="disc-card-name">{c.name}</div>
                      <div className="disc-card-tag">{c.tagline || ' '}</div>
                    </div>
                  </div>
                  <div className="disc-card-meta">
                    <span>{c.conversation_count ? `대화 ${c.conversation_count}개` : '새 캐릭터'}</span>
                    <span className="disc-card-cta">대화하기</span>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {hasQuery && showStories && storyHits.length > 0 && (
          <section className="search-section">
            <div className="section-title">스토리</div>
            <div className="disc-grid">
              {storyHits.map((s) => (
                <button key={s.id} type="button" className="disc-card" onClick={() => navigate(`/story/${s.id}`)}>
                  <div className="disc-card-top">
                    <div className="disc-card-avatar story" aria-hidden>📖</div>
                    <div className="disc-card-head">
                      <div className="disc-card-name">{s.name}</div>
                      <div className="disc-card-tag">{s.tagline || ' '}</div>
                    </div>
                  </div>
                  <div className="disc-card-meta">
                    <span>{s.character_count ? `캐릭터 ${s.character_count}명` : '캐릭터 없음'}</span>
                    <span className="disc-card-cta">시작 →</span>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {hasQuery && showMessages && messageHits.length > 0 && (
          <section className="search-section">
            <div className="section-title">메시지</div>
            <div className="list">
              {messageHits.map((h) => (
                <div key={h.messageId} className="list-item" onClick={() => open(h)}>
                  <Avatar name={h.characterName} size="sm" />
                  <div className="body" style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                      <span className="t" style={{ fontSize: 13 }}>
                        {h.bookmarked ? '🔖 ' : ''}
                        {h.characterName}{h.conversationTitle ? ` · ${h.conversationTitle}` : ''}
                      </span>
                      <span className="p" style={{ marginLeft: 'auto', flexShrink: 0 }}>{relTime(h.createdAt)}</span>
                    </div>
                    <div className="search-snippet"><Highlight snippet={h.snippet} /></div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
