import type { Conversation } from '../types';

export function ConversationRecency({ conversation }: {
  conversation: Pick<Conversation, 'preview' | 'last_message_at' | 'created_at'>;
}) {
  const preview = conversation.preview?.trim();
  const timestamp = conversation.last_message_at || conversation.created_at;
  const date = timestamp ? new Date(timestamp) : null;
  const validDate = date && Number.isFinite(date.getTime());
  return <span className="conversation-recency">
    <span className="p conversation-scene">{preview ? `최근 장면 · ${preview.replace(/\s+/g, ' ')}` : conversation.last_message_at ? '표시할 최근 장면 없음' : '아직 대화 없음'}</span>
    <span className="p muted conversation-played">
      {conversation.last_message_at ? '마지막 플레이' : '만든 날짜'} · {validDate
        ? <time dateTime={timestamp!}>{date.toLocaleString('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
        : '기록 없음'}
    </span>
  </span>;
}
