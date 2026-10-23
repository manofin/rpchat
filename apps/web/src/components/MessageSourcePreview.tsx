import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { Message } from '../types';
import { MessageEvents } from './EventRenderer';
import { BottomSheet } from './ui';
import { renderContent } from './view';

export function MessageSourcePreview({ conversationId, messageId, onClose }: { conversationId: string; messageId: string | null; onClose: () => void }) {
  const key = JSON.stringify([conversationId, messageId]);
  const [snapshot, setSnapshot] = useState<{ key: string; message?: Message; error?: string } | null>(null);
  useEffect(() => {
    if (!messageId) return;
    const controller = new AbortController();
    let active = true;
    setSnapshot(null);
    api<Message>(`/api/messages/${encodeURIComponent(messageId)}`, { signal: controller.signal }).then((message) => {
      if (!active) return;
      if (message.conversation_id !== conversationId) throw new Error('이 대화에 속한 원문이 아닙니다.');
      setSnapshot({ key, message });
    }).catch((error: unknown) => {
      if (active) setSnapshot({ key, error: error instanceof Error ? error.message : '원문을 불러오지 못했습니다.' });
    });
    return () => { active = false; controller.abort(); };
  }, [conversationId, messageId, key]);
  const current = snapshot?.key === key ? snapshot : null;
  return <BottomSheet open={!!messageId} onClose={onClose}>
    <div className="sheet-body" aria-label="원문 미리보기">
      <strong>원문 미리보기</strong>
      <div className="small muted" style={{ margin: '8px 0 12px' }}>현재 대화 화면에 없는 메시지입니다. 읽기 전용으로 표시하며 선택한 분기는 유지합니다.</div>
      {current?.error ? <div className="banner err" role="alert">{current.error}</div> : !current?.message ? <div role="status">원문을 불러오는 중…</div> : <>
        <div className="small muted" style={{ marginBottom: 8 }}>{current.message.role === 'user' ? '사용자' : (current.message.meta.speaker_name || '응답')} · {new Date(current.message.created_at).toLocaleString('ko-KR')}</div>
        <div style={{ overflowWrap: 'anywhere' }}>{current.message.role === 'user' ? renderContent(current.message.content) : <MessageEvents message={current.message} streaming={false} />}</div>
      </>}
      <button className="btn block" style={{ marginTop: 12 }} onClick={onClose}>원문 닫기</button>
    </div>
  </BottomSheet>;
}
