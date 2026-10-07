import { WhisperRecipients } from '../components/WhisperRecipients';
import { loadAudienceActors, audienceLabel, type AudienceActor } from '../lib/audienceLabels';
import { GenerationStatus } from '../components/GenerationStatus';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { get, patch, post } from '../lib/api';
import { back, navigate, useRoute } from '../lib/router';
import { NAV_TABS } from '../lib/navTabs';
import type { Character, Conversation, ConversationDetail, Health, Message, ModelProfile, Persona, ResponseLength, StoryEnding, Summary } from '../types';
import {
  Avatar, BeatUiPanel, renderContent, SpeakerHeader,
} from '../components/view';
import { OverlayDrawer } from '../components/OverlayDrawer';
import { SceneStatusPanel } from '../components/sceneStatus';
import { resolveSceneAction, type SceneActionIntent } from '../lib/sceneStatusCatalog';
import { BottomSheet, Spinner, useUi } from '../components/ui';
import { visibleChoices } from '../lib/choices';
import { groupChatTurns, isEmptyUserMessage, shouldReorderTurn, turnChoicesHost, visibleChatMessages, visualAssistantOrder } from '../lib/chatLayout';
import { MessageEvents } from '../components/EventRenderer';
import { CharacterPortrait } from '../components/CharacterPortrait';
import { messagePortrait, portraitMessageIds } from '../lib/chatPortraits';
import { useFeedResize } from '../lib/useFeedResize';
import { eventUiData, hasEventContract } from '../lib/chatEvents';
import { expandLeadingShortcut, readShortcuts, resolveShortcutSubmit } from '../lib/shortcutMacro';
import { useDesktopLayout } from '../lib/useDesktopLayout';
import {
  resolveBannerWatermarkId,
  shouldShowSummaryBanner,
  suppressSummaryBanner,
} from '../lib/summaryBanner';
import { shouldRefetchAfterEndError, useEndingSuggestions } from '../lib/endingSuggestion';
import { useChat } from './useChat';
import { useSideMode } from './useSideMode';
import { SideModePanel } from '../components/SideModePanel';
import { ResponseLengthSelect } from '../components/ResponseLengthSelect';
import { buildResponseLengthPatch, continuationTarget, parseSideModeCommand, type SideMode } from '../lib/responseControls';
import { ChatDrawer } from './ChatDrawer';
import { ChatListRail } from './ChatListRail';
import { ConversationTools } from './ConversationTools';
import { outputProfileLabel } from '../lib/conversationSettings';
import { chatModelSubtitle, partyCertainty } from '../lib/modelDisplay';
import { CharacterIntroCard, RosterPortraitStage, shouldShowCharacterIntro } from '../components/ChatFeedImages';
import { rosterPortraitOptions } from '../lib/rosterPortraits';

/** ADR-F8g: snapshot is the reader-visible endings list. Damaged → no picker. */
function parseEndingsSnapshot(raw: string | null | undefined): StoryEnding[] {
  if (!raw) return [];
  try {
    const doc = JSON.parse(raw) as unknown;
    if (!Array.isArray(doc)) return [];
    return doc.filter((e): e is StoryEnding => !!e && typeof e === 'object' && typeof (e as { id?: unknown }).id === 'string');
  } catch {
    return [];
  }
}

