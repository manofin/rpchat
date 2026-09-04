import { useEffect, useState } from 'react';
import { get } from '../lib/api';
import type { ConversationDetail } from '../types';
import { Avatar } from '../components/view';
import { Spinner } from '../components/ui';
import {
  SettingsEmptyState,
  SettingsNavigationRow,
  SettingsSection,
  SettingsToggleRow,
  SettingsValueRow,
} from '../components/settings';
import {
  WEB_APP_VERSION,
  buildHubItems,
  summarizeConversationDetail,
  type SettingsHubItem,
  type SettingsLeaf,
} from '../lib/conversationSettings';
import { ConversationGuidePage } from './ConversationGuidePage';
import { ConversationMemoryPage } from './ConversationMemoryPage';
import { ConversationOutputPage } from './ConversationOutputPage';
import { ConversationProfilePage } from './ConversationProfilePage';
import { ConversationStylePage } from './ConversationStylePage';
import { ConversationUserNotePage } from './ConversationUserNotePage';

const SECTION_TITLE: Record<SettingsHubItem['section'], string> = {
  room: '채팅방 설정',
  global: '전체 설정',
  start: '시작 설정',
  about: '업데이트 정보',
};

const SECTION_ORDER: SettingsHubItem['section'][] = ['room', 'global', 'start', 'about'];

export function ConversationTools({
  conversationId,
  onChanged,
}: {
  conversationId: string;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [leaf, setLeaf] = useState<SettingsLeaf | null>(null);

  useEffect(() => {
    let live = true;
    setMissing(false);
    get<ConversationDetail>(`/api/conversations/${conversationId}`)
      .then((d) => {
        if (live) setDetail(d);
      })
      .catch(() => {
        if (live) setMissing(true);
      });
    return () => {
      live = false;
    };
  }, [conversationId]);

  const goHub = () => {
    setLeaf(null);
    onChanged();
  };

  if (missing) return <SettingsEmptyState message="대화를 찾을 수 없습니다." />;
  if (!detail) return <Spinner />;

  if (leaf === 'guide') return <ConversationGuidePage conversationId={conversationId} onBack={goHub} />;
  if (leaf === 'profile') return <ConversationProfilePage conversationId={conversationId} onBack={goHub} />;
  if (leaf === 'user-note') return <ConversationUserNotePage conversationId={conversationId} onBack={goHub} />;
  if (leaf === 'memory') return <ConversationMemoryPage conversationId={conversationId} onBack={goHub} />;
  if (leaf === 'output') return <ConversationOutputPage conversationId={conversationId} onBack={goHub} />;
  if (leaf === 'style') return <ConversationStylePage conversationId={conversationId} onBack={goHub} />;

  const summary = summarizeConversationDetail(detail, WEB_APP_VERSION);
  const items = buildHubItems(summary);

  return (
    <div className="tools-hub">
      <div className="row" style={{ alignItems: 'center', gap: 10, padding: '4px 8px 12px' }}>
        <Avatar name={summary.subtitle} avatar={summary.avatar} size="sm" />
        <div className="title" style={{ minWidth: 0 }}>
          <strong>{summary.title}</strong>
          <div className="sub">{summary.subtitle}</div>
        </div>
      </div>
      {SECTION_ORDER.map((section) => {
        const rows = items.filter((item) => item.section === section);
        if (rows.length === 0) return null;
        return (
          <SettingsSection key={section} title={SECTION_TITLE[section]}>
            {rows.map((item) => {
              if (item.control === 'toggle') {
                return (
                  <SettingsToggleRow
                    key={item.id}
                    title={item.title}
                    checked={false}
                    disabled={item.state === 'disabled'}
                  />
                );
              }
              if (item.control === 'value' || item.state === 'read-only') {
                return <SettingsValueRow key={item.id} title={item.title} value={item.value} />;
              }
              return (
                <SettingsNavigationRow
                  key={item.id}
                  title={item.title}
                  value={item.value}
                  href={item.href}
                  disabled={item.state === 'disabled'}
                  onNavigate={() => {
                    const id = item.id as SettingsLeaf;
                    if (id === 'guide' || id === 'profile' || id === 'user-note' || id === 'memory' || id === 'output' || id === 'style') {
                      setLeaf(id);
                    }
                  }}
                />
              );
            })}
          </SettingsSection>
        );
      })}
    </div>
  );
}
