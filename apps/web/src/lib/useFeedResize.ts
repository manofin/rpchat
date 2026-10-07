import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { trackFeedPosition } from './feedPosition';

export function useFeedResize(
  scrollRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
  stickyRef: RefObject<boolean>,
  roomId: string,
  messages: unknown,
  ready = true,
  restore = true,
) {
  const tracker = useRef<ReturnType<typeof trackFeedPosition> | null>(null);
  const [atLatest, setAtLatest] = useState(true);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!ready || !el || !content) return;
    // Access itself can throw in restricted/private browser contexts.
    const storage = {
      getItem: (key: string) => window.localStorage.getItem(key),
      setItem: (key: string, value: string) => window.localStorage.setItem(key, value),
    };
    const current = trackFeedPosition(el, stickyRef, roomId, storage, setAtLatest, restore);
    tracker.current = current;
    el.addEventListener('scroll', current.onScroll, { passive: true });
    // Images, font swaps and viewport changes also resize the feed between messages.
    const observer = new ResizeObserver(() => {
      current.refresh();
    });
    observer.observe(content, { box: 'border-box' });
    observer.observe(el);
    window.visualViewport?.addEventListener('resize', current.refresh);
    window.addEventListener('pagehide', current.save);
    return () => {
      current.save();
      el.removeEventListener('scroll', current.onScroll);
      observer.disconnect();
      window.visualViewport?.removeEventListener('resize', current.refresh);
      window.removeEventListener('pagehide', current.save);
      tracker.current = null;
    };
  }, [scrollRef, contentRef, stickyRef, roomId, ready]);
  useLayoutEffect(() => { tracker.current?.refresh(); }, [messages]);
  return { atLatest, jumpLatest: () => tracker.current?.jumpLatest() };
}
