import React, { useEffect, useState } from 'react';
import { get } from '../lib/api';
import { back } from '../lib/router';
import type { ConversationDetail } from '../types';
import { SettingsEmptyState, SettingsPageHeader, SettingsPageLayout } from '../components/settings';
import { Spinner } from '../components/ui';
import { settingsBackFallback } from '../lib/conversationSettings';

export function joinPlayGuide(character: {
  description?: string | null;
  personality?: string | null;
  speech_style?: string | null;
  taboos?: string | null;
}): string {
  return [character.description, character.personality, character.speech_style, character.taboos]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join('\n\n') || '(작성된 가이드 없음)';
}

export function GuideView({ text, onBack }: { text: string; onBack: () => void }) {
  return (
    <SettingsPageLayout header={<SettingsPageHeader title="플레이 가이드" onBack={onBack} />}>
      <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.6 }}>{text}</div>
    </SettingsPageLayout>
  );
}

export function ConversationGuidePage({ conversationId, onBack }: { conversationId: string; onBack?: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const goBack = onBack ?? (() => back(settingsBackFallback(conversationId, 'leaf')));

  useEffect(() => {
    let live = true;
    setMissing(false);
    setText(null);
    get<ConversationDetail>(`/api/conversations/${conversationId}`)
      .then((d) => {
        if (live) setText(joinPlayGuide(d.character));
      })
      .catch(() => {
        if (live) setMissing(true);
      });
    return () => {
      live = false;
    };
  }, [conversationId]);

  if (missing) {
    return (
      <SettingsPageLayout header={<SettingsPageHeader title="플레이 가이드" onBack={goBack} />}>
        <SettingsEmptyState message="대화를 찾을 수 없습니다." />
      </SettingsPageLayout>
    );
  }

  if (text === null) {
    return (
      <SettingsPageLayout header={<SettingsPageHeader title="플레이 가이드" onBack={goBack} />}>
        <Spinner />
      </SettingsPageLayout>
    );
  }

  return <GuideView text={text} onBack={goBack} />;
}
