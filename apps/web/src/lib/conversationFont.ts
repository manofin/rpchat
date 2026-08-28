export const FONT_STORAGE_KEY = 'rpchat.font';

export type FontPreset = 'kami' | 'system';

export function parseFontPreset(raw: string | null | undefined): FontPreset {
  return raw === 'system' ? 'system' : 'kami';
}

export function readFontPreset(): FontPreset {
  try {
    return parseFontPreset(localStorage.getItem(FONT_STORAGE_KEY));
  } catch {
    return 'kami';
  }
}

export function persistFontPreset(preset: FontPreset): void {
  try {
    localStorage.setItem(FONT_STORAGE_KEY, preset);
  } catch {
    /* private mode / no storage */
  }
}

export function applyFontPreset(
  preset: FontPreset,
  root: { dataset: { rpchatFont?: string } } = document.documentElement,
): void {
  if (preset === 'kami') {
    delete root.dataset.rpchatFont;
  } else {
    root.dataset.rpchatFont = 'system';
  }
}
