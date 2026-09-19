import { useEffect, useState } from 'react';
import { get } from '../lib/api';
import { navigate } from '../lib/router';
import type { Conversation } from '../types';
import { TopNav } from '../components/TopNav';
import { Spinner, useUi } from '../components/ui';
import { relTime } from '../components/view';
import { conversationTitleLabel } from '../lib/conversationTitleLabel';

/** Global rooms list — resume any conversation without remembering the character path. */
export function ChatsPage() {
  const ui = useUi();
  const [rows, setRows] = useState<Conversation[] | null>(null);

  async function load() {
    try {
      setRows(await get<Conversation[]>('/api/conversations'));
    } catch (e) {
      ui.toast((e as Error).message, 'err');
      setRows([]);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="screen">
      <TopNav />
      <div className="content chats-page-scroll">
        <div className="section-title" style={{ marginTop: 4 }}>채팅</div>
        {rows === null ? (
          <Spinner label="불러오는 중…" />
        ) : rows.length === 0 ? (
          <div className="muted small">아직 대화가 없습니다. 홈에서 스토리·캐릭터로 시작해 보세요.</div>
        ) : (
          <div className="chats-list" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rows.map((c) => (
              <div
                key={c.id}
                className="list-item"
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/chat/${c.id}`)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    navigate(`/chat/${c.id}`);
                  }
                }}
              >
                <div className="body">
                  <div className="t">{c.favorite ? '★ ' : ''}{conversationTitleLabel(c)}</div>
                  <div className="p">
                    {[c.character_name, c.story_name_snapshot || null].filter(Boolean).join(' · ')}
                  </div>
                  <div className="p muted">
                    {relTime(c.last_message_at || c.created_at)}
                    {c.preview ? ` · ${c.preview}` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
