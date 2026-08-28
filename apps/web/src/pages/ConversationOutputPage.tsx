import React, { useEffect, useState } from 'react';
import { get, patch } from '../lib/api';
import { back } from '../lib/router';
import type { ConversationDetail, ModelProfile } from '../types';
import { SettingsEmptyState, SettingsPageHeader, SettingsPageLayout } from '../components/settings';
import { Spinner } from '../components/ui';
import { outputProfileLabel, settingsBackFallback } from '../lib/conversationSettings';

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
}: {
  profileName: string;
  profiles: ModelProfile[];
  pending: boolean;
  onChange: (name: string) => void;
  onBack: () => void;
}) {
  const options = rpOutputProfiles(profiles);
  return (
    <SettingsPageLayout header={<SettingsPageHeader title="최대 출력량 조절" onBack={onBack} />}>
      <section className="card settings-section-body" style={{ padding: 16 }}>
        <label className="sub" htmlFor="output-profile">
          최대 출력량
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
              {outputProfileLabel(p.name)} · {p.name} · max {p.max_tokens}
            </option>
          ))}
        </select>
        <p className="sub">대화 프로필의 max_tokens 를 따릅니다. 전역 PUT 은 이 화면에서 하지 않습니다.</p>
      </section>
    </SettingsPageLayout>
  );
}

export function ConversationOutputPage({ conversationId }: { conversationId: string }) {
  const [profileName, setProfileName] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<ModelProfile[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [pending, setPending] = useState(false);
  const onBack = () => back(settingsBackFallback(conversationId, 'leaf'));

  useEffect(() => {
    let live = true;
    setMissing(false);
    setProfileName(null);
    setProfiles(null);
    Promise.all([
      get<ConversationDetail>(`/api/conversations/${conversationId}`),
      get<ModelProfile[]>('/api/profiles'),
    ])
      .then(([d, list]) => {
        if (!live) return;
        setProfileName(d.conversation.profile_name);
        setProfiles(list);
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

  if (missing) {
    return (
      <SettingsPageLayout header={<SettingsPageHeader title="최대 출력량 조절" onBack={onBack} />}>
        <SettingsEmptyState message="대화를 찾을 수 없습니다." />
      </SettingsPageLayout>
    );
  }

  if (profileName === null || profiles === null) {
    return (
      <SettingsPageLayout header={<SettingsPageHeader title="최대 출력량 조절" onBack={onBack} />}>
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
      onBack={onBack}
    />
  );
}
