/** App chrome tabs — mobile bottom bar + desktop topnav (rpchat routes only). */
export type NavTab = {
  href: string;
  label: string;
  match: (path: string) => boolean;
};

/** 홈 | 채팅 | 명령어 | 설정 — discovery stays on Home (story/character sub-tabs). */
export const NAV_TABS: NavTab[] = [
  {
    href: '/',
    label: '홈',
    match: (p) => p === '/' || p.startsWith('/character') || p.startsWith('/story'),
  },
  {
    href: '/chats',
    label: '채팅',
    match: (p) => p === '/chats' || p.startsWith('/chats/'),
  },
  {
    href: '/shortcuts',
    label: '명령어',
    match: (p) => p === '/shortcuts' || p.startsWith('/shortcuts/'),
  },
  { href: '/settings', label: '설정', match: (p) => p.startsWith('/settings') },
];

/** True when the mobile bottom tab bar should show (tab-shell only; never on /chat/:id). */
export function showBottomTabBar(path: string): boolean {
  if (path.startsWith('/chat/') || path === '/chat') return false;
  return true;
}
