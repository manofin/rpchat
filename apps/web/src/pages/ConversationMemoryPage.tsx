import React, { useState } from 'react';
import { back } from '../lib/router';
import { SettingsPageHeader, SettingsPageLayout } from '../components/settings';
import { settingsBackFallback } from '../lib/conversationSettings';
import { MemoryTab, SummaryTab } from './ChatDrawer';

type MemoryLeafTab = 'memory' | 'summary';

export function ConversationMemoryPage({ conversationId }: { conversationId: string }) {
  const [tab, setTab] = useState<MemoryLeafTab>('summary');
  const onBack = () => back(settingsBackFallback(conversationId, 'leaf'));
  return (
    <SettingsPageLayout
      header={<SettingsPageHeader title="요약 메모리" onBack={onBack} />}
    >
      <div className="settings-leaf-tabs">
        <button type="button" className={tab === 'memory' ? 'active' : ''} onClick={() => setTab('memory')}>기억</button>
        <button type="button" className={tab === 'summary' ? 'active' : ''} onClick={() => setTab('summary')}>요약</button>
      </div>
      {tab === 'memory' && (
        <MemoryTab conversationId={conversationId} open onApplied={() => undefined} onClose={() => undefined} />
      )}
      {tab === 'summary' && (
        <SummaryTab conversationId={conversationId} open onApplied={() => undefined} onClose={() => undefined} />
      )}
    </SettingsPageLayout>
  );
}
