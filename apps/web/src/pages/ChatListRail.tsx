import { useEffect, useState } from 'react';
import { get } from '../lib/api';
import { navigate } from '../lib/router';
import type { Conversation } from '../types';
import { relTime } from '../components/view';
import { Spinner } from '../components/ui';

export function ChatListRail({
  characterId,
  activeId,
  onPick,
}: {
  characterId: string;
  activeId: string;
  onPick?: () => void;
}) {
  const [rows, setRows] = useState<Conversation[] | null>(null);

  useEffect(() => {
    let live = true;
    get<Conversation[]>(`/api/conversations?characterId=${characterId}`)
      .then((list) => {
        if (live) setRows(list);
      })
      .catch(() => {
        if (live) setRows([]);
      });
    return () => {
      live = false;
    };
  }, [characterId, activeId]);

  if (!rows) return <Spinner />;
  if (rows.length === 0) {
    return <div className="muted small" style={{ padding: 12 }}>대화가 없습니다.</div>;
  }

  return (
    <div className="chat-list">
      {rows.map((c) => (
        <button
          key={c.id}
          type="button"
          className={`chat-list-item${c.id === activeId ? ' active' : ''}`}
          onClick={() => {
            if (c.id !== activeId) navigate(`/chat/${c.id}`);
            onPick?.();
          }}
        >
          <span className="t">{c.title || '대화'}</span>
          <span className="p">{relTime(c.last_message_at) || c.preview || ''}</span>
        </button>
      ))}
    </div>
  );
}
