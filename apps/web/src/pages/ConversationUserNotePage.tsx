import React, { useEffect, useRef, useState } from 'react';
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

export type UserNoteSaveLock = {
  tryBegin(): number | null;
  end(ticket: number): void;
  isBusy(): boolean;
  shouldCommit(ticket: number): boolean;
  abort(): void;
  beginLifecycle(): number;
  endLifecycle(generation: number): void;
  shouldApply(generation: number): boolean;
};

export function createUserNoteSaveLock(): UserNoteSaveLock {
  let busy = false;
  let seq = 0;
  let active = 0;
  let generation = 0;
  let liveGeneration = 1;
  return {
    tryBegin() {
      if (busy) return null;
      busy = true;
      seq += 1;
      active = seq;
      return seq;
    },
    end(ticket: number) {
      if (ticket === active) busy = false;
    },
    isBusy() {
      return busy;
    },
    shouldCommit(ticket: number) {
      return liveGeneration !== 0 && ticket === active;
    },
    abort() {
      liveGeneration = 0;
    },
    beginLifecycle() {
      generation += 1;
      liveGeneration = generation;
      return generation;
    },
    endLifecycle(g: number) {
      if (liveGeneration === g) liveGeneration = 0;
    },
    shouldApply(g: number) {
      return liveGeneration === g;
    },
  };
}

export type UserNoteSaveResult = 'sent' | 'blocked' | 'omitted';

export async function runUserNoteSave(args: {
  lock: UserNoteSaveLock;
  draft: string;
  conversationId: string;
  patch: (url: string, body: { userNote: string }) => Promise<unknown>;
  get: (url: string) => Promise<{ conversation: { user_note?: string | null } }>;
  onSuccess: (loaded: string) => void;
  onFailure: (kind: 'patch' | 'reload', draftKept: string, err?: unknown) => void;
  onBusyChange?: (busy: boolean) => void;
}): Promise<UserNoteSaveResult> {
  const body = buildUserNotePatch(args.draft);
  if (!body) return 'omitted';
  const ticket = args.lock.tryBegin();
  if (ticket == null) return 'blocked';
  args.onBusyChange?.(true);
  const kept = args.draft;
  let patched = false;
  try {
    await args.patch(`/api/conversations/${args.conversationId}`, body);
    patched = true;
    const detail = await args.get(`/api/conversations/${args.conversationId}`);
    if (args.lock.shouldCommit(ticket)) {
      args.onSuccess(loadedUserNote(detail.conversation));
    }
    return 'sent';
  } catch (err) {
    if (args.lock.shouldCommit(ticket)) {
      args.onFailure(patched ? 'reload' : 'patch', kept, err);
    }
    return 'sent';
  } finally {
    args.lock.end(ticket);
    args.onBusyChange?.(args.lock.isBusy());
  }
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
          <button type="button" className="btn" disabled={disabled} aria-busy={pending} onClick={onSave}>
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

export function ConversationUserNotePage({ conversationId, onBack }: { conversationId: string; onBack?: () => void }) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState('');
  const [conversationError, setConversationError] = useState(false);
  const [pending, setPending] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [loadTick, setLoadTick] = useState(0);
  const saveLockRef = useRef(createUserNoteSaveLock());

  useEffect(() => {
    const ac = new AbortController();
    const lock = saveLockRef.current;
    const gen = lock.beginLifecycle();
    setConversationError(false);
    setConversation(null);
    setStatusMessage(null);
    get<ConversationDetail>(`/api/conversations/${conversationId}`)
      .then((detail) => {
        if (ac.signal.aborted) return;
        if (!lock.shouldApply(gen)) return;
        setConversation(detail.conversation);
        setDraft(loadedUserNote(detail.conversation));
      })
      .catch(() => {
        if (ac.signal.aborted) return;
        if (!lock.shouldApply(gen)) return;
        setConversationError(true);
      });
    return () => {
      ac.abort();
      lock.endLifecycle(gen);
    };
  }, [conversationId, loadTick]);

  const goBack = onBack ?? (() => back(`/chat/${conversationId}/settings`));

  const save = async () => {
    if (!conversation) return;
    setStatusMessage(null);
    await runUserNoteSave({
      lock: saveLockRef.current,
      draft,
      conversationId,
      patch,
      get,
      onBusyChange: setPending,
      onSuccess: (loaded) => {
        setDraft(loaded);
        setConversation((prev) => (prev ? { ...prev, user_note: loaded } : prev));
      },
      onFailure: (kind, _draftKept, err) => {
        if (kind === 'patch') {
          setStatusMessage(
            err instanceof ApiError && err.status === 400
              ? '요청을 저장할 수 없습니다.'
              : '연결에 실패했습니다. 다시 시도해 주세요.',
          );
        } else {
          setStatusMessage('저장 결과를 다시 확인할 수 없습니다');
        }
      },
    });
  };

  if (!conversation && !conversationError) {
    return (
      <SettingsPageLayout header={<SettingsPageHeader title="유저노트" onBack={goBack} />}>
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
      onBack={goBack}
      onDraftChange={setDraft}
      onSave={() => {
        void save();
      }}
      onRetry={() => setLoadTick((n) => n + 1)}
    />
  );
}