export function ChatPage({ id }: { id: string }) {
  const ui = useUi();
  const chat = useChat(id);
  const sideMode = useSideMode(id, chat.messages.at(-1)?.id ?? null);
  const generating = chat.generating || sideMode.generating;
  const [sideOpen, setSideOpen] = useState(false);
  const [sideTab, setSideTab] = useState<SideMode>('summary');
  const [portraitActorId, setPortraitActorId] = useState<string | null>(null);
  useEffect(() => { setSideOpen(false); setSideTab('summary'); setPortraitActorId(null); }, [id]);
  const [draft, setDraft] = useState('');
  const [drawer, setDrawer] = useState(false);
  const [drawerTab, setDrawerTab] = useState<'budget' | 'memory' | 'summary' | undefined>(undefined);
  const [settings, setSettings] = useState(false);
  const desktop = useDesktopLayout();
  const path = useRoute();
  const [listOpen, setListOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(desktop);
  const [summaryRows, setSummaryRows] = useState<Summary[] | null>(null);
  const [summaryTick, setSummaryTick] = useState(0);
  const [dismissTick, setDismissTick] = useState(0);
  const [endingOpen, setEndingOpen] = useState(false);
  const [endingPick, setEndingPick] = useState('');
  const [endingSaving, setEndingSaving] = useState(false);
  const [healthModel, setHealthModel] = useState<string | null | undefined>(undefined);
  const [samplingProfiles, setSamplingProfiles] = useState<ModelProfile[] | null>(null);
  const [profileLoad, setProfileLoad] = useState<'pending' | 'ready' | 'failed'>('pending');

  useEffect(() => {
    let cancelled = false;
    get<Health>('/api/health')
      .then((h) => { if (!cancelled) setHealthModel(h.model.resolvedModel ?? null); })
      .catch(() => { /* keep unknown or the last confirmed name */ });
    get<ModelProfile[]>('/api/profiles')
      .then((rows) => {
        if (cancelled) return;
        setSamplingProfiles(rows);
        setProfileLoad('ready');
      })
      .catch(() => { if (!cancelled) setProfileLoad('failed'); });
    return () => { cancelled = true; };
  }, [id]);

  /** ADR-F8h Slice 4: V3 제안형 엔딩 배너. 강제 잠금 없음, 닫기 가능. */
  const endingBanner = useEndingSuggestions(id, { detail: chat.detail, generating, loading: chat.loading });

  /** 배너에서 확정: 사용자 클릭 + confirm 경유, turnId 포함. */
  async function confirmSuggestedEnding(endingId: string, title: string) {
    const target = endingBanner.visible.find((s) => s.ending_id === endingId);
    if (!target || endingBanner.confirmingId || chat.detail?.conversation.ended_at) return;
    if (!(await ui.confirm(`엔딩 [${title}]에 도달할 수 있습니다. 이 결말로 대화를 완결할까요? 이후에는 메시지를 보낼 수 없습니다.`, { danger: true, okLabel: '완결' }))) return;
    const r = await endingBanner.confirm(target);
    if (r.ok) {
      await chat.reload();
      return;
    }
    if (shouldRefetchAfterEndError(r)) {
      // 409 stale: 턴이 어긋남 — 배너는 닫혔고 최신 제안 재조회 유도.
      ui.toast('대화가 더 진행되어 제안을 새로 확인합니다.', 'err');
      await endingBanner.refresh();
    } else {
      // 403 conditions not met + 기타: 알림 후 배너 닫힘.
      ui.toast(r.message, 'err');
    }
  }

  useEffect(() => { setSummaryRows(null); }, [id]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const stickyRef = useRef(true);
  const contentRef = useRef<HTMLDivElement>(null);
  const { atLatest, jumpLatest } = useFeedResize(scrollRef, contentRef, stickyRef, id, chat.messages, !!chat.detail && !chat.loading, !new URLSearchParams(window.location.search).has('jump'));

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

  useEffect(() => {
    if (generating || chat.loading) return;
    let cancelled = false;
    get<Summary[]>(`/api/conversations/${id}/summaries`)
      .then((rows) => { if (!cancelled) setSummaryRows(rows); })
      .catch(() => { if (!cancelled) setSummaryRows([]); });
    return () => { cancelled = true; };
  }, [id, generating, chat.loading, chat.messages.length, summaryTick]);

  const bannerStorage = sessionBannerKv();
  const bannerLocal = localBannerKv();
  const showSuggest = summaryRows != null && shouldShowSummaryBanner({
    path: chat.messages,
    summaries: summaryRows,
    conversationId: id,
    generating,
    loading: chat.loading,
    storage: bannerStorage,
    localStorage: bannerLocal,
  });
  void dismissTick;
  const hasDraft = summaryRows?.some((s) => s.status !== 'approved') ?? false;

  const [audienceNames, setAudienceNames] = useState<{ room: string; actors: AudienceActor[]; error: boolean } | null>(null);
  const audienceRoom = chat.detail?.conversation.id;
  const audienceSnapshot = chat.detail?.conversation.story_participant_ids_snapshot;
  useEffect(() => {
    if (!chat.detail) return;
    let cancelled = false;
    const detail = chat.detail;
    setAudienceNames(null);
    loadAudienceActors(detail, get).then(actors => {
      if (!cancelled) setAudienceNames({room: detail.conversation.id, actors, error:false});
    }).catch(() => { if (!cancelled) setAudienceNames({room: detail.conversation.id, actors:[], error:true}); });
    return () => { cancelled = true; };
  }, [audienceRoom, audienceSnapshot]);
  const audienceActors = audienceNames?.room === id ? audienceNames.actors : [];
  const [whisperIds, setWhisperIds] = useState('');
  const [choiceDraft, setChoiceDraft] = useState<{ message_id: string; index: number; recipient_ids: string[]; visibility: 'public' | 'private' } | null>(null);
  useEffect(() => { setChoiceDraft(null); setWhisperIds(''); }, [id]);
  async function submit() {
    const original = draft;
    if (generating || chat.detail?.conversation.ended_at) return;
    const command = parseSideModeCommand(draft);
    if (command) {
      setSideTab(command.mode);
      setSideOpen(true);
      setChoiceDraft(null);
      setWhisperIds('');
      setDraft('');
      const accepted = await sideMode.generate(command.mode, command.prompt);
      if (!accepted) setDraft((current) => current === '' ? original : current);
      return;
    }
    const resolved = resolveShortcutSubmit(draft, readShortcuts());
    const text = resolved.content.trim();
    const inject = resolved.inject_instruction;
    // Inject-alone may have empty content; must not fall back to putting command body into content.
    if ((!text && !inject) || generating || chat.detail?.conversation.ended_at) return;
    if (choiceDraft?.visibility === 'private' && !choiceDraft.recipient_ids.length) return;
    setDraft('');
    requestAnimationFrame(grow);
    stickyRef.current = true;
    const choice = choiceDraft ? { message_id: choiceDraft.message_id, index: choiceDraft.index, visibility: choiceDraft.visibility } : undefined;
    const ok = await chat.send(text, choice ? { choice, ...(inject ? { inject_instruction: inject } : {}) } : chat.detail?.conversation.scene?.observation_filter && whisperIds.trim()
      ? { ...(inject ? { inject_instruction: inject } : {}), observation: { visibility: 'private' as const, recipient_ids: whisperIds.split(',').map(x => x.trim()).filter(Boolean) } }
      : inject ? { inject_instruction: inject } : undefined);
    if (ok !== false) setChoiceDraft(null);
    if (ok === false) {
      setDraft((cur) => (cur === '' ? original : cur));
      requestAnimationFrame(grow);
    }
  }

  if (chat.loading) return <div className="screen"><div className="topbar"><button className="btn ghost icon" onClick={() => back('/')}>‹</button></div><Spinner /></div>;
  if (chat.error && !chat.detail) return <div className="screen"><div className="topbar"><button className="btn ghost icon" onClick={() => back('/')}>‹</button></div><div className="content"><div className="banner err">{chat.error}</div></div></div>;

  const conv = chat.detail!.conversation;
  const char = chat.detail!.character;
  const persona = chat.detail!.persona;
  const activeSampling = samplingProfiles?.find((p) => p.name === conv.profile_name);
  const modelSubtitle = chatModelSubtitle({
    resolvedModel: healthModel,
    resolvedKnown: healthModel !== undefined,
    profileName: conv.profile_name,
    profileModel: activeSampling?.model ?? null,
    profileModelState: profileLoad,
    party: partyCertainty(conv),
  });
  const lastAssistant = [...chat.messages].reverse().find((m) => m.role === 'assistant');
  const lastMsg = chat.messages[chat.messages.length - 1];
  const continueFrom = continuationTarget(chat.messages);
  const lastUiEntry = [...chat.messages].reverse()
    .flatMap((message) => {
      const panels = hasEventContract(message) ? [...message.events].reverse().map(eventUiData) : [];
      return panels.map(panel => ({ panel, message }));
    })
    .find(entry => entry.panel !== null) ?? null;
  const lastUi = lastUiEntry?.panel ?? null;
  const rosterPortraits = rosterPortraitOptions(lastUi, lastUiEntry?.message.meta.roster_portraits);
  const selectedPortraitId = rosterPortraits.some(row => row.id === portraitActorId)
    ? portraitActorId
    : rosterPortraits.find(row => row.id === lastUi?.focus_id)?.id ?? rosterPortraits[0]?.id ?? null;
  const hasBeatRoster = Boolean(lastUi?.roster?.length);
  const onSceneIntent = (intent: SceneActionIntent) => {
    const d = resolveSceneAction(intent, id);
    if (d.kind === 'navigate') navigate(d.href);
    else if (d.kind === 'open_context') { setDrawerTab('budget'); setDrawer(true); }
    else if (d.kind === 'retry') void chat.reload();
  };
  // empty-turn: 표시용 목록. 요약 워터마크·배너·스크롤은 서버 경로 그대로 chat.messages 를 쓴다.
  const shownMessages = visibleChatMessages(chat.messages);

  const reorderTurns = !desktop && shouldReorderTurn(conv.scene.format);
  const portraits = portraitMessageIds(chat.messages, reorderTurns);
  const ended = !!conv.ended_at;
  const snapshotEndings = parseEndingsSnapshot(conv.story_endings_snapshot);
  const reachedEnding = ended ? (snapshotEndings.find((e) => e.id === conv.reached_ending_id) ?? null) : null;
  const endingChoices = !ended && conv.story_id ? snapshotEndings : [];
  /** Chip tap → send immediately (StoryForge RecommendationChoices onSend). */
  const onChoice = (c: string) => {
    const text = c.trim();
    if (!text || generating || chat.detail?.conversation.ended_at) return;
    const host = [...(chat.messages ?? [])].reverse().find(m => m.meta.choices?.some(raw => raw.trim() === text));
    if (host?.meta.choices_context?.private_context) {
      setChoiceDraft({ message_id: host.id, index: host.meta.choices!.findIndex(raw => raw.trim() === text), recipient_ids: host.meta.choices_context.recipient_ids, visibility: 'public' });
      setDraft(text);
      requestAnimationFrame(grow);
      return;
    }
    setDraft('');
    requestAnimationFrame(grow);
    stickyRef.current = true;
    setChoiceDraft(null);
    setWhisperIds('');
    void chat.send(text).then((ok) => {
      if (ok === false) {
        setDraft((cur) => (cur === '' ? text : cur));
        requestAnimationFrame(grow);
      }
    });
  };
  /** Pencil → fill composer only; user edits then sends. */
  const onEditChoice = (c: string) => {
    const host = [...(chat.messages ?? [])].reverse().find(m => m.meta.choices?.some(raw => raw.trim() === c.trim()));
    setChoiceDraft(host?.meta.choices_context?.private_context ? { message_id: host.id, index: host.meta.choices!.findIndex(raw => raw.trim() === c.trim()), recipient_ids: host.meta.choices_context.recipient_ids, visibility: 'public' } : null);
    setWhisperIds('');
    setDraft(c);
    requestAnimationFrame(grow);
    taRef.current?.focus();
  };

  /** ADR-F8g E2a/E3a: reader picks one snapshot ending → room locks read-only. */
  async function reachEnding() {
    if (!endingPick || endingSaving || chat.detail?.conversation.ended_at) return;
    if (!(await ui.confirm('이 결말로 대화를 완결할까요? 이후에는 메시지를 보낼 수 없습니다.', { danger: true, okLabel: '완결' }))) return;
    setEndingSaving(true);
    try {
      await post(`/api/conversations/${id}/end`, { endingId: endingPick });
      setEndingOpen(false);
      setEndingPick('');
      await chat.reload();
    } catch (e) {
      ui.toast((e as Error).message, 'err');
    } finally {
      setEndingSaving(false);
    }
  }
  const messageViewProps = (m: Message, opts?: { hideChoices?: boolean }) => ({
    m,
    domId: `msg-${m.id}`,
    charName: char.name,
    audienceText: audienceLabel(m.meta.observation, audienceActors),
    userName: persona?.name ?? '나',
    sceneFormat: conv.scene.format,
    streaming: chat.streamingId === m.id,
    isLastAssistant: m.id === lastAssistant?.id,
    generating,
    hideChoices: opts?.hideChoices,
    showPortrait: portraits.has(m.id),
    onRegenerate: () => chat.regenerate(m.id),
    onSwipeLeft: () => { const i = m.siblings.index; if (i > 0) chat.selectSibling(m.siblings.ids[i - 1]); },
    onSwipeRight: () => { const i = m.siblings.index; if (i < m.siblings.count - 1) chat.selectSibling(m.siblings.ids[i + 1]); else chat.regenerate(m.id); },
    onEdit: (content: string) => chat.editMessage(m.id, content),
    onBranchEdit: (content: string) => chat.branchEdit(m.id, content),
    onDelete: async () => { if (await ui.confirm('이 메시지를 삭제할까요?', { danger: true, okLabel: '삭제' })) chat.deleteMessage(m.id); },
    onBookmark: () => chat.toggleBookmark(m.id, !m.bookmarked),
    onChoice,
    onEditChoice,
    focusId: conv.scene.last_beat?.focus_id ?? null,
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
        {desktop ? (
          <>
            <div className="chat-rail-head">최근 전체 대화</div>
            <ChatListRail activeId={id} onPick={() => setListOpen(false)} />
            <div className="chat-rail-head">이 캐릭터의 대화</div>
            <ChatListRail characterId={char.id} activeId={id} onPick={() => setListOpen(false)} />
          </>
        ) : (
          <>
            <div className="drawer-section-label">이 캐릭터의 대화</div>
            <ChatListRail characterId={char.id} activeId={id} onPick={() => setListOpen(false)} />
          </>
        )}
      </OverlayDrawer>

      <div className="chat-main">
      <div className="topbar chat-topbar">
        <button className="btn ghost icon chat-menu-btn" onClick={() => setListOpen(true)} aria-label="대화 목록 열기" aria-expanded={listOpen}>☰</button>
        <button className="btn ghost icon chat-back-btn" onClick={() => back(`/character/${char.id}`)} aria-label="뒤로">‹</button>
        <Avatar name={char.name} avatar={char.avatar} size="sm" />
        <div className="title" onClick={() => setToolsOpen(true)} style={{ cursor: 'pointer' }}>
          <h1>{char.name}</h1>
          <div className="sub chat-model-sub" data-test="chat-model-subtitle">{modelSubtitle}</div>
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

      {!desktop ? (
        <SceneStatusPanel
          conversationId={id}
          scene={conv.scene}
          places={chat.detail!.scene_places}
          characterName={char.name}
          roster={lastUi?.roster}
          hasBeatRoster={hasBeatRoster}
          focusId={lastUi?.focus_id ?? conv.scene.last_beat?.focus_id ?? null}
          generating={generating}
          loadError={chat.error}
          conversationEnded={ended}
          placement="mobile"
          onIntent={onSceneIntent}
        />
      ) : null}

      {(() => {
        if (!lastUi?.roster?.length) return null;
        const live = { ...lastUi, focus_id: lastUi.focus_id ?? conv.scene.last_beat?.focus_id ?? null };
        const selectable = new Map(rosterPortraits.map(row => [row.id, row.image_url]));
        return (
          <div className="cast-status" aria-label="캐스트">
            <BeatUiPanel ui={{ roster: (live.roster ?? []).map(row => ({ ...row, image_url: selectable.get(row.id) ?? null })), focus_id: live.focus_id }} selectedRosterId={selectedPortraitId} onRosterSelect={setPortraitActorId} />
          </div>
        );
      })()}

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-feed" ref={contentRef}>
        {shouldShowCharacterIntro(conv.story_id, shownMessages.length) ? <CharacterIntroCard key={char.id} character={char} /> : null}
        <RosterPortraitStage options={rosterPortraits} selectedId={selectedPortraitId} onSelect={setPortraitActorId} />
        {shownMessages.length === 0 && <div className="sysline" style={{ margin: 'auto' }}>첫 메시지를 보내 대화를 시작하세요.</div>}
        {reorderTurns
          ? groupChatTurns(shownMessages).map((turn, ti) => {
              const visual = visualAssistantOrder(turn.assistants, true);
              const host = turnChoicesHost(turn.assistants);
              const showTurnChoices = !!(host && host.id === lastAssistant?.id && host.meta.choices && host.meta.choices.length > 0 && !generating);
              return (
                <div key={turn.user?.id ?? visual[0]?.id ?? `turn-${ti}`} className="chat-turn">
                  {turn.user ? <MessageView {...messageViewProps(turn.user)} /> : null}
                  {visual.map((m) => <MessageView key={m.id} {...messageViewProps(m, { hideChoices: true })} />)}
                  {showTurnChoices && host?.meta.choices ? <ChoiceChips choices={host.meta.choices} onChoice={onChoice} onEdit={onEditChoice} disabled={generating} /> : null}
                </div>
              );
            })
          : shownMessages.map((m) => (
            <MessageView key={m.id} {...messageViewProps(m)} />
          ))}
        {chat.error && chat.detail && <div className="banner err" style={{ margin: '4px 0' }}>{chat.errorCode ? `${{ connection: '연결 실패', timeout: '시간 초과', model_timeout: '모델 시간 초과', turn_deadline_exceeded: '전체 처리 시간 초과', user_cancelled: '취소됨', internal_error: '오류', validation: '검증 실패', generation: '생성 실패' }[chat.errorCode] ?? '오류'} · ` : ''}{chat.error}</div>}
        </div>
      </div>

      {!atLatest && <button type="button" className="btn sm jump-latest" onClick={jumpLatest}>↓ 최신 메시지로</button>}

      {/* 기존 sysline 슬롯: 응답 이어가기 + 요약 제안 (키보드/스크롤 경로 비변경) */}
      {(() => {
        const needReply = !generating && lastMsg?.role === 'user';
        if (!needReply && !showSuggest && !continueFrom) return null;
        return (
          <div className="sysline" style={{ padding: '6px 0' }}>
            {needReply && (
              <button className="btn sm primary" onClick={() => chat.regenerate(lastMsg.id)}>↻ {char.name}의 응답 생성</button>
            )}
            {continueFrom && <button type="button" className="btn sm" disabled={generating || ended} onClick={() => { stickyRef.current = true; void chat.continueResponse(continueFrom.id); }}>이어서 생성</button>}
            {showSuggest && (
              <div className="row" style={{ justifyContent: 'center', flexWrap: 'wrap', marginTop: needReply ? 6 : 0 }}>
                <span>{hasDraft ? '요약 초안이 있습니다.' : '최근 대화가 컨텍스트 창을 넘었습니다.'}</span>
                <button
                  className="btn sm ghost"
                  onClick={() => {
                    const wm = resolveBannerWatermarkId(chat.messages, summaryRows ?? [], id);
                    suppressSummaryBanner(id, wm, sessionBannerKv());
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

      {ended && (
        <div className="banner" role="status" style={{ margin: '8px 12px 0' }}>
          <div><strong>완결{reachedEnding ? ` — ${reachedEnding.title}` : ''}</strong>{reachedEnding?.badge_label ? ` · ${reachedEnding.badge_label}` : ''}</div>
          {reachedEnding?.description ? <div className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{reachedEnding.description}</div> : null}
        </div>
      )}
      {!ended && endingBanner.visible.length > 0 && (
        <div role="status" aria-live="polite" style={{ margin: '8px 12px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {endingBanner.visible.map((s) => (
            <div key={s.ending_id} className="banner" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                className="btn sm ghost"
                style={{ flex: 1, textAlign: 'left' }}
                disabled={endingBanner.confirmingId === s.ending_id}
                onClick={() => void confirmSuggestedEnding(s.ending_id, s.title)}
              >
                {endingBanner.confirmingId === s.ending_id ? '완결 중…' : `엔딩 [${s.title}] 도달 가능`}
              </button>
              <button
                type="button"
                className="btn sm ghost"
                aria-label="제안 닫기"
                onClick={() => endingBanner.dismiss(s.ending_id)}
              >✕</button>
            </div>
          ))}
        </div>
      )}
      {!ended && endingChoices.length > 0 && (
        <div className="row" style={{ justifyContent: 'center', padding: '4px 0' }}>
          <button className="btn sm ghost" onClick={() => { setEndingPick(''); setEndingOpen(true); }}>엔딩 선택</button>
        </div>
      )}

      {conv.scene.observation_filter && conv.scene.format !== 'dialog' ? <WhisperRecipients actors={audienceActors} value={whisperIds} onChange={setWhisperIds} disabled={generating || !!choiceDraft} loading={audienceNames?.room !== id} error={!!audienceNames?.error} /> : null}
      {choiceDraft && <div className="banner warn" aria-label="선택지 공개 범위">
        <span>{audienceLabel(choiceDraft.visibility === 'private' ? { visibility:'private',recipient_ids:['user',...choiceDraft.recipient_ids] } : {visibility:'public'}, audienceActors)} · 비공개 맥락 기반 선택지</span>
        <button type="button" className="btn sm" aria-pressed={choiceDraft.visibility === 'public'} disabled={generating} onClick={() => setChoiceDraft({ ...choiceDraft, visibility: 'public' })}>공개</button>
        <button type="button" className="btn sm" aria-pressed={choiceDraft.visibility === 'private'} disabled={generating || !choiceDraft.recipient_ids.length || !conv.scene.observation_filter || conv.scene.format === 'dialog'} onClick={() => setChoiceDraft({ ...choiceDraft, visibility: 'private' })}>귓속말(같은 수신자)</button>
        {!choiceDraft.recipient_ids.length && <span>원래 수신자를 복원할 수 없어 귓속말을 보낼 수 없습니다.</span>}
        <button type="button" className="btn sm ghost" disabled={generating} onClick={() => { setChoiceDraft(null); setWhisperIds(''); }}>공개 일반 입력으로 전환</button>
      </div>}
      <div className="row" style={{ padding: '4px 12px', gap: 6, flexWrap: 'wrap' }} aria-label="부가 모드">
        <span className="small muted">부가 모드</span>
        <button type="button" className="btn sm ghost" onClick={() => { setSideTab('summary'); setSideOpen(true); }}>이야기 요약</button>
        <button type="button" className="btn sm ghost" onClick={() => { setSideTab('community'); setSideOpen(true); }}>심층갤</button>
      </div>
      <div className={`composer${generating ? ' is-generating' : ''}`}>
        {generating && (
          <div className="gen-status" aria-live="polite">
            <span className="gen-dots" aria-hidden="true"><i /><i /><i /></span>
            {sideMode.generating ? '부가 모드 생성 중…' : <GenerationStatus progress={chat.generationProgress} />}
          </div>
        )}
        <div className="inputbar">
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => setDraft(parseSideModeCommand(e.target.value) ? e.target.value : expandLeadingShortcut(e.target.value, readShortcuts(), { bare: false }).text)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                if (!generating) submit();
              }
            }}
            placeholder={ended ? '완결된 대화입니다' : (generating ? '다음 행동을 적어 두세요…' : `${char.name}에게 메시지…`)}
            rows={1}
            enterKeyHint="enter"
            disabled={ended}
          />
          {generating ? (
            <button type="button" className="btn icon stop-gen" onClick={() => void (sideMode.generating ? sideMode.stop() : chat.stop())} aria-label="생성 중단" title="생성 중단">■</button>
          ) : (
            <button type="button" className="btn primary icon" onClick={submit} disabled={!draft.trim() || ended} aria-label="보내기">↑</button>
          )}
        </div>
      </div>

      <BottomSheet open={endingOpen} onClose={() => { if (!endingSaving) setEndingOpen(false); }}>
        <div className="sheet-body">
          <strong>엔딩 선택</strong>
          <div className="field" style={{ marginTop: 12 }}>
            <label>결말</label>
            <select value={endingPick} onChange={(e) => setEndingPick(e.target.value)} disabled={endingSaving}>
              <option value="">선택</option>
              {endingChoices.map((e) => (
                <option key={e.id} value={e.id}>{e.title}{e.badge_label ? ` · ${e.badge_label}` : ''}</option>
              ))}
            </select>
          </div>
          <div className="small muted" style={{ marginBottom: 12 }}>완결하면 이후 메시지를 보낼 수 없습니다.</div>
          <button className="btn primary block" disabled={!endingPick || endingSaving} onClick={() => void reachEnding()}>
            {endingSaving ? '완결 중…' : '이 결말로 완결'}
          </button>
        </div>
      </BottomSheet>

      <SideModePanel open={sideOpen} mode={sideTab} onModeChange={setSideTab} onClose={() => setSideOpen(false)} messages={sideMode.messages} loading={sideMode.loading} generating={sideMode.generating} disabled={generating} error={sideMode.error} onGenerate={sideMode.generate} onStop={() => void sideMode.stop()} onReload={() => void sideMode.reload()} />
      <ChatDrawer open={drawer} conversationId={id} draft={draft} initialTab={drawerTab} onClose={() => { setDrawer(false); setDrawerTab(undefined); }} onApplied={() => { setSummaryTick((n) => n + 1); }} />
      <ConversationSettings open={settings} conversationId={id} generating={generating} onClose={() => setSettings(false)} onChanged={chat.reload} onOpenMemory={() => { setSettings(false); setDrawerTab(undefined); setDrawer(true); }} />
      </div>

      <OverlayDrawer
        open={toolsOpen}
        onClose={() => setToolsOpen(false)}
        side="right"
        mode={desktop ? 'rail' : 'overlay'}
        title="대화 도구"
      >
        {desktop ? (
          <div className="chat-rail-head tools-rail-head">
            <span>대화 도구</span>
            <button
              type="button"
              className="btn ghost icon"
              aria-label="패널 닫기"
              onClick={() => setToolsOpen(false)}
            >✕</button>
          </div>
        ) : null}
        {desktop ? (
          <SceneStatusPanel
            conversationId={id}
            scene={conv.scene}
            places={chat.detail!.scene_places}
            characterName={char.name}
            roster={lastUi?.roster}
            hasBeatRoster={hasBeatRoster}
            focusId={lastUi?.focus_id ?? conv.scene.last_beat?.focus_id ?? null}
            generating={generating}
            loadError={chat.error}
            conversationEnded={ended}
            placement="desktop"
            onIntent={onSceneIntent}
          />
        ) : null}
        <ConversationTools
          conversationId={id}
          detail={chat.detail!}
          onChanged={chat.reload}
          onOpenContextInspector={desktop ? undefined : () => { setDrawerTab('budget'); setDrawer(true); setToolsOpen(false); }}
        />
      </OverlayDrawer>
    </div>
  );
}

/** StoryForge RecommendationChoices pattern: tap=send, pencil=composer draft. Cap ~3 for scan. */
function ChoiceChips({
  choices,
  onChoice,
  onEdit,
  disabled,
}: {
  choices: string[];
  onChoice: (c: string) => void;
  onEdit: (c: string) => void;
  disabled?: boolean;
}) {
  const shown = visibleChoices(choices);
  if (shown.length === 0) return null;
  return (
    <div className="chips" aria-disabled={disabled || undefined}>
      {shown.map((c, i) => (
        <div key={i} className="chip-row">
          <button
            type="button"
            className="chip-edit"
            disabled={disabled}
            aria-label="추천 답변 편집"
            title="추천 답변 편집"
            onClick={() => onEdit(c)}
          >✎</button>
          <button type="button" className="chip" disabled={disabled} onClick={() => onChoice(c)}>{c}</button>
        </div>
      ))}
    </div>
  );
}

function MessageView(props: {
  m: Message;
  charName: string;
  audienceText?: string | null;
  userName: string;
  sceneFormat?: 'beat' | 'dialog';
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
  onEditChoice: (c: string) => void;
  hideChoices?: boolean;
  showPortrait?: boolean;
  focusId?: string | null;
}) {
  const { m } = props;
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(m.content);
  const isUser = m.role === 'user';
  const touch = useRef<{ x: number; y: number } | null>(null);
  const [dragX, setDragX] = useState(0);
  const hasSiblings = m.siblings.count > 1;
  const canDrag = m.role === 'assistant' && !props.generating && !props.streaming && (hasSiblings || props.isLastAssistant);

  // empty-turn 보조 방어. 주 방어는 목록 단계의 visibleChatMessages 다(래퍼·간격까지
  // 같이 사라진다). 여기서는 다른 호출자가 빈 user 행을 직접 넘겼을 때 `…` 말풍선이
  // 다시 생기지 않도록만 막는다. 훅 선언 뒤라 호출 순서는 바뀌지 않는다.
  if (isEmptyUserMessage(m)) return null;

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

  if (!isUser && hasEventContract(m) && m.events.length === 0 && m.status === 'complete' && !m.meta.choices?.length && !m.meta.error) return null;
  const firstDialogue = !isUser && hasEventContract(m) ? m.events.find((event) => event.type === 'dialogue') : undefined;
  const portrait = props.showPortrait === false ? null : messagePortrait(m);
  const showActions = !props.streaming && !props.generating;
  const lineFocus = Boolean(!isUser && props.focusId && m.events?.some((event) => event.type === 'dialogue' && event.actorId === props.focusId));
  return (
    <div id={props.domId} className={`msg ${isUser ? 'user' : 'assistant'} ${m.meta.ooc ? 'ooc' : ''}${lineFocus ? ' is-focus' : ''}${portrait ? ' has-portrait' : ''}`}>
      {props.audienceText && <div className="message-audience">{props.audienceText}</div>}
      {firstDialogue?.actorName ? (
        <SpeakerHeader name={firstDialogue.actorName} avatar={m.meta.speaker_avatar === m.meta.image_url ? undefined : m.meta.speaker_avatar} focused={lineFocus} />
      ) : null}
      <div
        className={`${isUser ? 'bubble' : 'chat-event-body'} ${m.status === 'interrupted' ? 'interrupted' : ''} ${m.status === 'error' ? 'error' : ''}`}
        style={{
          transform: dragX ? `translateX(${dragX}px)` : undefined,
          transition: dragX ? 'none' : 'transform 0.2s ease-out',
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
      >
        {portrait ? <CharacterPortrait key={portrait.src} src={portrait.src} name={portrait.name} /> : null}
        {isUser ? renderContent(m.content) : <MessageEvents message={m} streaming={props.streaming} focusId={props.isLastAssistant ? props.focusId : null} />}
        {props.streaming && <span className="cursor" />}
        {m.status === 'error' && <div className="small" style={{ color: 'var(--danger)', marginTop: 6 }}>{m.meta.error ?? '생성 실패'}</div>}
        {m.status === 'interrupted' && <div className="small muted" style={{ marginTop: 4 }}>(중단됨)</div>}
      </div>

      {/* 스토리 선택지: 최신 assistant 턴에서만 노출 — 다음 턴이 시작되면 이전 선택지는 사라진다 */}
      {!props.hideChoices && !props.streaming && !props.generating && props.isLastAssistant && m.meta.choices && m.meta.choices.length > 0 && (
        <ChoiceChips choices={m.meta.choices} onChoice={props.onChoice} onEdit={props.onEditChoice} disabled={props.generating} />
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
          <details className="msg-actions" onKeyDown={e => {
            if (e.key === 'Escape') {
              e.currentTarget.open = false;
              e.currentTarget.querySelector('summary')?.focus();
            }
          }}>
            <summary aria-label="메시지 관리">⋯{m.bookmarked ? ' ★' : ''}</summary>
            <div className="msg-action-items">
              <button onClick={() => { setVal(m.content); setEditing(true); }}>✎ 편집</button>
              <button onClick={props.onBookmark} aria-pressed={m.bookmarked}>{m.bookmarked ? '★ 즐겨찾기 해제' : '☆ 즐겨찾기'}</button>
              <button onClick={props.onDelete}>삭제</button>
            </div>
          </details>
          {m.meta.usage?.completion_tokens ? <span className="muted">{m.meta.usage.completion_tokens}t</span> : null}
        </div>
      )}
    </div>
  );
}

function ConversationSettings({ open, conversationId, generating, onClose, onChanged, onOpenMemory }: { open: boolean; conversationId: string; generating?: boolean; onClose: () => void; onChanged: () => void; onOpenMemory: () => void }) {
  const ui = useUi();
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [conv, setConv] = useState<Conversation | null>(null);
  const [character, setCharacter] = useState<Character | null>(null);
  const [persona, setPersona] = useState<Persona | null>(null);
  const [promptVersion, setPromptVersion] = useState('');
  const [view, setView] = useState<'main' | 'guide' | 'profiles'>('main');
  const [personaList, setPersonaList] = useState<Persona[]>([]);
  const [lengthSaving, setLengthSaving] = useState(false);

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

  async function saveLength(value: ResponseLength) {
    const body = buildResponseLengthPatch(value);
    if (!body || lengthSaving || generating) return;
    setLengthSaving(true);
    try {
      const saved = await patch<Conversation>(`/api/conversations/${conversationId}`, body);
      setConv(saved);
      onChanged();
    } catch (error) {
      ui.toast((error as Error).message, 'err');
    } finally {
      setLengthSaving(false);
    }
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
          <label>출력/톤</label>
          <select value={conv.profile_name} disabled={!!generating} onChange={(e) => { setConv({ ...conv, profile_name: e.target.value }); save({ profileName: e.target.value }); }}>
            {profiles.filter((p) => p.name.startsWith('rp-')).map((p) => <option key={p.name} value={p.name}>{outputProfileLabel(p.name)} · max {p.max_tokens}</option>)}
          </select>
          <span className="hint">출력량·온도입니다. 모델을 바꾸지 않습니다.</span>
        </div>
        <ResponseLengthSelect value={conv.scene.response_length ?? 'normal'} disabled={!!generating || lengthSaving} onChange={(value) => void saveLength(value)} />
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

function sessionBannerKv() {
  return {
    getItem: (k: string) => {
      try { return sessionStorage.getItem(k); } catch { return null; }
    },
    setItem: (k: string, v: string) => {
      try { sessionStorage.setItem(k, v); } catch { /* private mode */ }
    },
  };
}

function localBannerKv() {
  return {
    getItem: (k: string) => {
      try { return localStorage.getItem(k); } catch { return null; }
    },
    setItem: (_k: string, _v: string) => {},
  };
}
