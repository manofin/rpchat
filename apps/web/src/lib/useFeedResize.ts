import { useLayoutEffect, type RefObject } from 'react';

export function useFeedResize(
  scrollRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
  stickyRef: RefObject<boolean>,
  roomId: string,
  messages: unknown,
) {
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    // Images, font swaps and viewport changes also resize the feed between messages.
    const observer = new ResizeObserver(() => {
      if (stickyRef.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(content, { box: 'border-box' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollRef, contentRef, stickyRef, roomId, messages]);
}
