type ReadingPosition = { latest: boolean; messageId?: string; offset: number; scrollTop: number };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

export function trackFeedPosition(el: HTMLElement, sticky: { current: boolean }, roomId: string,
  storage: Storage, changed: (latest: boolean) => void, restore = true) {
  const key = `rpchat:reading:${roomId}`;
  let position: ReadingPosition = { latest: true, offset: 0, scrollTop: 0 };
  try {
    const saved = JSON.parse(storage.getItem(key) || 'null');
    if (restore && saved && typeof saved.latest === 'boolean' && Number.isFinite(saved.offset) && Number.isFinite(saved.scrollTop)
      && (saved.messageId === undefined || typeof saved.messageId === 'string')) position = saved;
  } catch { /* Reading remains usable when storage is unavailable. */ }
  sticky.current = position.latest;
  const rows = () => Array.from(el.querySelectorAll<HTMLElement>('[id^="msg-"]'));
  const persist = () => { try { storage.setItem(key, JSON.stringify(position)); } catch { /* Optional device-local position. */ } };
  let layout = { height: el.scrollHeight, viewport: el.clientHeight, width: el.clientWidth };
  const capture = () => {
    const top = el.getBoundingClientRect().top;
    const row = rows().find(node => node.getBoundingClientRect().bottom > top + 1);
    position = { latest: sticky.current, messageId: row?.id, offset: row ? row.getBoundingClientRect().top - top : 0, scrollTop: el.scrollTop };
    layout = { height: el.scrollHeight, viewport: el.clientHeight, width: el.clientWidth };
    persist();
    changed(sticky.current);
  };
  const refresh = () => {
    if (sticky.current) el.scrollTop = el.scrollHeight;
    else {
      const anchor = rows().find(node => node.id === position.messageId);
      if (anchor) el.scrollTop += anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - position.offset;
      else el.scrollTop = position.scrollTop;
    }
    capture();
  };
  const onScroll = () => {
    // Font/image layout can dispatch scroll before ResizeObserver. Keep the old anchor.
    if (layout.height !== el.scrollHeight || layout.viewport !== el.clientHeight || layout.width !== el.clientWidth) {
      refresh();
      return;
    }
    sticky.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    capture();
  };
  const jumpLatest = () => { sticky.current = true; refresh(); };
  refresh();
  return { onScroll, refresh, jumpLatest, save: capture };
}
