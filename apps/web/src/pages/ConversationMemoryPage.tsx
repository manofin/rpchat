import React, { useCallback, useState } from 'react';
import { back } from '../lib/router';
import { SettingsPageHeader, SettingsPageLayout } from '../components/settings';
import { settingsBackFallback } from '../lib/conversationSettings';
import { MemoryTab, SummaryTab } from './ChatDrawer';
import { DialogKnowledgeEditor } from '../components/DialogKnowledgeEditor';
import { ConversationMemoryContext } from '../components/ConversationMemoryContext';
import type { ConversationDetail } from '../types';

type MemoryLeafTab = 'memory' | 'summary' | 'knowledge';

export function ConversationMemoryPage({ conversationId, onBack }: { conversationId: string; onBack?: () => void }) {
  const [tab, setTab] = useState<MemoryLeafTab>('summary');
  const [branch, setBranch] = useState<{ conversationId: string; head: string | null; revision: number } | null>(null);
  const [contextReady, setContextReady] = useState(false);
  const onLoaded = useCallback((detail: ConversationDetail) => {
    setBranch(previous => ({ conversationId: detail.conversation.id, head: detail.conversation.head_message_id, revision: (previous?.revision ?? 0) + 1 }));
  }, []);
  const head = branch?.conversationId === conversationId ? branch.head : undefined;
  const revision = branch?.conversationId === conversationId ? branch.revision : 0;
  const goBack = onBack ?? (() => back(settingsBackFallback(conversationId, 'leaf')));
  return (
    <SettingsPageLayout
      header={<SettingsPageHeader title="요약 메모리" onBack={goBack} />}
    >
      <ConversationMemoryContext conversationId={conversationId} onLoaded={onLoaded} onReadyChange={setContextReady} />
      <div className="settings-leaf-tabs">
        <button type="button" className={tab === 'memory' ? 'active' : ''} onClick={() => setTab('memory')}>기억</button>
        <button type="button" className={tab === 'summary' ? 'active' : ''} onClick={() => setTab('summary')}>요약</button>
        <button type="button" className={tab === 'knowledge' ? 'active' : ''} onClick={() => setTab('knowledge')}>인물별 기억</button>
      </div>
      <div hidden={!contextReady}>
      {tab === 'memory' && head !== undefined && (
        <MemoryTab key={`${conversationId}:${head ?? ''}`} revision={revision} conversationId={conversationId} open={contextReady} onApplied={() => undefined} onClose={() => undefined} />
      )}
      {tab === 'summary' && head !== undefined && (
        <SummaryTab key={`${conversationId}:${head ?? ''}`} conversationId={conversationId} headMessageId={head} revision={revision} open={contextReady} onApplied={() => undefined} onClose={() => undefined} />
      )}
      {tab === 'knowledge' && head !== undefined && <DialogKnowledgeEditor conversationId={conversationId} headMessageId={head} />}
      </div>
    </SettingsPageLayout>
  );
}
