import React, { useEffect, useState } from 'react';
import { ApiError, get, patch } from '../lib/api';
import { back } from '../lib/router';
import type { Conversation, ConversationDetail, Persona } from '../types';
import { SettingsPageLayout } from '../components/settings';
import { Spinner } from '../components/ui';

export type AppliedSnapshot = {
  id: string;
  name: string;
  addressAs: string | null;
  appearance: string | null;
  personality: string | null;
  relationship: string | null;
  appliedAt: string;
};

export type MutationOutcome =
  | { kind: 'ok'; conversation: Conversation }
  | { kind: 'http'; status: 400 | 404 | 500 }
  | { kind: 'network' }
  | { kind: 'refetch-fail' };

export function deriveAppliedSnapshot(conversation: Conversation): AppliedSnapshot | null {
  if (!conversation.persona_applied_at || !conversation.persona_id) return null;
  return {
    id: conversation.persona_id,
    name: conversation.persona_name_snapshot ?? '이름 없는 프로필',
    addressAs: conversation.persona_address_snapshot,
    appearance: conversation.persona_appearance_snapshot,
    personality: conversation.persona_personality_snapshot,
    relationship: conversation.persona_relationship_snapshot,
    appliedAt: conversation.persona_applied_at,
  };
}

export function profileActionFor(
  current: AppliedSnapshot | null,
  candidateId: string,
): 'apply' | 'reapply' {
  return current?.id === candidateId ? 'reapply' : 'apply';
}

export function buildPersonaPatch(candidateId: string): { personaId: string } | null {
  if (candidateId.trim().length === 0) return null;
  return { personaId: candidateId };
}

export function applyMutationOutcome(
  last: Conversation,
  outcome: MutationOutcome,
): { conversation: Conversation; message: string | null; refreshCatalog: boolean } {
  if (outcome.kind === 'ok') {
    return { conversation: outcome.conversation, message: null, refreshCatalog: false };
  }
  if (outcome.kind === 'http' && outcome.status === 400) {
    return { conversation: last, message: '요청을 적용할 수 없습니다.', refreshCatalog: false };
  }
  if (outcome.kind === 'http' && outcome.status === 404) {
    return { conversation: last, message: '프로필 목록이 갱신되었습니다', refreshCatalog: true };
  }
  if (outcome.kind === 'refetch-fail') {
    return { conversation: last, message: '적용 결과를 다시 확인할 수 없습니다', refreshCatalog: false };
  }
  return { conversation: last, message: '연결에 실패했습니다. 다시 시도해 주세요.', refreshCatalog: false };
}

export function personaActionsDisabled(pendingPersonaId: string | null): boolean {
  return pendingPersonaId !== null;
}

export function formatAppliedAt(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '적용 시각을 확인할 수 없음';
  try {
    return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
  } catch {
    return '적용 시각을 확인할 수 없음';
  }
}

function snapshotContractBroken(conversation: Conversation): boolean {
  return Boolean(conversation.persona_applied_at) && !conversation.persona_id;
}

function candidateSummary(persona: Persona): string | null {
  const bits = [persona.address_as, persona.appearance].map((s) => s.trim()).filter(Boolean);
  return bits.length ? bits.join(' · ') : null;
}

export function ProfileHeader({ onBack }: { onBack: () => void }) {
  return (
    <header className="settings-header">
      <button type="button" className="btn ghost icon" onClick={onBack} aria-label="대화방 설정으로 돌아가기">
        ‹
      </button>
      <div className="title">
        <h1 className="settings-title">대화 프로필</h1>
      </div>
    </header>
  );
}

export function ProfileEmptyState() {
  return (
    <section className="card settings-section-body" style={{ padding: 16 }}>
      <h2 className="settings-title">적용된 대화 프로필 없음</h2>
      <p className="sub">목록에서 프로필을 선택하면 이 대화에 복사됩니다.</p>
    </section>
  );
}

