import { useEffect, useRef, useState } from 'react';
import type { QuestStage } from '@rpchat/contracts/adventure';
import type { ConversationDetail, PromptPreview } from '../types';
import { get } from '../lib/api';
import { navigate } from '../lib/router';
import { RESPONSE_LENGTHS } from '../lib/responseControls';
import { sceneDisplay } from '../lib/sceneDisplay';
import { useMemoryResource } from '../lib/useMemoryResource';

const questStages: Record<QuestStage, string> = {
  offered: '제안', considering: '고려 중', accepted: '수락', in_progress: '진행 중',
  completed: '완료', settled: '정산 완료', declined: '거절',
};

export function memoryContextVersion(detail: ConversationDetail): string {
  const c = detail.conversation;
  return JSON.stringify([c.id, c.head_message_id, c.scene, c.profile_name, c.persona_id,
    c.persona_applied_at, c.persona_name_snapshot, c.updated_at]);
}

export function memoryMessageHref(conversationId: string, messageId: string): string {
  return `/chat/${encodeURIComponent(conversationId)}?jump=${encodeURIComponent(messageId)}`;
}

export function ConversationMemoryContextView({ detail, preview, previewLoading, previewError, onPreview, onOpenMessage, onOpenContext }: {
  detail: ConversationDetail;
  preview?: PromptPreview | null;
  previewLoading?: boolean;
  previewError?: string | null;
  onPreview?: () => void;
  onOpenMessage?: (messageId: string) => void;
  onOpenContext?: () => void;
}) {
  const c = detail.conversation;
  const scene = c.scene;
  const adventure = scene.adventure;
  const display = sceneDisplay(scene, detail.scene_places);
  const time = scene.time?.trim() || (typeof scene.clock_minutes === 'number' && Number.isFinite(scene.clock_minutes) && scene.clock_minutes >= 0
    ? `${String(Math.floor(scene.clock_minutes / 60) % 24).padStart(2, '0')}:${String(Math.floor(scene.clock_minutes % 60)).padStart(2, '0')}` : '');
  const day = typeof scene.day_index === 'number' ? `${scene.day_index}일차` : '';
  const receipts = detail.messages.filter(message => message.role === 'assistant' && message.status === 'complete' && message.meta.adventure_receipt);
  const persona = c.persona_applied_at ? c.persona_name_snapshot : detail.persona?.name;
  const responseLength = RESPONSE_LENGTHS.find(option => option.value === (scene.response_length ?? 'normal'))?.label ?? '확인 필요';
  const settings = `/chat/${encodeURIComponent(c.id)}/settings`;
  const openSource = (messageId: string) => onOpenMessage ? onOpenMessage(messageId) : navigate(memoryMessageHref(c.id, messageId));
  return <section aria-label="현재 분기의 기억과 상태" data-test="memory-context" data-head-message-id={c.head_message_id ?? ''} className="card" style={{ padding: 16, marginBottom: 16, overflowWrap: 'anywhere' }}>
    <h2 className="section-title">현재 분기의 상태</h2>
    <p className="small" data-test="memory-scene">장소: {display.place || '미기록'} · 시간: {[day, time].filter(Boolean).join(' ') || '미기록'}</p>
    <p className="small muted">장소·시간은 저장된 장면 정보입니다. 아래의 사용자 확인 기록과는 구분합니다.</p>
    <h3 className="small">확인된 모험 상태</h3>
    {adventure ? <div data-test="memory-confirmed-state">
      <p><strong>소지금 {adventure.balance.toLocaleString()} {adventure.currency}</strong> · {adventure.registration ? `${adventure.registration.organization} 등록 완료` : '미등록'}</p>
      <p className="small">경지 {adventure.rank || '미정'} · 경험치 {adventure.experience} · 능력 {adventure.skills.join(', ') || '기록 없음'}</p>
      <details>
        <summary>물품 {adventure.items.length}종 · 의뢰 {adventure.quests.length}건</summary>
        <h4 className="small">소지품·대여품</h4>
        {adventure.items.length ? <ul>{adventure.items.map(item => <li key={item.id}>{item.name} × {item.quantity} · {item.ownership === 'loan' ? '대여' : '소유'} · 소유자 {item.owner}</li>)}</ul> : <p className="small muted">확인된 물품 없음</p>}
        <h4 className="small">의뢰</h4>
        {adventure.quests.length ? <ul>{adventure.quests.map(quest => <li key={quest.id}>{quest.title} · {questStages[quest.stage]} · 제안 보수 {quest.reward == null ? '미정' : `${quest.reward} ${adventure.currency}`}</li>)}</ul> : <p className="small muted">확인된 의뢰 없음</p>}
      </details>
      <p className="small muted">사용자가 확인한 공개 상태입니다. 자유문 요약의 승인만으로 금액·물품·의뢰가 바뀌지 않습니다.</p>
      {receipts.length ? <details data-test="memory-confirmation-sources">
        <summary>현재 분기의 확인 기록 {receipts.length}건</summary>
        <ul>{receipts.map((message, index) => <li key={message.id}>
          <button type="button" className="btn sm ghost" onClick={() => openSource(message.id)}>확인 기록 {index + 1} 원문</button>
          <span className="small">{message.content.split('\n')[1] || '사용자 확인 기록'}</span>
        </li>)}</ul>
      </details> : <p className="small muted">이 대화 경로에서 연결할 확인 기록을 찾지 못했습니다.</p>}
    </div> : <p className="small muted" data-test="memory-confirmed-empty">이 분기에는 확인된 모험 상태가 없습니다. 요약이나 장면의 수치를 확인된 잔고·물품으로 표시하지 않습니다.</p>}
    <button type="button" className="btn sm" onClick={() => navigate(`${settings}/state`)}>장면·확인 상태 열기</button>
    <details style={{ marginTop: 12 }}>
      <summary>이 대화의 적용 설정</summary>
      <p className="small">대화 프로필: {persona || '적용 정보 없음'}{c.persona_applied_at ? ' · 적용 당시 정보' : ''}</p>
      <p className="small">출력/톤 프로필: {c.profile_name} · 응답 길이: {responseLength}</p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn sm ghost" onClick={() => navigate(`${settings}/profile`)}>적용 프로필 보기</button>
        <button type="button" className="btn sm ghost" onClick={() => navigate(`${settings}/output`)}>응답 길이·출력 설정</button>
        <button type="button" className="btn sm ghost" disabled={previewLoading} onClick={onPreview}>{previewLoading ? '확인 중…' : '모델·맥락 예상 확인'}</button>
        {onOpenContext && <button type="button" className="btn sm ghost" onClick={onOpenContext}>맥락 상세 보기</button>}
      </div>
      {previewError && <p role="alert" className="small">{previewError}</p>}
      {preview && <div data-test="memory-applied-preview">
        <p className="small">미리보기 모델: {preview.model || '확인하지 못함'} · 맥락 예상 {preview.budget.est_total.toLocaleString()} / {preview.budget.available.toLocaleString()} 토큰</p>
        <p className="small muted">전체 한도 {preview.budget.context_tokens.toLocaleString()} 토큰 · 응답 예약 {preview.budget.reply_reserve.toLocaleString()} 토큰. 입력 전 예상치이며, 입력·장면·생성 방식에 따라 달라질 수 있습니다.</p>
      </div>}
    </details>
  </section>;
}

