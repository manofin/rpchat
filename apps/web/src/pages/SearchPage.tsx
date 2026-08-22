import { useEffect, useRef, useState } from 'react';
import { get } from '../lib/api';
import { navigate } from '../lib/router';
import { Avatar, relTime } from '../components/view';
import { Spinner, useUi } from '../components/ui';

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

/** «…» 하이라이트를 <mark> 로 변환 (이스케이프 후) */
function Highlight({ snippet }: { snippet: string }) {
  const parts = snippet.split(/«|»/);
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>))}
    </>
  );
}

export function SearchPage() {
  const ui = useUi();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(timer.current);
    const query = q.trim();
    if ([...query].length < 1) {
      setHits(null);
      return;
    }
    setBusy(true);
    timer.current = window.setTimeout(async () => {
      try {
        const r = await get<{ results: SearchHit[] }>(`/api/search?q=${encodeURIComponent(query)}&limit=30`);
        setHits(r.results);
      } catch (e) {
        ui.toast((e as Error).message, 'err');
      } finally {
        setBusy(false);
      }
    }, 300);
    return () => window.clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  async function open(hit: SearchHit) {
    try {
      // 활성 분기에 매치 메시지가 있는지 확인
      const d = await get<{ messages: { id: string }[] }>(`/api/conversations/${hit.conversationId}`);
      const onHead = d.messages.some((m) => m.id === hit.messageId);
      navigate(`/chat/${hit.conversationId}?jump=${hit.messageId}`);
      if (!onHead) ui.toast('이 메시지는 다른 분기에 있습니다 — 스와이프로 분기를 옮기면 볼 수 있어요', 'warn');
    } catch (e) {
      ui.toast((e as Error).message, 'err');
    }
  }

  return (
    <div className="screen">
      <div className="topbar">
        <button className="btn ghost icon" onClick={() => history.length > 1 ? history.back() : navigate('/')}>‹</button>
        <div className="title"><h1>검색</h1><div className="sub">모든 대화의 메시지</div></div>
      </div>
      <div style={{ padding: '10px 12px 0' }}>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="검색어를 입력하세요"
          style={{ width: '100%', minHeight: 42, background: 'var(--bg-2)', border: '1px solid var(--bg-3)', borderRadius: 12, padding: '10px 14px' }}
        />
      </div>
      <div className="content">
        {busy && hits === null && <Spinner />}
        {hits !== null && hits.length === 0 && !busy && <div className="sysline" style={{ marginTop: 24 }}>결과 없음</div>}
        <div className="list">
          {(hits ?? []).map((h) => (
            <div key={h.messageId} className="list-item" onClick={() => open(h)}>
              <Avatar name={h.characterName} size="sm" />
              <div className="body" style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                  <span className="t" style={{ fontSize: 13 }}>{h.characterName}{h.conversationTitle ? ` · ${h.conversationTitle}` : ''}</span>
                  <span className="p" style={{ marginLeft: 'auto', flexShrink: 0 }}>{relTime(h.createdAt)}</span>
                </div>
                <div className="search-snippet"><Highlight snippet={h.snippet} /></div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
