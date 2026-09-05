/** App chrome tabs — rpchat routes only (no StoryForge works/image). */
export type NavTab = {
  href: string;
  label: string;
  match: (path: string) => boolean;
};

function homeTab(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('tab');
}

export const NAV_TABS: NavTab[] = [
  {
    href: '/',
    label: '홈',
    match: (p) => p === '/' && homeTab() !== 'character',
  },
  {
    href: '/?tab=character',
    label: '캐릭터',
    match: (p) => p.startsWith('/character') || (p === '/' && homeTab() === 'character'),
  },
  { href: '/search', label: '검색', match: (p) => p.startsWith('/search') },
  { href: '/settings', label: '설정', match: (p) => p.startsWith('/settings') },
];
