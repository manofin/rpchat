import React, { useEffect, useState } from 'react';
import { get, patch } from '../lib/api';
import { back } from '../lib/router';
import type { ConversationDetail, ModelProfile, ResponseLength } from '../types';
import { SettingsEmptyState, SettingsPageHeader, SettingsPageLayout } from '../components/settings';
import { Spinner } from '../components/ui';
import { outputProfileLabel, settingsBackFallback } from '../lib/conversationSettings';
import { instructionBadge } from '../lib/profileInstruction';
import { ResponseLengthSelect } from '../components/ResponseLengthSelect';
import { buildResponseLengthPatch } from '../lib/responseControls';

export function rpOutputProfiles(profiles: ModelProfile[]): ModelProfile[] {
  return profiles.filter((p) => p.name.startsWith('rp-'));
}

export function buildProfileNamePatch(name: string): { profileName: string } | null {
  if (!name.startsWith('rp-')) return null;
  return { profileName: name };
}

export function OutputView({
  profileName,
  profiles,
  pending,
  onChange,
  onBack,
  responseLength = 'normal',
  onLengthChange,
  error,
}: {
  profileName: string;
  profiles: ModelProfile[];
  pending: boolean;
  onChange: (name: string) => void;
  onBack: () => void;
  responseLength?: ResponseLength;
  onLengthChange?: (length: ResponseLength) => void;
  error?: string | null;
}) {
  const options = rpOutputProfiles(profiles);
  return (
    <SettingsPageLayout header={<SettingsPageHeader title="최대 출력량 조절" onBack={onBack} />}>
      <section className="card settings-section-body" style={{ padding: 16 }}>
        <ResponseLengthSelect value={responseLength} disabled={pending || !onLengthChange} onChange={(value) => onLengthChange?.(value)} />
        <label className="sub" htmlFor="output-profile">
          출력/톤 프로필
        </label>
        <select
          id="output-profile"
          className="input"
          value={profileName}
          disabled={pending}
          onChange={(e) => onChange(e.target.value)}
        >
          {options.map((p) => (
            <option key={p.name} value={p.name}>
              {outputProfileLabel(p.name)} · {p.name} · max {p.max_tokens}{instructionBadge(p)}
            </option>
          ))}
        </select>
        <p className="sub">보통은 현재 프로필과 대화 방식의 기본 출력량을 사용합니다. 프로필을 바꾸면 문체·온도 설정도 함께 바뀝니다.</p>
        {error ? <p className="banner err" role="alert">{error}</p> : null}
      </section>
    </SettingsPageLayout>
  );
}

export function ConversationOutputPage({ conversationId, onBack }: { conversationId: string; onBack?: () => void }) {
  const [profileName, setProfileName] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<ModelProfile[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [pending, setPending] = useState(false);
  const [responseLength, setResponseLength] = useState<ResponseLength>('normal');
  const [error, setError] = useState<string | null>(null);
  const goBack = onBack ?? (() => back(settingsBackFallback(conversationId, 'leaf')));

  useEffect(() => {
    let live = true;
    setMissing(false);
    setProfileName(null);
    setProfiles(null);
    setError(null);
    Promise.all([
      get<ConversationDetail>(`/api/conversations/${conversationId}`),
      get<ModelProfile[]>('/api/profiles'),
    ])
      .then(([d, list]) => {
        if (!live) return;
        setProfileName(d.conversation.profile_name);
        setProfiles(list);
        setResponseLength(d.conversation.scene.response_length ?? 'normal');
      })
      .catch(() => {
        if (live) setMissing(true);
      });
    return () => {
      live = false;
    };
  }, [conversationId]);

  async function onChange(name: string) {
    const body = buildProfileNamePatch(name);
    if (!body || pending) return;
    const prev = profileName;
    setProfileName(name);
    setPending(true);
    try {
      await patch(`/api/conversations/${conversationId}`, body);
    } catch {
      if (prev != null) setProfileName(prev);
    } finally {
      setPending(false);
    }
  }

  async function onLengthChange(length: ResponseLength) {
    const body = buildResponseLengthPatch(length);
    if (!body || pending) return;
    setPending(true);
    setError(null);
    try {
      const saved = await patch<ConversationDetail['conversation']>(`/api/conversations/${conversationId}`, body);
      setResponseLength(saved.scene.response_length ?? 'normal');
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPending(false);
    }
  }

  if (missing) {
    return (
      <SettingsPageLayout header={<SettingsPageHeader title="최대 출력량 조절" onBack={goBack} />}>
        <SettingsEmptyState message="대화를 찾을 수 없습니다." />
      </SettingsPageLayout>
    );
  }

  if (profileName === null || profiles === null) {
    return (
      <SettingsPageLayout header={<SettingsPageHeader title="최대 출력량 조절" onBack={goBack} />}>
        <Spinner />
      </SettingsPageLayout>
    );
  }

  return (
    <OutputView
      profileName={profileName}
      profiles={profiles}
      pending={pending}
      onChange={onChange}
      onBack={goBack}
      responseLength={responseLength}
      onLengthChange={onLengthChange}
      error={error}
    />
  );
}
