import { useEffect, useState } from 'react';
import { get } from '../lib/api';
import { back } from '../lib/router';
import type { ConversationDetail } from '../types';
import { Avatar } from '../components/view';
import { Spinner } from '../components/ui';
import {
  SettingsEmptyState,
  SettingsNavigationRow,
  SettingsPageHeader,
  SettingsPageLayout,
  SettingsSection,
  SettingsToggleRow,
  SettingsValueRow,
} from '../components/settings';
import {
  WEB_APP_VERSION,
  buildHubItems,
  settingsBackFallback,
  summarizeConversationDetail,
  type SettingsHubItem,
  type SettingsRoute,
} from '../lib/conversationSettings';
import { ConversationProfilePage } from './ConversationProfilePage';

const LEAF_TITLE: Record<string, string> = {
  guide: '플레이 가이드',
  profile: '대화 프로필',
  'user-note': '유저노트',
  output: '최대 출력량 조절',
  memory: '요약 메모리',
  style: '글꼴',
  start: '시작 설정',
  about: '업데이트 정보',
};

const SECTION_TITLE: Record<SettingsHubItem['section'], string> = {
  room: '채팅방 설정',
  global: '전체 설정',
  start: '시작 설정',
  about: '업데이트 정보',
};

const SECTION_ORDER: SettingsHubItem['section'][] = ['room', 'global', 'start', 'about'];

export function ConversationSettingsPage({ route }: { route: SettingsRoute }) {
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const from = route.kind === 'leaf' ? 'leaf' : 'hub';
  const onBack = () => back(settingsBackFallback(route.conversationId, from));

  useEffect(() => {
    let live = true;
    setMissing(false);
    setDetail(null);
    get<ConversationDetail>(`/api/conversations/${route.conversationId}`)
      .then((d) => {
        if (live) setDetail(d);
      })
      .catch(() => {
        if (live) setMissing(true);
      });
    return () => {
      live = false;
    };
  }, [route.conversationId]);

  if (missing) {
    return (
      <SettingsPageLayout header={<SettingsPageHeader title="설정" onBack={onBack} />}>
        <SettingsEmptyState message="대화를 찾을 수 없습니다." />
      </SettingsPageLayout>
    );
  }

  if (!detail) {
    return (
      <SettingsPageLayout header={<SettingsPageHeader title="설정" onBack={onBack} />}>
        <Spinner />
      </SettingsPageLayout>
    );
  }

  if (route.kind === 'leaf' && route.leaf === 'profile') {
    return <ConversationProfilePage conversationId={route.conversationId} />;
  }

  if (route.kind === 'leaf') {
    return (
      <SettingsPageLayout
        header={<SettingsPageHeader title={LEAF_TITLE[route.leaf] ?? route.leaf} onBack={onBack} />}
      >
        <SettingsEmptyState message="이 화면은 후속 게이트에서 연결합니다." />
      </SettingsPageLayout>
    );
  }

  const summary = summarizeConversationDetail(detail, WEB_APP_VERSION);
  const items = buildHubItems(summary);

  return (
    <SettingsPageLayout
      header={(
        <SettingsPageHeader
          title={summary.title}
          subtitle={summary.subtitle}
          avatar={<Avatar name={summary.subtitle} avatar={summary.avatar} size="sm" />}
          onBack={onBack}
        />
      )}
    >
      {SECTION_ORDER.map((section) => {
        const rows = items.filter((item) => item.section === section);
        if (rows.length === 0) return null;
        return (
          <SettingsSection key={section} title={SECTION_TITLE[section]}>
            {rows.map((item) => renderItem(item))}
          </SettingsSection>
        );
      })}
    </SettingsPageLayout>
  );
}

function renderItem(item: SettingsHubItem) {
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
    />
  );
}
