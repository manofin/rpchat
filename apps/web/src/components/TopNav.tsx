import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { navigate, useRoute } from '../lib/router';
import { NAV_TABS } from '../lib/navTabs';
import { useDesktopLayout } from '../lib/useDesktopLayout';
import { OverlayDrawer } from './OverlayDrawer';

/**
 * StoryForge-style compact header: logo + main entries + search.
 * Theme tokens only (coral accent). No Next/lucide — emoji/CSS.
 */
export function TopNav({ actions }: { actions?: ReactNode }) {
  const path = useRoute();
  const desktop = useDesktopLayout();
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState('');

  useEffect(() => {
    setMenuOpen(false);
    setSearchOpen(false);
  }, [path]);

  useEffect(() => {
    if (desktop) setMenuOpen(false);
  }, [desktop]);

  function goSearch(e?: FormEvent) {
    e?.preventDefault();
    const query = q.trim();
    setSearchOpen(false);
    navigate(query ? `/search?q=${encodeURIComponent(query)}` : '/search');
  }

  return (
    <>
      <header className="app-topnav">
        <div className="app-topnav-mobile">
          <button
            type="button"
            className="btn ghost icon"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="메뉴 열기"
            aria-expanded={menuOpen}
          >☰</button>
          <button type="button" className="app-logo" onClick={() => navigate('/')}>RP Chat</button>
          <div className="app-topnav-actions">
            <button
              type="button"
              className="btn ghost icon"
              onClick={() => setSearchOpen((v) => !v)}
              aria-label="검색"
              aria-expanded={searchOpen}
            >🔍</button>
            {actions}
          </div>
        </div>

        {searchOpen && (
          <form className="app-topnav-search-mobile" onSubmit={goSearch}>
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="검색어를 입력해 주세요"
              aria-label="검색어"
            />
            <button type="button" className="btn ghost icon sm" onClick={() => setSearchOpen(false)} aria-label="검색 닫기">✕</button>
          </form>
        )}

        <div className="app-topnav-desktop">
          <button type="button" className="app-logo" onClick={() => navigate('/')}>RP Chat</button>
          <nav className="app-topnav-tabs" aria-label="주요 메뉴">
            {NAV_TABS.map((tab) => {
              const active = tab.match(path);
              return (
                <button
                  key={tab.href}
                  type="button"
                  className={`app-topnav-tab${active ? ' is-active' : ''}`}
                  onClick={() => navigate(tab.href)}
                >
                  {tab.label}
                  {active ? <span className="app-topnav-tab-bar" aria-hidden /> : null}
                </button>
              );
            })}
          </nav>
          <form className="app-topnav-search" onSubmit={goSearch}>
            <span className="app-topnav-search-ico" aria-hidden>🔍</span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="검색어를 입력해 주세요"
              aria-label="검색어"
            />
          </form>
          {actions ? <div className="app-topnav-actions">{actions}</div> : null}
        </div>
      </header>

      <OverlayDrawer
        open={!desktop && menuOpen}
        onClose={() => setMenuOpen(false)}
        side="left"
        title="메뉴"
      >
        <nav className="drawer-nav" aria-label="주요 메뉴">
          {NAV_TABS.map((tab) => {
            const active = tab.match(path);
            return (
              <button
                key={tab.href}
                type="button"
                className={`drawer-nav-item${active ? ' is-active' : ''}`}
                onClick={() => {
                  setMenuOpen(false);
                  navigate(tab.href);
                }}
              >{tab.label}</button>
            );
          })}
        </nav>
      </OverlayDrawer>
    </>
  );
}
