import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { get, patch } from '../lib/api';
import { back, navigate, useRoute } from '../lib/router';
import { NAV_TABS } from '../lib/navTabs';
import type { Character, Conversation, ConversationDetail, Health, Message, ModelProfile, Persona, PromptPreview, Summary } from '../types';
import {
  Avatar, BeatHeader, BeatHunterLine, BeatHunterPanel, BeatInfoSheet, BeatNarration, BeatSystem, BeatThought, BeatUiPanel, parseBeatUi,
  renderContent, SpeakerHeader,
} from '../components/view';
import { OverlayDrawer } from '../components/OverlayDrawer';
import { BottomSheet, Spinner, useUi } from '../components/ui';
import { groupChatTurns, shouldReorderTurn, turnChoicesHost, visualAssistantOrder } from '../lib/chatLayout';
import { useDesktopLayout } from '../lib/useDesktopLayout';
import { useChat } from './useChat';
import { ChatDrawer } from './ChatDrawer';
import { ChatListRail } from './ChatListRail';
import { ConversationTools } from './ConversationTools';

export function ChatPage({ id }: { id: string }) {
  const ui = useUi();
  const chat = useChat(id);
  const [draft, setDraft] = useState('');
  const [drawer, setDrawer] = useState(false);
  const [drawerTab, setDrawerTab] = useState<'budget' | 'memory' | 'summary' | undefined>(undefined);
  const [settings, setSettings] = useState(false);
  const desktop = useDesktopLayout();
  const path = useRoute();
  const [listOpen, setListOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(desktop);
  const [previewDropped, setPreviewDropped] = useState<number | null>(null);
  const [previewIncluded, setPreviewIncluded] = useState<number | null>(null);
  const [hasDraft, setHasDraft] = useState(false);
  const [dismissTick, setDismissTick] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const stickyRef = useRef(true);

  // 스크롤 하단 고정 추적
  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickyRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }
  useLayoutEffect(() => {
    if (stickyRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [chat.messages]);

  // 검색 결과 → 해당 메시지로 점프 (/chat/:id?jump=<messageId>)
  const jump = new URLSearchParams(window.location.search).get('jump');
  useEffect(() => {
    if (!jump || chat.loading || chat.messages.length === 0) return;
    const el = document.getElementById(`msg-${jump}`);
    if (el) {
      stickyRef.current = false;
      el.scrollIntoView({ block: 'center' });
      el.classList.add('jump-flash');
      setTimeout(() => el.classList.remove('jump-flash'), 1600);
      navigate(window.location.pathname, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump, chat.loading, chat.messages.length]);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      if (!stickyRef.current) return;
      const el = scrollRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);

  function grow() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(132, ta.scrollHeight)}px`;
  }
  useEffect(grow, [draft]);

  useEffect(() => {
    if (desktop) {
      setListOpen(false);
      return;
    }
    setListOpen(false);
    setToolsOpen(false);
  }, [desktop]);

  // Mobile: left/right overlays are mutually exclusive (StoryForge MobileShell).
  useEffect(() => {
    if (desktop || !listOpen) return;
    setToolsOpen(false);
  }, [listOpen, desktop]);
  useEffect(() => {
    if (desktop || !toolsOpen) return;
    setListOpen(false);
  }, [toolsOpen, desktop]);

  const headId = chat.messages[chat.messages.length - 1]?.id ?? '';
  const dropped = chat.budgetAtHead === headId && chat.lastBudget
    ? chat.lastBudget.dropped_messages
    : (previewDropped ?? 0);
  const included = chat.budgetAtHead === headId && chat.lastBudget
    ? chat.lastBudget.included_messages
    : (previewIncluded ?? 0);

  useEffect(() => {
    if (chat.generating || chat.loading || !headId) return;
    if (chat.budgetAtHead === headId) {
      setPreviewDropped(null);
      setPreviewIncluded(null);
      return;
    }
    let cancelled = false;
    get<PromptPreview>(`/api/conversations/${id}/prompt-preview`)
      .then((p) => {
        if (cancelled) return;
        setPreviewDropped(p.budget.dropped_messages);
        setPreviewIncluded(p.budget.included_messages);
      })
      .catch(() => {
        if (cancelled) return;
        setPreviewDropped(null);
        setPreviewIncluded(null);
      });
    return () => { cancelled = true; };
  }, [id, headId, chat.generating, chat.loading, chat.budgetAtHead]);

  /** 최종 트리거: dropped_messages > 0 만. TEMP observe 해제. */
  const TEMP_MIN_INCLUDED: number | null = null;
  const triggered = dropped > 0 || (TEMP_MIN_INCLUDED != null && included > TEMP_MIN_INCLUDED);

  useEffect(() => {
    if (chat.generating || chat.loading || !triggered) {
      setHasDraft(false);
      return;
    }
    let cancelled = false;
    get<Summary[]>(`/api/conversations/${id}/summaries`)
      .then((rows) => { if (!cancelled) setHasDraft(rows.some((s) => s.status !== 'approved')); })
      .catch(() => { if (!cancelled) setHasDraft(false); });
    return () => { cancelled = true; };
  }, [id, triggered, chat.generating, chat.loading]);

  const suggestSuppressed = dismissTick >= 0 && !!headId && suggestIsSuppressed(id, headId, dropped);
  const showSuggest = !chat.generating && !chat.loading && triggered && !suggestSuppressed;

  async function submit() {
    const text = draft.trim();
    if (!text || chat.generating) return;
    setDraft('');
    requestAnimationFrame(grow);
    stickyRef.current = true;
    await chat.send(text);
  }

  if (chat.loading) return <div className="screen"><div className="topbar"><button className="btn ghost icon" onClick={() => back('/')}>‹</button></div><Spinner /></div>;
  if (chat.error && !chat.detail) return <div className="screen"><div className="topbar"><button className="btn ghost icon" onClick={() => back('/')}>‹</button></div><div className="content"><div className="banner err">{chat.error}</div></div></div>;

  const conv = chat.detail!.conversation;
  const char = chat.detail!.character;
  const persona = chat.detail!.persona;
  const lastAssistant = [...chat.messages].reverse().find((m) => m.role === 'assistant');
  const lastMsg = chat.messages[chat.messages.length - 1];

  const reorderTurns = !desktop && shouldReorderTurn(conv.scene.format);
  const onChoice = (c: string) => { setDraft(c); taRef.current?.focus(); };
  const messageViewProps = (m: Message, opts?: { hideChoices?: boolean }) => ({
    m,
    domId: `msg-${m.id}`,
    charName: char.name,
    userName: persona?.name ?? '나',
    sceneFormat: conv.scene.format,
    streaming: chat.streamingId === m.id,
    isLastAssistant: m.id === lastAssistant?.id,
    generating: chat.generating,
    hideChoices: opts?.hideChoices,
    onRegenerate: () => chat.regenerate(m.id),
    onSwipeLeft: () => { const i = m.siblings.index; if (i > 0) chat.selectSibling(m.siblings.ids[i - 1]); },
    onSwipeRight: () => { const i = m.siblings.index; if (i < m.siblings.count - 1) chat.selectSibling(m.siblings.ids[i + 1]); else chat.regenerate(m.id); },
    onEdit: (content: string) => chat.editMessage(m.id, content),
    onBranchEdit: (content: string) => chat.branchEdit(m.id, content),
    onDelete: async () => { if (await ui.confirm('이 메시지를 삭제할까요?', { danger: true, okLabel: '삭제' })) chat.deleteMessage(m.id); },
    onBookmark: () => chat.toggleBookmark(m.id, !m.bookmarked),
    onChoice,
  });

  return (
    <div className="chat-shell">
      <OverlayDrawer
        open={desktop ? true : listOpen}
        onClose={() => setListOpen(false)}
        side="left"
        mode={desktop ? 'rail' : 'overlay'}
        title="대화"
      >
        {!desktop && (
          <nav className="drawer-nav" aria-label="주요 메뉴">
            {NAV_TABS.map((tab) => {
              const active = tab.match(path);
              return (
                <button
                  key={tab.href}
                  type="button"
                  className={`drawer-nav-item${active ? ' is-active' : ''}`}
                  onClick={() => {
                    setListOpen(false);
                    navigate(tab.href);
                  }}
                >{tab.label}</button>
              );
            })}
          </nav>
        )}
        {desktop ? <div className="chat-rail-head">대화</div> : <div className="drawer-section-label">이 캐릭터의 대화</div>}
        <ChatListRail characterId={char.id} activeId={id} onPick={() => setListOpen(false)} />
      </OverlayDrawer>

      <div className="chat-main">
      <div className="topbar chat-topbar">
        <button className="btn ghost icon chat-menu-btn" onClick={() => setListOpen(true)} aria-label="대화 목록 열기" aria-expanded={listOpen}>☰</button>
        <button className="btn ghost icon chat-back-btn" onClick={() => back(`/character/${char.id}`)} aria-label="뒤로">‹</button>
        <Avatar name={char.name} avatar={char.avatar} size="sm" />
        <div className="title" onClick={() => setToolsOpen(true)} style={{ cursor: 'pointer' }}>
          <h1>{char.name}</h1>
          <div className="sub">{conv.profile_name} · {persona?.name ?? '나'}</div>
        </div>
        {/* P5-R1: 인스펙터는 이미 드로어에 있다 — 없던 것은 '여기로 들어간다'는 표시. 새 표면 추가 금지. */}
        <button
          className="btn ghost sm chat-ci-btn"
          data-test="context-inspector"
          aria-label="컨텍스트 인스펙터 열기"
          onClick={() => { setDrawerTab('budget'); setDrawer(true); }}
        >▤ 컨텍스트</button>
        <button
          className="btn ghost icon chat-tools-btn"
          data-test="chat-tools"
          aria-label="대화 도구 열기"
          aria-expanded={toolsOpen}
          onClick={() => setToolsOpen((v) => !v)}
        >{desktop ? '⚙' : '⋯'}</button>
      </div>

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {chat.messages.length === 0 && <div className="sysline" style={{ margin: 'auto' }}>첫 메시지를 보내 대화를 시작하세요.</div>}
        {reorderTurns
          ? groupChatTurns(chat.messages).map((turn, ti) => {
              const visual = visualAssistantOrder(turn.assistants, true);
              const host = turnChoicesHost(turn.assistants);
              const showTurnChoices = !!(host && host.id === lastAssistant?.id && host.meta.choices && host.meta.choices.length > 0 && !chat.generating);
              return (
                <div key={turn.user?.id ?? visual[0]?.id ?? `turn-${ti}`} className="chat-turn">
                  {turn.user ? <MessageView {...messageViewProps(turn.user)} /> : null}
                  {visual.map((m) => <MessageView key={m.id} {...messageViewProps(m, { hideChoices: true })} />)}
                  {showTurnChoices && host?.meta.choices ? <ChoiceChips choices={host.meta.choices} onChoice={onChoice} /> : null}
                </div>
              );
            })
          : chat.messages.map((m) => (
            <MessageView key={m.id} {...messageViewProps(m)} />
          ))}
        {chat.error && chat.detail && <div className="banner err" style={{ margin: '4px 0' }}>{chat.error}</div>}
      </div>

      {/* 기존 sysline 슬롯: 응답 이어가기 + 요약 제안 (키보드/스크롤 경로 비변경) */}
      {(() => {
        const needReply = !chat.generating && lastMsg?.role === 'user';
        if (!needReply && !showSuggest) return null;
        return (
          <div className="sysline" style={{ padding: '6px 0' }}>
            {needReply && (
              <button className="btn sm primary" onClick={() => chat.regenerate(lastMsg.id)}>↻ {char.name}의 응답 생성</button>
            )}
            {showSuggest && (
              <div className="row" style={{ justifyContent: 'center', flexWrap: 'wrap', marginTop: needReply ? 6 : 0 }}>
                <span>{hasDraft ? '요약 초안이 있습니다.' : '최근 대화가 컨텍스트 창을 넘었습니다.'}</span>
                <button
                  className="btn sm ghost"
                  onClick={() => {
                    suppressSuggest(id, headId, dropped);
                    setDismissTick((n) => n + 1);
                  }}
                >나중에</button>
                <button
                  className="btn sm primary"
                  onClick={() => {
                    setDrawerTab('summary');
                    setDrawer(true);
                  }}
                >요약하기</button>
              </div>
            )}
          </div>
        );
      })()}

      <div className="inputbar">
        {chat.generating ? (
          <button className="btn danger block" onClick={chat.stop}>■ 생성 중단</button>
        ) : (
          <>
            <textarea
              ref={taRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={`${char.name}에게 메시지…`}
              rows={1}
              enterKeyHint="send"
            />
            <button className="btn primary icon" onClick={submit} disabled={!draft.trim()} aria-label="보내기">↑</button>
          </>
        )}
      </div>

      <ChatDrawer open={drawer} conversationId={id} draft={draft} initialTab={drawerTab} onClose={() => { setDrawer(false); setDrawerTab(undefined); }} onApplied={() => { /* 미리보기는 열 때마다 재계산 */ }} />
      <ConversationSettings open={settings} conversationId={id} onClose={() => setSettings(false)} onChanged={chat.reload} onOpenMemory={() => { setSettings(false); setDrawerTab(undefined); setDrawer(true); }} />
      </div>

      <OverlayDrawer
        open={toolsOpen}
        onClose={() => setToolsOpen(false)}
        side="right"
        mode={desktop ? 'rail' : 'overlay'}
        title="세계관 인스펙터"
      >
        <ConversationTools conversationId={id} onChanged={chat.reload} />
      </OverlayDrawer>
    </div>
  );
}

function ChoiceChips({ choices, onChoice }: { choices: string[]; onChoice: (c: string) => void }) {
  return (
    <div className="chips">
      {choices.map((c, i) => (
        <button key={i} type="button" className="chip" onClick={() => onChoice(c)}>{c}</button>
      ))}
    </div>
  );
}

function MessageView(props: {
  m: Message;
  charName: string;
  userName: string;
  sceneFormat?: 'beat' | 'dialog' | 'hunter';
  streaming: boolean;
  isLastAssistant: boolean;
  generating: boolean;
  domId?: string;
  onRegenerate: () => void;
  onSwipeLeft: () => void;
  onSwipeRight: () => void;
  onEdit: (c: string) => void;
  onBranchEdit: (c: string) => void;
  onDelete: () => void;
  onBookmark: () => void;
  onChoice: (c: string) => void;
  hideChoices?: boolean;
}) {
  const { m } = props;
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(m.content);
  const isUser = m.role === 'user';
  const touch = useRef<{ x: number; y: number } | null>(null);
  const [dragX, setDragX] = useState(0);
  const hasSiblings = m.siblings.count > 1;
  const canDrag = m.role === 'assistant' && !props.generating && !props.streaming && (hasSiblings || props.isLastAssistant);

  function onTouchStart(e: React.TouchEvent) {
    if (!canDrag) return;
    touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
  function onTouchMove(e: React.TouchEvent) {
    if (!touch.current || !canDrag) return;
    const dx = e.touches[0].clientX - touch.current.x;
    const dy = e.touches[0].clientY - touch.current.y;
    if (Math.abs(dy) > Math.abs(dx)) {
      setDragX(0);
      return;
    }
    // 거의 안 움직이면 롱프레스 복사에 넘김 (말풍선을 밀지 않음)
    if (Math.abs(dx) < 12) {
      setDragX(0);
      return;
    }
    let damped = dx * 0.4;
    // dx<0 = 이전(형제 있을 때만). 첫 형제/단독에서 왼쪽은 저항.
    if (damped < 0 && m.siblings.index === 0) damped *= 0.3;
    setDragX(Math.max(-60, Math.min(60, damped)));
  }
  function onTouchEnd(e: React.TouchEvent) {
    if (!touch.current || !canDrag) {
      touch.current = null;
      setDragX(0);
      return;
    }
    const dx = e.changedTouches[0].clientX - touch.current.x;
    const dy = e.changedTouches[0].clientY - touch.current.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) {
        if (m.siblings.index > 0) props.onSwipeLeft();
      } else {
        props.onSwipeRight();
      }
    }
    touch.current = null;
    setDragX(0);
  }
  function onTouchCancel() {
    touch.current = null;
    setDragX(0);
  }

  if (editing) {
    return (
      <div className={`msg ${isUser ? 'user' : 'assistant'}`} style={{ maxWidth: '100%', width: '100%' }}>
        <textarea value={val} onChange={(e) => setVal(e.target.value)} style={{ width: '100%', minHeight: 90, background: 'var(--bg-2)', border: '1px solid var(--accent-2)', borderRadius: 12, padding: 10 }} autoFocus />
        <div className="row end" style={{ gap: 6, marginTop: 6 }}>
          <button className="btn sm ghost" onClick={() => { setEditing(false); setVal(m.content); }}>취소</button>
          <button className="btn sm" onClick={() => { props.onEdit(val); setEditing(false); }}>저장만</button>
          {isUser
            ? <button className="btn sm primary" onClick={() => { setEditing(false); props.onBranchEdit(val); }}>저장 후 재생성</button>
            : <button className="btn sm primary" onClick={() => { props.onEdit(val); setEditing(false); }}>저장</button>}
        </div>
      </div>
    );
  }

  // f9-swap-passes: a beat row renders as its §6 slot. A message with no
  // `block_kind` — every 1:1 message, and everything written before the beat
  // engine — falls through to the ordinary bubble below, untouched.
  const kind = m.meta.block_kind;
  if (!isUser && kind && kind !== 'line') {
    let body: ReactNode = null;
    if (kind === 'header') body = <BeatHeader text={m.content} />;
    else if (kind === 'info') body = <BeatInfoSheet text={m.content} />;
    else if (kind === 'panel') body = <BeatHunterPanel text={m.content} />;
    else if (kind === 'system') body = <BeatSystem text={m.content} />;
    else if (kind === 'narration') body = <BeatNarration text={m.content} variant={props.sceneFormat === 'hunter' ? 'hunter' : undefined} />;
    else if (kind === 'thought') body = <BeatThought name={m.meta.speaker_name ?? props.charName} text={m.content} />;
    else { const ui = parseBeatUi(m.content); body = ui ? <BeatUiPanel ui={ui} /> : null; }
    // dialog-format: choices ride on whichever block a turn actually ends on
    // (narration or a speaker's line), not just the `line` kind — see chat.ts
    // generateDialog. The chip row below is otherwise identical to the 1:1 one.
    return (
      <>
        {body}
        {!props.hideChoices && !props.streaming && props.isLastAssistant && m.meta.choices && m.meta.choices.length > 0 && (
          <div className="chips">
            {m.meta.choices.map((c, i) => <button key={i} className="chip" onClick={() => props.onChoice(c)}>{c}</button>)}
          </div>
        )}
      </>
    );
  }

  // hunter-format: a `line` is a `💬 이름│대사` script row, not a chat bubble.
  // Gated on scene.format so beat/dialog keep SpeakerHeader + bubble.
  if (!isUser && kind === 'line' && props.sceneFormat === 'hunter') {
    return (
      <>
        <BeatHunterLine name={m.meta.speaker_name ?? props.charName} text={m.content} />
        {!props.hideChoices && !props.streaming && props.isLastAssistant && m.meta.choices && m.meta.choices.length > 0 && (
          <div className="chips">
            {m.meta.choices.map((c, i) => <button key={i} className="chip" onClick={() => props.onChoice(c)}>{c}</button>)}
          </div>
        )}
      </>
    );
  }

  const showActions = !props.streaming;
  return (
    <div id={props.domId} className={`msg ${isUser ? 'user' : 'assistant'} ${m.meta.ooc ? 'ooc' : ''}`}>
      {!isUser && m.meta.speaker_character_id ? (
        <SpeakerHeader name={m.meta.speaker_name ?? props.charName} avatar={m.meta.image_url ?? m.meta.speaker_avatar} />
      ) : null}
      <div
        className={`bubble ${m.status === 'interrupted' ? 'interrupted' : ''} ${m.status === 'error' ? 'error' : ''}`}
        style={{
          transform: dragX ? `translateX(${dragX}px)` : undefined,
          transition: dragX ? 'none' : 'transform 0.2s ease-out',
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
      >
        {m.content ? renderContent(m.content) : props.streaming ? '' : <span className="muted">…</span>}
        {props.streaming && <span className="cursor" />}
        {m.status === 'error' && <div className="small" style={{ color: 'var(--danger)', marginTop: 6 }}>{m.meta.error ?? '생성 실패'}</div>}
        {m.status === 'interrupted' && <div className="small muted" style={{ marginTop: 4 }}>(중단됨)</div>}
      </div>

      {/* 스토리 선택지: 최신 assistant 턴에서만 노출 — 다음 턴이 시작되면 이전 선택지는 사라진다 */}
      {!props.hideChoices && !props.streaming && props.isLastAssistant && m.meta.choices && m.meta.choices.length > 0 && (
        <div className="chips">
          {m.meta.choices.map((c, i) => <button key={i} className="chip" onClick={() => props.onChoice(c)}>{c}</button>)}
        </div>
      )}

      {showActions && (
        <div className="msg-meta">
          {m.role === 'assistant' && m.siblings.count > 1 && (
            <span className="swipe">
              <button onClick={props.onSwipeLeft} disabled={m.siblings.index === 0} aria-label="이전 응답">‹</button>
              {m.siblings.index + 1}/{m.siblings.count}
              <button onClick={props.onSwipeRight} aria-label="다음 응답">›</button>
            </span>
          )}
          {m.role === 'assistant' && props.isLastAssistant && <button onClick={props.onRegenerate}>↻ 재생성</button>}
          <button onClick={() => { setVal(m.content); setEditing(true); }}>✎ 편집</button>
          <button onClick={props.onBookmark}>{m.bookmarked ? '★' : '☆'}</button>
          <button onClick={props.onDelete}>🗑</button>
          {m.meta.usage?.completion_tokens ? <span className="muted">{m.meta.usage.completion_tokens}t</span> : null}
        </div>
      )}
    </div>
  );
}

function ConversationSettings({ open, conversationId, onClose, onChanged, onOpenMemory }: { open: boolean; conversationId: string; onClose: () => void; onChanged: () => void; onOpenMemory: () => void }) {
  const ui = useUi();
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [conv, setConv] = useState<Conversation | null>(null);
  const [character, setCharacter] = useState<Character | null>(null);
  const [persona, setPersona] = useState<Persona | null>(null);
  const [promptVersion, setPromptVersion] = useState('');
  const [view, setView] = useState<'main' | 'guide' | 'profiles'>('main');
  const [personaList, setPersonaList] = useState<Persona[]>([]);

  useEffect(() => {
    if (!open) return;
    setView('main');
    get<ModelProfile[]>('/api/profiles').then(setProfiles);
    get<Health>('/api/health').then((h) => setPromptVersion(h.promptVersion)).catch(() => {});
    get<ConversationDetail>(`/api/conversations/${conversationId}`).then((d) => { setConv(d.conversation); setCharacter(d.character); setPersona(d.persona); });
  }, [open, conversationId]);

  useEffect(() => {
    if (!open || view !== 'profiles') return;
    get<Persona[]>('/api/personas').then(setPersonaList).catch(() => setPersonaList([]));
  }, [open, view]);

  async function save(patchBody: Record<string, unknown>) {
    await patch(`/api/conversations/${conversationId}`, patchBody);
    onChanged();
  }

  async function pickPersona(p: Persona) {
    if (!conv) return;
    const current = conv.persona_id ?? personaList.find((x) => x.is_default)?.id;
    if (p.id === current) return;
    try {
      await patch(`/api/conversations/${conversationId}`, { personaId: p.id });
      setConv({ ...conv, persona_id: p.id });
      onChanged();
    } catch {
      ui.toast('페르소나 선택 실패');
      get<Persona[]>('/api/personas').then(setPersonaList).catch(() => {});
    }
  }

  if (!conv || !character) return <BottomSheet open={open} onClose={onClose}><div className="sheet-body"><div className="muted small">불러오는 중…</div></div></BottomSheet>;

  if (view === 'guide') {
    const guide = [character.description, character.personality, character.speech_style, character.taboos]
      .map((s) => (s ?? '').trim())
      .filter(Boolean)
      .join('\n\n') || '(작성된 가이드 없음)';
    return (
      <BottomSheet open={open} onClose={onClose}>
        <div className="sheet-body">
          <strong>플레이 가이드</strong>
          <div style={{ maxHeight: 320, overflowY: 'auto', whiteSpace: 'pre-wrap', margin: '12px 0', fontSize: 14, lineHeight: 1.6 }}>{guide}</div>
          <button className="btn primary block" onClick={() => setView('main')}>확인</button>
        </div>
      </BottomSheet>
    );
  }

  if (view === 'profiles') {
    return (
      <BottomSheet open={open} onClose={onClose}>
        <div className="sheet-body">
          <strong>대화 프로필</strong>
          <div className="small muted" style={{ marginTop: 4 }}>추가·수정·삭제는 설정 → 페르소나. 사용 중인 페르소나는 삭제 시 409.</div>
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {personaList.map((p) => {
              const isCurrent = p.id === conv.persona_id || (conv.persona_id == null && p.is_default);
              return (
                <button
                  key={p.id}
                  className={`btn ${isCurrent ? 'primary' : ''} block`}
                  style={{ textAlign: 'left', whiteSpace: 'normal' }}
                  onClick={() => pickPersona(p)}
                >
                  {p.name}{isCurrent ? ' · 현재' : ''}
                  {(p.relationship || p.personality) && (
                    <span className="small muted" style={{ display: 'block', fontWeight: 400 }}>{(p.relationship || p.personality).slice(0, 60)}</span>
                  )}
                </button>
              );
            })}
            {personaList.length === 0 && <div className="muted small">페르소나 없음</div>}
          </div>
          <button className="btn sm block" style={{ marginTop: 12 }} onClick={() => navigate('/settings')}>설정에서 편집</button>
          <button className="btn ghost block" style={{ marginTop: 6 }} onClick={() => setView('main')}>뒤로</button>
        </div>
      </BottomSheet>
    );
  }

  const sceneLine = Object.entries(conv.scene)
    .filter(([, v]) => typeof v === 'string' && v.trim())
    .map(([k, v]) => `${k}:${v}`)
    .join(' · ');

  return (
    <BottomSheet open={open} onClose={onClose}>
      <div className="sheet-body">
        <div className="row" style={{ alignItems: 'center', gap: 10 }}>
          <Avatar name={character.name} avatar={character.avatar} size="sm" />
          <div>
            <strong>{character.name}</strong>
            {character.tagline && <div className="small muted">{character.tagline}</div>}
          </div>
        </div>

        <div className="small muted" style={{ marginTop: 16 }}>채팅방 설정</div>
        <button className="btn sm block" style={{ marginTop: 8 }} onClick={() => setView('guide')}>플레이 가이드</button>
        <button className="btn sm block" style={{ marginTop: 6 }} onClick={() => setView('profiles')}>대화 프로필: {persona?.name ?? '나'}{!conv.persona_id ? ' (기본)' : ''}</button>
        <div className="field" style={{ marginTop: 10 }}>
          <label>유저노트</label>
          <span className="hint">미구현 (별도 잠금)</span>
        </div>
        <div className="field">
          <label>최대 출력량</label>
          <select value={conv.profile_name} onChange={(e) => { setConv({ ...conv, profile_name: e.target.value }); save({ profileName: e.target.value }); }}>
            {profiles.filter((p) => p.name.startsWith('rp-')).map((p) => <option key={p.name} value={p.name}>{p.name} · temp {p.temperature} · max {p.max_tokens}</option>)}
          </select>
          <span className="hint">모델 프로필의 max_tokens 를 따릅니다. summary·memory-extract 는 내부 전용입니다.</span>
        </div>
        <button className="btn sm block" style={{ marginTop: 6 }} onClick={onOpenMemory}>요약 메모리</button>

        <div className="small muted" style={{ marginTop: 16 }}>전체 설정</div>
        <div className="field">
          <label>글꼴</label>
          <span className="hint">전역 Kami (변경 없음)</span>
        </div>
        <div className="field">
          <label>상황 이미지 보기</label>
          <span className="hint">미구현 (E1/F3 잠금)</span>
        </div>

        <div className="small muted" style={{ marginTop: 16 }}>시작 설정</div>
        <div className="small" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{character.scenario?.trim() || '(시나리오 없음)'}</div>
        {sceneLine && <div className="small muted" style={{ marginTop: 4 }}>{sceneLine}</div>}

        <div className="small muted" style={{ marginTop: 16 }}>업데이트 정보</div>
        <div className="small" style={{ marginTop: 4 }}>프롬프트 {promptVersion || '…'}</div>

        <div className="row" style={{ gap: 8, marginTop: 12 }}>
          <a className="btn sm block" href={`/api/conversations/${conversationId}/export?format=md`} target="_blank" rel="noreferrer">MD 내보내기</a>
          <a className="btn sm block" href={`/api/conversations/${conversationId}/export?format=json`} target="_blank" rel="noreferrer">JSON 내보내기</a>
        </div>
      </div>
    </BottomSheet>
  );
}

function suggestKey(convId: string, headId: string): string {
  return `rpchat.summarySuggest.${convId}.${headId}`;
}

function suggestIsSuppressed(convId: string, headId: string, dropped: number): boolean {
  try {
    const raw = sessionStorage.getItem(suggestKey(convId, headId));
    if (raw == null) return false;
    const n = Number(raw);
    return Number.isFinite(n) && dropped <= n;
  } catch {
    return false;
  }
}

function suppressSuggest(convId: string, headId: string, dropped: number): void {
  try {
    sessionStorage.setItem(suggestKey(convId, headId), String(dropped));
  } catch {
    /* private mode */
  }
}
