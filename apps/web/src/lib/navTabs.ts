/** App chrome tabs — rpchat routes only (no StoryForge works/image). */
export type NavTab = {
  href: string;
  label: string;
  match: (path: string) => boolean;
};

export const NAV_TABS: NavTab[] = [
  { href: '/', label: '홈', match: (p) => p === '/' },
  { href: '/search', label: '검색', match: (p) => p.startsWith('/search') },
  { href: '/settings', label: '설정', match: (p) => p.startsWith('/settings') },
];
