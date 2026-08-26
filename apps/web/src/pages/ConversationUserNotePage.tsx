import React, { useEffect, useState } from 'react';
import { ApiError, get, patch } from '../lib/api';
import { back } from '../lib/router';
import type { Conversation, ConversationDetail } from '../types';
import { SettingsPageHeader, SettingsPageLayout } from '../components/settings';
import { Spinner } from '../components/ui';

export const USER_NOTE_MAX_CHARS = 4000;

export function loadedUserNote(conversation: { user_note?: string | null }): string {
  return conversation.user_note ?? '';
}

export function formatUserNoteCount(length: number): string {
  return `${length} / ${USER_NOTE_MAX_CHARS}`;
}

export function buildUserNotePatch(draft: string): { userNote: string } | null {
  if (draft.length === 0) return null;
  if (draft.length > USER_NOTE_MAX_CHARS) return null;
  return { userNote: draft };
}

export function userNoteSaveDisabled(draft: string, pending: boolean): boolean {
  return pending || buildUserNotePatch(draft) === null;
}

export function UserNoteView({
  conversationId,
  draft,
  pending,
  conversationError,
  statusMessage,
  onBack,
  onDraftChange,
  onSave,
  onRetry,
}: {
  conversationId: string;
  draft: string;
  pending: boolean;
  conversationError: boolean;
  statusMessage: string | null;
  onBack: () => void;
  onDraftChange: (next: string) => void;
  onSave: () => void;
  onRetry: () => void;
}) {
  const disabled = userNoteSaveDisabled(draft, pending);
  return (
    <SettingsPageLayout header={<SettingsPageHeader title="유저노트" onBack={onBack} />}>
      {conversationError ? (
        <>
          <p role="alert">대화를 불러오지 못했습니다.</p>
          <button type="button" className="btn" onClick={onRetry}>
            다시 시도
          </button>
        </>
      ) : (
        <section className="card settings-section-body" style={{ padding: 16 }}>
          <label className="sub" htmlFor="user-note-draft">
            이 대화에만 적용되는 메모
          </label>
          <textarea
            id="user-note-draft"
            className="input"
            value={draft}
            disabled={pending}
            onChange={(e) => onDraftChange(e.target.value)}
            rows={10}
          />
          <p className="sub">{formatUserNoteCount(draft.length)}</p>
          <button type="button" className="btn" disabled={disabled} onClick={onSave}>
            저장
          </button>
        </section>
      )}
      {statusMessage ? (
        <p role="status" aria-live="polite">
          {statusMessage}
        </p>
      ) : null}
      <span hidden>{conversationId}</span>
    </SettingsPageLayout>
  );
}

export function ConversationUserNotePage({ conversationId }: { conversationId: string }) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState('');
  const [conversationError, setConversationError] = useState(false);
  const [pending, setPending] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [loadTick, setLoadTick] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    setConversationError(false);
    setConversation(null);
    setStatusMessage(null);
    get<ConversationDetail>(`/api/conversations/${conversationId}`)
      .then((detail) => {
        if (ac.signal.aborted) return;
        setConversation(detail.conversation);
        setDraft(loadedUserNote(detail.conversation));
      })
      .catch(() => {
        if (!ac.signal.aborted) setConversationError(true);
      });
    return () => ac.abort();
  }, [conversationId, loadTick]);

  const onBack = () => back(`/chat/${conversationId}/settings`);

  const save = async () => {
    const body = buildUserNotePatch(draft);
    if (!body || pending || !conversation) return;
    setPending(true);
    setStatusMessage(null);
    let patched = false;
    try {
      await patch(`/api/conversations/${conversationId}`, body);
      patched = true;
      const detail = await get<ConversationDetail>(`/api/conversations/${conversationId}`);
      setConversation(detail.conversation);
      setDraft(loadedUserNote(detail.conversation));
    } catch (err) {
      if (!patched) {
        setStatusMessage(
          err instanceof ApiError && err.status === 400
            ? '요청을 저장할 수 없습니다.'
            : '연결에 실패했습니다. 다시 시도해 주세요.',
        );
      } else {
        setStatusMessage('저장 결과를 다시 확인할 수 없습니다');
      }
    } finally {
      setPending(false);
    }
  };

  if (!conversation && !conversationError) {
    return (
      <SettingsPageLayout header={<SettingsPageHeader title="유저노트" onBack={onBack} />}>
        <Spinner />
      </SettingsPageLayout>
    );
  }

  return (
    <UserNoteView
      conversationId={conversationId}
      draft={draft}
      pending={pending}
      conversationError={conversationError}
      statusMessage={statusMessage}
      onBack={onBack}
      onDraftChange={setDraft}
      onSave={() => {
        void save();
      }}
      onRetry={() => setLoadTick((n) => n + 1)}
    />
  );
}
