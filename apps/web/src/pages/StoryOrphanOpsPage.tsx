import { useEffect, useState } from 'react';
import { get } from '../lib/api';
import { back, navigate } from '../lib/router';
import {
  SettingsBadge,
  SettingsEmptyState,
  SettingsPageHeader,
  SettingsPageLayout,
} from '../components/settings';
import { Spinner } from '../components/ui';

export type OrphanStoryItem = {
  id: string;
  name: string;
  archived: boolean;
  room_n: number;
  updated_at: string;
};

/** Presentational list — exported for bench static markup. */
export function StoryOrphanOpsView({
  items,
  onOpenStory,
}: {
  items: OrphanStoryItem[];
  onOpenStory: (id: string) => void;
}) {
  if (items.length === 0) {
    return <SettingsEmptyState message="고아 스토리가 없습니다." />;
  }
  return (
    <div className="list" data-test="orphan-ops-list">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="list-item"
          style={{ width: '100%', textAlign: 'left', border: 0, background: 'transparent', cursor: 'pointer' }}
          data-test="orphan-ops-row"
          data-story-id={item.id}
          onClick={() => onOpenStory(item.id)}
        >
          <div className="body">
            <div className="t">{item.name}</div>
            <div className="p">대화 {item.room_n}개</div>
          </div>
          {item.archived ? <SettingsBadge>보관</SettingsBadge> : null}
          <span className="settings-chevron" aria-hidden="true">›</span>
        </button>
      ))}
    </div>
  );
}

export function StoryOrphanOpsPage() {
  const [items, setItems] = useState<OrphanStoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await get<OrphanStoryItem[]>('/api/stories/orphans');
        if (!cancelled) setItems(rows);
      } catch (e) {
        if (!cancelled) setError((e as Error).message || '불러오기 실패');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <SettingsPageLayout
      header={<SettingsPageHeader title="고아 스토리" onBack={() => back('/settings')} />}
    >
      {error ? (
        <SettingsEmptyState message={error} />
      ) : items === null ? (
        <Spinner label="불러오는 중…" />
      ) : (
        <StoryOrphanOpsView
          items={items}
          onOpenStory={(id) => navigate(`/story/${id}`)}
        />
      )}
    </SettingsPageLayout>
  );
}