export function ConversationMemoryContext({ conversationId, headMessageId, onLoaded, onReadyChange, onOpenMessage, onOpenContext }: {
  conversationId: string;
  headMessageId?: string | null;
  onLoaded?: (detail: ConversationDetail) => void;
  onReadyChange?: (ready: boolean) => void;
  onOpenMessage?: (messageId: string) => void;
  onOpenContext?: () => void;
}) {
  const url = `/api/conversations/${encodeURIComponent(conversationId)}`;
  const { data, loading, error, refresh } = useMemoryResource<ConversationDetail>(url, headMessageId);
  const branchChanged = Boolean(data && headMessageId !== undefined && data.conversation.head_message_id !== headMessageId);
  useEffect(() => {
    onReadyChange?.(Boolean(data && !loading && !error && !branchChanged));
    return () => { onReadyChange?.(false); };
  }, [data, loading, error, branchChanged, onReadyChange]);
  const [preview, setPreview] = useState<PromptPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewRequest = useRef(0);
  const detailRef = useRef(data);
  detailRef.current = data;
  useEffect(() => {
    previewRequest.current++;
    setPreview(null); setPreviewLoading(false); setPreviewError(null);
    if (data && !loading && !branchChanged) onLoaded?.(data);
    return () => { previewRequest.current++; };
  }, [data, loading, onLoaded, branchChanged]);
  async function loadPreview() {
    if (!data || loading || previewLoading || branchChanged) return;
    const expected = memoryContextVersion(data);
    const sequence = ++previewRequest.current;
    setPreviewLoading(true); setPreviewError(null); setPreview(null);
    try {
      const next = await get<PromptPreview>(`${url}/prompt-preview`);
      const latest = await get<ConversationDetail>(url);
      if (sequence !== previewRequest.current || !detailRef.current || memoryContextVersion(detailRef.current) !== expected) return;
      if (memoryContextVersion(latest) !== expected) {
        void refresh();
        setPreviewError('대화 상태가 바뀌었습니다. 최신 상태에서 다시 확인해 주세요.');
        return;
      }
      setPreview(next);
    } catch (failure) {
      if (sequence === previewRequest.current) setPreviewError(failure instanceof Error ? failure.message : '모델과 맥락 정보를 확인하지 못했습니다.');
    } finally {
      if (sequence === previewRequest.current) setPreviewLoading(false);
    }
  }
  return <>
    {loading && <p role="status" className="small muted">현재 분기의 상태를 확인하는 중…</p>}
    {error && <p role="alert" className="banner err">{error} <button type="button" className="btn sm ghost" onClick={() => void refresh()}>다시 확인</button></p>}
    {branchChanged && <p role="alert" className="banner warn" data-test="memory-context-branch-changed">대화 분기가 바뀌었습니다. 대화로 돌아가 현재 분기를 확인해 주세요.
      <button type="button" className="btn sm ghost" onClick={() => navigate(`/chat/${encodeURIComponent(conversationId)}`)}>대화로 돌아가기</button>
    </p>}
    {data && !loading && !branchChanged && <ConversationMemoryContextView detail={data} preview={preview} previewLoading={previewLoading} previewError={previewError}
      onPreview={() => void loadPreview()} onOpenMessage={onOpenMessage} onOpenContext={onOpenContext} />}
  </>;
}