export function AppliedProfileCard({
  snapshot,
}: {
  snapshot: AppliedSnapshot;
  pending?: boolean;
  onReapply?: () => void;
}) {
  return (
    <section className="card profile-snapshot">
      <p className="settings-badge">현재 적용 중</p>
      <h2 className="settings-title">{snapshot.name}</h2>
      <p className="sub">이 대화에는 적용 당시의 프로필 정보가 고정됩니다.</p>
      {snapshot.addressAs ? <p className="sub">{snapshot.addressAs}</p> : null}
      {snapshot.appearance ? <p className="sub">{snapshot.appearance}</p> : null}
      {snapshot.personality ? <p className="sub">{snapshot.personality}</p> : null}
      {snapshot.relationship ? <p className="sub">{snapshot.relationship}</p> : null}
      <p className="sub">{formatAppliedAt(snapshot.appliedAt)}</p>
    </section>
  );
}

export function CandidateProfileList({
  candidates,
  currentId,
  pending,
  disabled,
  onApply,
  onReapply,
}: {
  candidates: Persona[];
  currentId: string | null;
  pending: boolean;
  disabled: boolean;
  onApply: (id: string) => void;
  onReapply: (id: string) => void;
}) {
  const lock = pending || disabled;
  return (
    <section className="settings-section">
      <h2 className="section-title">선택 가능한 프로필</h2>
      <div className="card settings-section-body">
        {candidates.map((persona) => {
          const action = profileActionFor(currentId ? { id: currentId } as AppliedSnapshot : null, persona.id);
          const summary =
            action === 'reapply'
              ? '현재 snapshot과 catalog의 최신 값은 다를 수 있습니다.'
              : candidateSummary(persona);
          return (
            <div
              key={persona.id}
              className={`profile-candidate-row${action === 'reapply' ? ' profile-candidate-current' : ''}`}
            >
              <div className="profile-candidate-copy">
                <div className="profile-candidate-heading">
                  <span className="profile-candidate-name">{persona.name}</span>
                  {action === 'reapply' ? <span className="settings-badge">현재</span> : null}
                </div>
                {summary ? <span className="profile-candidate-summary">{summary}</span> : null}
              </div>
              <button
                type="button"
                className="btn profile-candidate-action"
                disabled={lock}
                aria-describedby={lock ? 'profile-action-reason' : undefined}
                onClick={() => (action === 'reapply' ? onReapply(persona.id) : onApply(persona.id))}
              >
                {pending ? '적용 중…' : action === 'reapply' ? '최신 값 다시 적용' : '이 대화에 적용'}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function ProfileView({
  conversationId,
  conversation,
  candidates,
  pendingPersonaId,
  contractError,
  catalogError,
  conversationError,
  statusMessage,
  onBack,
  onApply,
  onReapply,
  onRetry,
}: {
  conversationId: string;
  conversation: Conversation;
  candidates: Persona[];
  pendingPersonaId: string | null;
  contractError: boolean;
  catalogError: boolean;
  conversationError: boolean;
  statusMessage: string | null;
  onBack: () => void;
  onApply: (id: string) => void;
  onReapply: () => void;
  onRetry: () => void;
}) {
  const snapshot = deriveAppliedSnapshot(conversation);
  const pending = personaActionsDisabled(pendingPersonaId);
  const fatal = conversationError || contractError;
  const actionsBlocked = pending || catalogError || fatal;
  const reason = pending
    ? '다른 적용이 진행 중입니다.'
    : catalogError
      ? '프로필 목록을 다시 불러온 뒤에 적용할 수 있습니다.'
      : fatal
        ? '프로필 데이터를 확인할 수 없습니다.'
        : null;

  return (
    <SettingsPageLayout header={<ProfileHeader onBack={onBack} />}>
      <div className="profile-page" aria-busy={pending || undefined}>
        <p className="sub">선택 시 이 대화에 복사되며, 다시 적용할 때만 최신 값으로 갱신됨</p>
        {reason ? (
          <span id="profile-action-reason" hidden>
            {reason}
          </span>
        ) : null}
        {catalogError ? (
          <p role="status" aria-live="polite">
            프로필 목록을 불러오지 못했습니다.
          </p>
        ) : (
          <CandidateProfileList
            candidates={candidates}
            currentId={snapshot?.id ?? null}
            pending={pending}
            disabled={actionsBlocked && !pending}
            onApply={onApply}
            onReapply={() => onReapply()}
          />
        )}
        {conversationError ? (
          <p role="alert">대화를 불러오지 못했습니다.</p>
        ) : contractError ? (
          <p role="alert">대화 프로필 데이터가 올바르지 않습니다.</p>
        ) : snapshot ? (
          <AppliedProfileCard snapshot={snapshot} />
        ) : (
          <ProfileEmptyState />
        )}
        {statusMessage ? (
          <p role="status" aria-live="polite">
            {statusMessage}
          </p>
        ) : null}
        {conversationError || catalogError || contractError ? (
          <button type="button" className="btn" onClick={onRetry}>
            다시 시도
          </button>
        ) : null}
        <span hidden>{conversationId}</span>
        <div className="profile-page-end" aria-hidden="true" />
      </div>
    </SettingsPageLayout>
  );
}

export function ConversationProfilePage({ conversationId }: { conversationId: string }) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [candidates, setCandidates] = useState<Persona[]>([]);
  const [conversationError, setConversationError] = useState(false);
  const [catalogError, setCatalogError] = useState(false);
  const [pendingPersonaId, setPendingPersonaId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [loadTick, setLoadTick] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    setConversationError(false);
    setCatalogError(false);
    setConversation(null);
    setCandidates([]);
    const convReq = get<ConversationDetail>(`/api/conversations/${conversationId}`);
    const catalogReq = get<Persona[]>('/api/personas');
    convReq
      .then((detail) => {
        if (ac.signal.aborted) return;
        setConversation(detail.conversation);
      })
      .catch(() => {
        if (!ac.signal.aborted) setConversationError(true);
      });
    catalogReq
      .then((list) => {
        if (ac.signal.aborted) return;
        setCandidates(list);
      })
      .catch(() => {
        if (!ac.signal.aborted) setCatalogError(true);
      });
    return () => ac.abort();
  }, [conversationId, loadTick]);

  const onBack = () => back(`/chat/${conversationId}/settings`);

  const mutate = async (candidateId: string) => {
    const body = buildPersonaPatch(candidateId);
    if (!body || pendingPersonaId || !conversation) {
      if (!body) setStatusMessage('프로필을 선택할 수 없습니다.');
      return;
    }
    setPendingPersonaId(candidateId);
    setStatusMessage(null);
    let patched = false;
    try {
      await patch(`/api/conversations/${conversationId}`, body);
      patched = true;
      const detail = await get<ConversationDetail>(`/api/conversations/${conversationId}`);
      const next = applyMutationOutcome(conversation, { kind: 'ok', conversation: detail.conversation });
      setConversation(next.conversation);
    } catch (err) {
      const outcome: MutationOutcome = !patched
        ? classifyPatchFailure(err)
        : { kind: 'refetch-fail' };
      const next = applyMutationOutcome(conversation, outcome);
      setConversation(next.conversation);
      setStatusMessage(next.message);
      if (next.refreshCatalog) setLoadTick((n) => n + 1);
    } finally {
      setPendingPersonaId(null);
    }
  };

  if (!conversation && !conversationError) {
    return (
      <SettingsPageLayout header={<ProfileHeader onBack={onBack} />}>
        <Spinner />
      </SettingsPageLayout>
    );
  }

  if (!conversation) {
    return (
      <SettingsPageLayout header={<ProfileHeader onBack={onBack} />}>
        <p role="alert">대화를 불러오지 못했습니다.</p>
        <button type="button" className="btn" onClick={() => setLoadTick((n) => n + 1)}>
          다시 시도
        </button>
      </SettingsPageLayout>
    );
  }

  const snapshot = deriveAppliedSnapshot(conversation);
  return (
    <ProfileView
      conversationId={conversationId}
      conversation={conversation}
      candidates={candidates}
      pendingPersonaId={pendingPersonaId}
      contractError={snapshotContractBroken(conversation)}
      catalogError={catalogError}
      conversationError={false}
      statusMessage={statusMessage}
      onBack={onBack}
      onApply={(id) => {
        void mutate(id);
      }}
      onReapply={() => {
        if (snapshot) void mutate(snapshot.id);
      }}
      onRetry={() => setLoadTick((n) => n + 1)}
    />
  );
}

function classifyPatchFailure(err: unknown): MutationOutcome {
  if (err instanceof ApiError) {
    if (err.status === 400) return { kind: 'http', status: 400 };
    if (err.status === 404) return { kind: 'http', status: 404 };
    return { kind: 'http', status: 500 };
  }
  return { kind: 'network' };
}
