import React, { useEffect, useId, useRef, type ReactNode } from 'react';
import { drawerKeydown } from '../lib/chatLayout';

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function OverlayDrawer({
  open,
  onClose,
  side,
  mode = 'overlay',
  title,
  labelledBy,
  children,
}: {
  open: boolean;
  onClose: () => void;
  side: 'left' | 'right';
  mode?: 'overlay' | 'rail';
  title?: string;
  labelledBy?: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const label = labelledBy ?? (title ? titleId : undefined);

  useEffect(() => {
    if (mode !== 'overlay' || !open) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const focusStart = closeRef.current ?? panel?.querySelector<HTMLElement>(FOCUSABLE);
    focusStart?.focus();

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Tab') return;
      const nodes = e.key === 'Tab' && panel
        ? [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1)
        : [];
      // Every rule lives in `drawerKeydown`; this only carries it out.
      const action = drawerKeydown(e, {
        focusables: nodes.length,
        activeIndex: nodes.indexOf(document.activeElement as HTMLElement),
      });
      if (!action) return;
      e.preventDefault();
      if (action.type === 'close') onClose();
      else if (action.type === 'wrap') (action.to === 'first' ? nodes[0] : nodes[nodes.length - 1]).focus();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      openerRef.current?.focus?.();
    };
  }, [open, mode, onClose]);

  if (mode === 'rail') {
    return (
      <aside
        className={`chat-rail chat-rail-${side}${open ? '' : ' is-collapsed'}`}
        hidden={!open}
        aria-hidden={!open}
        aria-label={title}
      >
        {children}
      </aside>
    );
  }

  return (
    <div
      className={`overlay-drawer overlay-drawer-${side}${open ? ' is-open' : ''}`}
      aria-hidden={!open}
    >
      <button
        type="button"
        className="overlay-drawer-backdrop"
        tabIndex={open ? 0 : -1}
        aria-label="닫기"
        onClick={onClose}
      />
      <aside
        ref={panelRef}
        className="overlay-drawer-panel"
        role="dialog"
        aria-modal={open}
        aria-labelledby={label}
        {...(!open ? { inert: true } : {})}
      >
        <div className="overlay-drawer-head">
          <h2 id={titleId} className="overlay-drawer-title">{title ?? '메뉴'}</h2>
          <button
            ref={closeRef}
            type="button"
            className="btn ghost icon"
            onClick={onClose}
            aria-label="닫기"
          >✕</button>
        </div>
        <div className="overlay-drawer-body">{children}</div>
      </aside>
    </div>
  );
}
