import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { get, post } from '../lib/api';
import { navigate, useLocation } from '../lib/router';
import type { Character, Health, Story } from '../types';
import { Avatar, relTime } from '../components/view';
import { CharacterEditor } from '../components/CharacterEditor';
import { StoryEditor } from '../components/StoryEditor';
import { Spinner, useUi } from '../components/ui';
import { TopNav } from '../components/TopNav';

type HomeTab = 'story' | 'character';
type CharFilter = 'all' | 'recent' | string;

function tabFromSearch(search: string): HomeTab {
  const t = new URLSearchParams(search).get('tab');
  return t === 'story' ? 'story' : 'character';
}

export function HomePage() {
  const ui = useUi();
  const loc = useLocation();
  const [tab, setTab] = useState<HomeTab>(() => tabFromSearch(loc.search));
  const [chars, setChars] = useState<Character[] | null>(null);
  const [stories, setStories] = useState<Story[] | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [charFilter, setCharFilter] = useState<CharFilter>('all');
  const [editor, setEditor] = useState<{ open: boolean; character: Character | null }>({ open: false, character: null });
  const [storyEditor, setStoryEditor] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    setTab(tabFromSearch(loc.search));
  }, [loc.search]);

  async function load() {
    try {
      setChars(await get<Character[]>('/api/characters'));
    } catch (e) {
      ui.toast((e as Error).message, 'err');
      setChars([]);
    }
  }

  async function loadStories() {
    try {
      setStories(await get<Story[]>('/api/stories'));
    } catch (e) {
      ui.toast((e as Error).message, 'err');
      setStories([]);
    }
  }

  useEffect(() => {
    load();
    get<Health>('/api/health').then(setHealth).catch(() => {});
  }, []);

  useEffect(() => {
    if (tab === 'story' && stories === null) void loadStories();
  }, [tab]);

  const tagChips = useMemo(() => {
    if (!chars?.length) return [] as string[];
    const counts = new Map<string, number>();
    for (const c of chars) {
      for (const t of c.tags ?? []) {
        const key = t.trim();
        if (!key) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'))
      .slice(0, 12)
      .map(([t]) => t);
  }, [chars]);

  const filteredChars = useMemo(() => {
    if (!chars) return null;
    let list = [...chars];
    if (charFilter === 'recent') {
      list = list
        .filter((c) => c.conversation_count || c.last_chat_at)
        .sort((a, b) => String(b.last_chat_at ?? '').localeCompare(String(a.last_chat_at ?? '')));
    } else if (charFilter !== 'all') {
      list = list.filter((c) => (c.tags ?? []).includes(charFilter));
    }
    return list;
  }, [chars, charFilter]);

  async function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // 같은 파일 재선택 허용
    if (!file) return;
    setImporting(true);
    try {
      const isPng = file.type === 'image/png' || file.name.toLowerCase().endsWith('.png');
      let body: { pngBase64?: string; json?: unknown };
      if (isPng) {
        body = { pngBase64: await fileToBase64(file) };
      } else {
        const text = await file.text();
        body = { json: JSON.parse(text) };
      }
      const r = await post<{ character: Character; warnings: string[]; imported: { loreCount: number; specVersion: string } }>('/api/characters/import', body);
      await load();
      if (r.warnings.length) ui.toast(`가져옴 · 참고 ${r.warnings.length}건 (로어 ${r.imported.loreCount})`, 'warn');
      else ui.toast(`'${r.character.name}' 가져옴 (로어 ${r.imported.loreCount})`);
      navigate(`/character/${r.character.id}`);
    } catch (err) {
      const msg = err instanceof SyntaxError ? 'JSON 파싱 실패 — 올바른 카드 파일인지 확인' : (err as Error).message;
      ui.toast(msg, 'err');
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="screen">
      <TopNav
        actions={
          <>
            {tab === 'character' && (
              <>
                <button className="btn ghost icon" onClick={() => fileRef.current?.click()} disabled={importing} aria-label="카드 가져오기">{importing ? '…' : '📥'}</button>
                <button className="btn primary icon" onClick={() => setEditor({ open: true, character: null })} aria-label="새 캐릭터">＋</button>
              </>
            )}
            {tab === 'story' && (
              <button className="btn primary icon" onClick={() => setStoryEditor(true)} aria-label="새 스토리">＋</button>
            )}
          </>
        }
      />
      <div className="home-tabs">
        <button type="button" className={tab === 'story' ? 'active' : ''} onClick={() => { setTab('story'); navigate('/?tab=story', { replace: true }); }}>스토리</button>
        <button type="button" className={tab === 'character' ? 'active' : ''} onClick={() => { setTab('character'); navigate('/?tab=character', { replace: true }); }}>캐릭터</button>
        <span className="home-tabs-meta">{modelLine(health)}</span>
      </div>
      <input ref={fileRef} type="file" accept="image/png,.png,.json,application/json" onChange={onPickFile} style={{ display: 'none' }} />
      <div className="content">
        {health && !health.model.ok && (
          <div className="banner warn">모델 서버에 연결되지 않았습니다. 대화 전송이 비활성화됩니다. (설정에서 상태 확인)</div>
        )}
        {tab === 'story' ? (
          stories === null ? (
            <Spinner />
          ) : stories.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-ico" aria-hidden>📖</div>
              <div className="empty-state-title">첫 스토리를 만드세요</div>
              <p className="empty-state-sub">파티·장면을 묶어 대화를 시작할 수 있어요</p>
              <button className="btn primary" onClick={() => setStoryEditor(true)}>새 스토리 만들기</button>
            </div>
          ) : (
            <div className="disc-grid">
              {stories.map((s) => (
                <button key={s.id} type="button" className="disc-card" onClick={() => navigate(`/story/${s.id}`)}>
                  <div className="disc-card-top">
                    <div className="disc-card-avatar story" aria-hidden>📖</div>
                    <div className="disc-card-head">
                      <div className="disc-card-name">{s.name}</div>
                      <div className="disc-card-tag">{s.tagline || ' '}</div>
                    </div>
                  </div>
                  {s.setting ? <p className="disc-card-desc">{s.setting}</p> : null}
                  <div className="disc-card-meta">
                    <span>{s.character_count ? `캐릭터 ${s.character_count}명` : '캐릭터 없음'}</span>
                    <span className="disc-card-cta">시작 →</span>
                  </div>
                </button>
              ))}
            </div>
          )
        ) : chars === null ? (
          <Spinner />
        ) : chars.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-ico" aria-hidden>🎭</div>
            <div className="empty-state-title">첫 캐릭터를 만들어 대화를 시작하세요.</div>
            <p className="empty-state-sub">카드를 가져오거나 새로 만들 수 있어요</p>
            <button className="btn primary" onClick={() => setEditor({ open: true, character: null })}>새 캐릭터 만들기</button>
          </div>
        ) : (
          <>
            <div className="filter-chips" role="toolbar" aria-label="캐릭터 필터">
              <button type="button" className={`filter-chip${charFilter === 'all' ? ' is-active' : ''}`} onClick={() => setCharFilter('all')}>전체</button>
              <button type="button" className={`filter-chip${charFilter === 'recent' ? ' is-active' : ''}`} onClick={() => setCharFilter('recent')}>최근 대화</button>
              {tagChips.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`filter-chip${charFilter === t ? ' is-active' : ''}`}
                  onClick={() => setCharFilter(t)}
                >#{t}</button>
              ))}
            </div>
            {filteredChars && filteredChars.length === 0 ? (
              <div className="empty-state compact">
                <div className="empty-state-title">필터에 맞는 캐릭터가 없어요</div>
                <button type="button" className="btn ghost sm" onClick={() => setCharFilter('all')}>전체 보기</button>
              </div>
            ) : (
              <div className="disc-grid">
                {(filteredChars ?? []).map((c) => (
                  <button key={c.id} type="button" className="disc-card" onClick={() => navigate(`/character/${c.id}`)}>
                    <div className="disc-card-top">
                      <Avatar name={c.name} avatar={c.avatar} size="sm" />
                      <div className="disc-card-head">
                        <div className="disc-card-name">{c.name}</div>
                        <div className="disc-card-tag">{c.tagline || ' '}</div>
                      </div>
                    </div>
                    {c.description ? <p className="disc-card-desc">{c.description}</p> : null}
                    {(c.tags?.length ?? 0) > 0 && (
                      <div className="disc-card-tags">
                        {c.tags.slice(0, 4).map((t) => <span key={t} className="tag">#{t}</span>)}
                      </div>
                    )}
                    <div className="disc-card-meta">
                      <span>{c.conversation_count ? `대화 ${c.conversation_count}개 · ${relTime(c.last_chat_at)}` : '새 캐릭터'}</span>
                      <span className="disc-card-cta">대화하기</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <CharacterEditor
        open={editor.open}
        character={editor.character}
        onClose={() => setEditor({ open: false, character: null })}
        onSaved={(c) => { setEditor({ open: false, character: null }); load(); navigate(`/character/${c.id}`); }}
      />
      <StoryEditor
        open={storyEditor}
        story={null}
        onClose={() => setStoryEditor(false)}
        onSaved={(s) => { setStoryEditor(false); void loadStories(); navigate(`/story/${s.id}`); }}
      />
    </div>
  );
}

function modelLine(h: Health | null): string {
  if (!h) return '연결 확인 중…';
  if (!h.model.ok) return '모델 오프라인';
  return `${h.model.resolvedModel || '모델'} · ${Math.round(h.model.contextTokens / 1000)}K`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error('파일 읽기 실패'));
    r.readAsDataURL(file);
  });
}
