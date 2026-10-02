import { get, patch } from '../lib/api';
import type { ConversationDetail } from '../types';
import { SettingsSection } from '../components/settings';
export function ObservationFilterSettings({ detail, onReload }: { detail: ConversationDetail; onReload: (detail: ConversationDetail) => void }) {
  return (
      <SettingsSection title="관찰 필터">
        <label><input type="checkbox" checked={!!detail.conversation.scene.observation_filter} onChange={async e => {
          const enabled = e.target.checked;
          const classify = enabled && window.confirm('현재 분기의 과거 미분류 기록을 공개로 일괄 분류할까요? 취소하면 비공개로 유지합니다.');
          try {
            await patch(`/api/conversations/${detail.conversation.id}`, { scene: { observation_filter: enabled }, ...(classify ? { classify_legacy_public: true } : {}) });
            onReload(await get<ConversationDetail>(`/api/conversations/${detail.conversation.id}`));
          } catch (err) { window.alert((err as Error).message); }
        }} /> 관찰 필터 사용</label>
        <p>켠 방의 미분류 기록은 NPC에게 전달하지 않습니다. GM은 기본적으로 비밀을 받지 않습니다. 단일 dialog 호출은 인물별 원천 격리를 제공하지 않습니다. 화면의 비밀 표시에는 적용되지 않습니다.</p>
      </SettingsSection>
  );
}
