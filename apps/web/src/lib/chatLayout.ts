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
  return format === 'dialog';
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

/**
 * empty-turn: inject-only 단축어가 남긴 content='' user 행은 화면에 그리지 않는다.
 * 빈 말풍선은 `…` 로 렌더되어 사용자가 빈 메시지를 보낸 것처럼 보이지만 실제로는
 * 지침만 전달된 턴이다. 대체 표시(`…`, `/이름`, 실행 칩)는 두지 않는다 — 명령 실행
 * 흔적은 별도 타입이 필요한 후속 UX 작업이다.
 *
 * assistant 는 대상이 아니다. 스트리밍 중 assistant 는 content='' 로 시작하고 그
 * 자리의 `▍` 커서가 유일한 진행 표시다. 조건은 정확히 role=user 이고 공백뿐인 경우다.
 */
export function isEmptyUserMessage(m: Message): boolean {
  return m.role === 'user' && !m.content.trim();
}

/** 렌더 대상 목록. 서버 경로(chat.messages)는 그대로 두고 표시에서만 뺀다. */
export function visibleChatMessages(messages: Message[]): Message[] {
  return messages.filter((m) => !isEmptyUserMessage(m));
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
 * Mobile dialog display only: body blocks, then INFO/panel.
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
