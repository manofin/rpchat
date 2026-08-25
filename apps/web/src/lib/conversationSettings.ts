import { match } from './router';

/** apps/web/package.json version. Display-only; no store/hasUpdate. */
export const WEB_APP_VERSION = '0.1.0';

export const SETTINGS_LEAVES = [
  'guide',
  'profile',
  'user-note',
  'output',
  'memory',
  'style',
  'start',
  'about',
] as const;

export type SettingsLeaf = (typeof SETTINGS_LEAVES)[number];

export type SettingsRoute =
  | { kind: 'hub'; conversationId: string }
  | { kind: 'leaf'; conversationId: string; leaf: SettingsLeaf };

export function resolveSettingsRoute(path: string): SettingsRoute | null {
  const leafHit = match(path, '/chat/:conversationId/settings/:leaf');
  if (leafHit) {
    if (!(SETTINGS_LEAVES as readonly string[]).includes(leafHit.leaf)) return null;
    return { kind: 'leaf', conversationId: leafHit.conversationId, leaf: leafHit.leaf as SettingsLeaf };
  }
  const hub = match(path, '/chat/:conversationId/settings');
  if (hub) return { kind: 'hub', conversationId: hub.conversationId };
  return null;
}

export type SettingsItemState = 'available' | 'read-only' | 'disabled' | 'hidden';

export type SettingsHubItem = {
  id: string;
  section: 'room' | 'global' | 'start' | 'about';
  title: string;
  state: SettingsItemState;
  href?: string;
  value?: string;
  control: 'navigate' | 'toggle' | 'value';
};

export type SettingsHubSummary = {
  conversationId: string;
  title: string;
  subtitle: string;
  avatar: string | null;
  profile: { label: string; hasSnapshot: boolean };
  userNote: { configured: boolean; length: number };
  output: { profileName: string; label: string };
  startTitle: string;
  appVersion: string;
};

export function outputProfileLabel(profileName: string): string {
  if (profileName === 'rp-balanced') return '균형';
  if (profileName === 'rp-creative') return '창의';
  return profileName;
}

export function settingsBackFallback(conversationId: string, from: 'hub' | 'leaf'): string {
  return from === 'leaf' ? `/chat/${conversationId}/settings` : `/chat/${conversationId}`;
}

export function sceneImageTogglePolicy(): { persist: false; allowedMethods: [] } {
  return { persist: false, allowedMethods: [] };
}

/** Gate 2: display-only. Never call the provided patch/write callback. */
export function applySceneImageToggle(_patch?: () => void): void {
  return;
}

export function isRowNavigable(item: SettingsHubItem): boolean {
  return item.state === 'available' && item.control === 'navigate' && !!item.href;
}

function startTitleFromScene(scene: { place?: string; time?: string; goal?: string } | undefined): string {
  const parts = [scene?.place, scene?.time, scene?.goal].filter(Boolean);
  return parts.join(' · ');
}

export function summarizeConversationDetail(
  detail: {
    conversation: {
      id: string;
      title: string;
      profile_name: string;
      user_note?: string | null;
      scene?: { place?: string; time?: string; goal?: string };
      persona_applied_at?: string | null;
    };
    character: { name: string; avatar: string | null; scenario?: string };
    persona: { name: string } | null;
  },
  appVersion: string,
): SettingsHubSummary {
  const note = detail.conversation.user_note ?? '';
  const startTitle = startTitleFromScene(detail.conversation.scene) || detail.character.scenario || '';
  return {
    conversationId: detail.conversation.id,
    title: detail.conversation.title || detail.character.name,
    subtitle: detail.character.name,
    avatar: detail.character.avatar,
    profile: {
      label: detail.persona?.name ?? '나',
      hasSnapshot: Boolean(detail.conversation.persona_applied_at),
    },
    userNote: { configured: note.length > 0, length: note.length },
    output: {
      profileName: detail.conversation.profile_name,
      label: outputProfileLabel(detail.conversation.profile_name),
    },
    startTitle,
    appVersion,
  };
}

export function buildHubItems(summary: SettingsHubSummary): SettingsHubItem[] {
  const id = summary.conversationId;
  const leaf = (leafId: string) => `/chat/${id}/settings/${leafId}`;
  const all: SettingsHubItem[] = [
    { id: 'guide', section: 'room', title: '플레이 가이드', state: 'available', control: 'navigate', href: leaf('guide') },
    { id: 'profile', section: 'room', title: '대화 프로필', state: 'available', control: 'navigate', href: leaf('profile'), value: summary.profile.label },
    { id: 'user-note', section: 'room', title: '유저노트', state: 'available', control: 'navigate', href: leaf('user-note'), value: summary.userNote.configured ? `${summary.userNote.length}자` : '없음' },
    { id: 'output', section: 'room', title: '최대 출력량 조절', state: 'available', control: 'navigate', href: leaf('output'), value: summary.output.label },
    { id: 'memory', section: 'room', title: '요약 메모리', state: 'available', control: 'navigate', href: leaf('memory') },
    { id: 'style', section: 'global', title: '글꼴', state: 'available', control: 'navigate', href: leaf('style') },
    { id: 'scene-image', section: 'global', title: '상황 이미지 보기', state: 'disabled', control: 'toggle' },
    { id: 'start', section: 'start', title: '시작 설정', state: 'read-only', control: 'value', value: summary.startTitle },
    { id: 'about', section: 'about', title: '앱 버전', state: 'read-only', control: 'value', value: summary.appVersion },
    { id: 'currency', section: 'global', title: '재화', state: 'hidden', control: 'value' },
  ];
  return all.filter((item) => item.state !== 'hidden');
}
