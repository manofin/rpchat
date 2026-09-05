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

/**
 * Utilities hub (StoryForge UtilitiesPanel tone) — same catalog as the settings
 * hub page (`buildHubItems`), different chrome: icon rows + denser cards.
 *
 * Section membership stays in `buildHubItems`; do not move items between
 * sections here or the hub/drawer inventory benches will diverge.
 */
const SECTION_TITLE: Record<SettingsHubItem['section'], string> = {
  start: '현재 장면',
  room: '대화 도구',
  global: '표시 · 보조',
  about: '정보',
};

const SECTION_ORDER: SettingsHubItem['section'][] = ['start', 'room', 'global', 'about'];

const TOOL_ICON: Record<string, string> = {
  guide: '📖',
  profile: '👤',
  'user-note': '📝',
  output: '📏',
  memory: '🧠',
  style: '🔤',
  'scene-image': '🖼',
  start: '📍',
  about: 'ℹ',
};

export function ConversationTools({
  conversationId,
  onChanged,
  onOpenContextInspector,
}: {
  conversationId: string;
  onChanged: () => void;
  /** Mobile: header CI is CSS-hidden; surface the same drawer from this hub. */
  onOpenContextInspector?: () => void;
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
      <div className="tools-hub-identity">
        <Avatar name={summary.subtitle} avatar={summary.avatar} size="sm" />
        <div className="title" style={{ minWidth: 0 }}>
          <strong>{summary.title}</strong>
          <div className="sub">{summary.subtitle}</div>
        </div>
      </div>

      {onOpenContextInspector ? (
        <button
          type="button"
          className="tools-row tools-row-action"
          data-test="tools-context-inspector"
          aria-label="컨텍스트 인스펙터 열기"
          onClick={onOpenContextInspector}
        >
          <span className="tools-row-icon" aria-hidden="true">▤</span>
          <span className="tools-row-copy">
            <span className="tools-row-title">컨텍스트 인스펙터</span>
            <span className="tools-row-desc">예산 · 기억 · 요약</span>
          </span>
          <span className="tools-row-chevron" aria-hidden="true">›</span>
        </button>
      ) : null}

      {SECTION_ORDER.map((section) => {
        const rows = items.filter((item) => item.section === section);
        if (rows.length === 0) return null;
        return (
          <SettingsSection key={section} title={SECTION_TITLE[section]}>
            {rows.map((item) => {
              const icon = TOOL_ICON[item.id] ?? '·';
              if (item.control === 'toggle') {
                return (
                  <div key={item.id} className="tools-row-wrap" data-tools-id={item.id}>
                    <span className="tools-row-icon" aria-hidden="true">{icon}</span>
                    <SettingsToggleRow
                      title={item.title}
                      checked={false}
                      disabled={item.state === 'disabled'}
                    />
                  </div>
                );
              }
              if (item.control === 'value' || item.state === 'read-only') {
                return (
                  <div key={item.id} className="tools-row-wrap" data-tools-id={item.id}>
                    <span className="tools-row-icon" aria-hidden="true">{icon}</span>
                    <SettingsValueRow title={item.title} value={item.value} />
                  </div>
                );
              }
              return (
                <div key={item.id} className="tools-row-wrap" data-tools-id={item.id}>
                  <span className="tools-row-icon" aria-hidden="true">{icon}</span>
                  <SettingsNavigationRow
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
                </div>
              );
            })}
          </SettingsSection>
        );
      })}

      <div className="tools-hub-foot">앱 v{summary.appVersion} · 대화 도구</div>
    </div>
  );
}
