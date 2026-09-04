import type { Message } from '../types';

/** Rails vs overlay. Matches Tailwind `md` used by the StoryForge reference. */
export const DESKTOP_MQ = '(min-width: 768px)';

export function isDesktopLayout(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(DESKTOP_MQ).matches;
}

export function isInfoBlockKind(kind: string | undefined): boolean {
  return kind === 'info' || kind === 'panel';
}

export function shouldReorderTurn(format: string | undefined): boolean {
  return format === 'hunter' || format === 'dialog';
}

/**
 * What a keydown inside an open overlay drawer should do.
 *
 * Split out of `OverlayDrawer` so the trap is checkable without a DOM: the
 * component keeps only the plumbing (query the focusables, move focus), and every
 * rule that decides *whether* focus may leave lives here, where a bench can
 * enumerate it. `activeIndex` is the focused node's position among the panel's
 * focusables, or -1 when focus has escaped the panel entirely — which is the case
 * a backdrop click leaves behind, and the one an `=== first || === last` check
 * silently lets through.
 */
export type DrawerKeyAction =
  | { type: 'close' }
  /** Tab with nothing focusable inside: swallow it rather than let focus escape. */
  | { type: 'block' }
  | { type: 'wrap'; to: 'first' | 'last' }
  /** Not ours — let the browser handle it. */
  | null;

export function drawerKeydown(
  e: { key: string; shiftKey?: boolean },
  ctx: { focusables: number; activeIndex: number },
): DrawerKeyAction {
  if (e.key === 'Escape') return { type: 'close' };
  if (e.key !== 'Tab') return null;
  if (ctx.focusables <= 0) return { type: 'block' };
  if (ctx.activeIndex < 0) return { type: 'wrap', to: e.shiftKey ? 'last' : 'first' };
  if (e.shiftKey && ctx.activeIndex === 0) return { type: 'wrap', to: 'last' };
  if (!e.shiftKey && ctx.activeIndex === ctx.focusables - 1) return { type: 'wrap', to: 'first' };
  return null;
}

export type ChatTurn = {
  user: Message | null;
  assistants: Message[];
};

/** Path order: a user row opens a turn; following assistants belong to it. */
export function groupChatTurns(messages: Message[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let current: ChatTurn = { user: null, assistants: [] };
  const flush = () => {
    if (current.user || current.assistants.length) turns.push(current);
    current = { user: null, assistants: [] };
  };
  for (const m of messages) {
    if (m.role === 'user') {
      flush();
      current.user = m;
    } else {
      current.assistants.push(m);
    }
  }
  flush();
  return turns;
}

/**
 * Mobile hunter/dialog display only: body blocks, then INFO/panel.
 * Persist order is unchanged — this is a view permutation.
 */
export function visualAssistantOrder(assistants: Message[], reorder: boolean): Message[] {
  if (!reorder) return assistants;
  const body: Message[] = [];
  const info: Message[] = [];
  for (const m of assistants) {
    if (isInfoBlockKind(m.meta.block_kind)) info.push(m);
    else body.push(m);
  }
  return [...body, ...info];
}

/** Choices stay on the persist-last assistant, even if INFO is painted after the body. */
export function turnChoicesHost(assistants: Message[]): Message | null {
  if (!assistants.length) return null;
  return assistants[assistants.length - 1];
}
