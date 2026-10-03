import React, { useState } from 'react';
import { back } from '../lib/router';
import { SettingsPageHeader, SettingsPageLayout } from '../components/settings';
import { settingsBackFallback } from '../lib/conversationSettings';
import { MemoryTab, SummaryTab } from './ChatDrawer';
import { DialogKnowledgeEditor } from '../components/DialogKnowledgeEditor';

type MemoryLeafTab = 'memory' | 'summary' | 'knowledge';

export function ConversationMemoryPage({ conversationId, onBack }: { conversationId: string; onBack?: () => void }) {
  const [tab, setTab] = useState<MemoryLeafTab>('summary');
  const goBack = onBack ?? (() => back(settingsBackFallback(conversationId, 'leaf')));
  return (
    <SettingsPageLayout
      header={<SettingsPageHeader title="요약 메모리" onBack={goBack} />}
    >
      <div className="settings-leaf-tabs">
        <button type="button" className={tab === 'memory' ? 'active' : ''} onClick={() => setTab('memory')}>기억</button>
        <button type="button" className={tab === 'summary' ? 'active' : ''} onClick={() => setTab('summary')}>요약</button>
        <button type="button" className={tab === 'knowledge' ? 'active' : ''} onClick={() => setTab('knowledge')}>인물별 기억</button>
      </div>
      {tab === 'memory' && (
        <MemoryTab conversationId={conversationId} open onApplied={() => undefined} onClose={() => undefined} />
      )}
      {tab === 'summary' && (
        <SummaryTab conversationId={conversationId} open onApplied={() => undefined} onClose={() => undefined} />
      )}
      {tab === 'knowledge' && <DialogKnowledgeEditor conversationId={conversationId} />}
    </SettingsPageLayout>
  );
}
