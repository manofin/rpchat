import type { SceneCatalog } from '../types';

export type PortraitCatalogDraft = {
  outfits: string;
  emotions: Array<{ name: string; index: string }>;
  defaultEmotion: string;
};

export function portraitDraft(catalog: Pick<SceneCatalog, 'outfits' | 'emotions' | 'default_emotion'>): PortraitCatalogDraft {
  return {
    outfits: catalog.outfits.join('\n'),
    emotions: Object.entries(catalog.emotions).map(([name, index]) => ({ name, index: String(index) })),
    defaultEmotion: catalog.default_emotion ?? '',
  };
}

export function buildPortraitCatalog(draft: PortraitCatalogDraft):
  | { value: Pick<SceneCatalog, 'outfits' | 'emotions' | 'default_emotion'>; error?: never }
  | { error: string; value?: never } {
  const outfits = [...new Set(draft.outfits.split(/\r?\n/).map(v => v.trim()).filter(Boolean))];
  if (outfits.length > 50 || outfits.some(v => v.length > 40 || v.includes('..') || /[\/\\\x00-\x1f]/.test(v))) {
    return { error: '의상 이름은 40자 이하로, 줄마다 하나씩 최대 50개 등록해 주세요. 경로 기호는 사용할 수 없습니다.' };
  }
  const emotions: Record<string, number> = {};
  for (const row of draft.emotions) {
    const name = row.name.trim();
    const index = row.index.trim();
    if (!name && !index) continue;
    const n = Number(index);
    if (!name || name.length > 40 || !index || !Number.isInteger(n) || n < 0 || n > 9999) {
      return { error: '표정 이름과 0–9999 사이의 이미지 번호를 함께 입력해 주세요.' };
    }
    if (Object.prototype.hasOwnProperty.call(emotions, name)) return { error: '같은 표정 이름을 두 번 등록할 수 없습니다.' };
    Object.defineProperty(emotions, name, { value: n, enumerable: true, configurable: true, writable: true });
  }
  if (Object.keys(emotions).length > 50) return { error: '표정은 최대 50개 등록할 수 있습니다.' };
  const defaultEmotion = draft.defaultEmotion.trim();
  if (defaultEmotion && !Object.prototype.hasOwnProperty.call(emotions, defaultEmotion)) return { error: '시작 표정을 등록한 표정 중에서 다시 선택해 주세요.' };
  return { value: { outfits, emotions, ...(defaultEmotion ? { default_emotion: defaultEmotion } : {}) } };
}
