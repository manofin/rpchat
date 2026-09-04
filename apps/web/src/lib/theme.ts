export const THEME_STORAGE_KEY = 'rpchat.theme';

export type Theme = 'dark' | 'light';

export function parseTheme(raw: string | null | undefined): Theme {
  return raw === 'light' ? 'light' : 'dark';
}

export function readTheme(): Theme {
  try {
    return parseTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'dark';
  }
}

export function persistTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* private mode / no storage */
  }
}

export function applyTheme(
  theme: Theme,
  root: { dataset: { theme?: string } } = document.documentElement,
): void {
  if (theme === 'dark') {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = 'light';
  }
}
