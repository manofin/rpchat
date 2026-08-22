import { useEffect, useState } from 'react';

export function useRoute(): string {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const h = () => setPath(window.location.pathname);
    window.addEventListener('popstate', h);
    return () => window.removeEventListener('popstate', h);
  }, []);
  return path;
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function back(fallback = '/'): void {
  if (window.history.length > 1) window.history.back();
  else navigate(fallback, { replace: true });
}

/** '/chat/:id' 꼴 패턴 매칭 */
export function match(path: string, pattern: string): Record<string, string> | null {
  const a = path.split('/').filter(Boolean);
  const b = pattern.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < b.length; i++) {
    if (b[i].startsWith(':')) params[b[i].slice(1)] = decodeURIComponent(a[i]);
    else if (b[i] !== a[i]) return null;
  }
  return params;
}

export function query(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}
