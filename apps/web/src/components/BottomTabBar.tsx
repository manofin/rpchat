import { navigate, useRoute } from '../lib/router';
import { NAV_TABS, showBottomTabBar } from '../lib/navTabs';
import { useDesktopLayout } from '../lib/useDesktopLayout';

/** Mobile-only bottom tabs. Hidden on /chat/:id so composer/keyboard stay untouched. */
export function BottomTabBar() {
  const path = useRoute();
  const desktop = useDesktopLayout();
  if (desktop || !showBottomTabBar(path)) return null;

  return (
    <nav className="app-bottom-nav" aria-label="하단 탭">
      {NAV_TABS.map((tab) => {
        const active = tab.match(path);
        return (
          <button
            key={tab.href}
            type="button"
            className={`app-bottom-nav-item${active ? ' is-active' : ''}`}
            onClick={() => navigate(tab.href)}
            aria-current={active ? 'page' : undefined}
          >
            <span className="app-bottom-nav-label">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
