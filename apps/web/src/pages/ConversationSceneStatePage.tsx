import { AdventurePage } from './AdventurePage';
import { useEffect, useState, type ReactNode } from 'react';
import { get, patch } from '../lib/api';
import { back } from '../lib/router';
import type { ConversationDetail, Scene } from '../types';
import { SettingsEmptyState, SettingsPageHeader, SettingsPageLayout } from '../components/settings';
import { Spinner } from '../components/ui';
import { settingsBackFallback } from '../lib/conversationSettings';
import {
  buildSceneStatePatch,
  draftFromScene,
  hasLivingState,
  type SceneStateDraft,
} from '../lib/sceneState';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

function SceneStateView({
  draft,
  pending,
  error,
  onChange,
  onSave,
  onBack,
  onAdventure,
  confirmed,
}: {
  draft: SceneStateDraft;
  pending: boolean;
  error: string | null;
  onChange: (next: SceneStateDraft) => void;
  onSave: () => void;
  onBack: () => void;
  onAdventure?: () => void;
  confirmed?: import('@rpchat/contracts/adventure').AdventureState;
}) {
  const set = <K extends keyof SceneStateDraft>(key: K, value: SceneStateDraft[K]) => {
    onChange({ ...draft, [key]: value });
  };
  return (
    <SettingsPageLayout
      header={<SettingsPageHeader title="장면 상태" onBack={onBack} />}
      footer={(
        <button type="button" className="btn primary" disabled={pending} onClick={onSave}>
          {pending ? '저장 중…' : '저장'}
        </button>
      )}
    >
      {onAdventure && <button className="btn" onClick={onAdventure}>등록·의뢰·소지품 확인</button>}
      {error ? <div className="banner err">{error}</div> : null}
      <p className="sub" style={{ padding: '0 4px 8px' }}>
        서버 정본(`scene_json`)만 고칩니다. 호감 축은 필드가 없어 이 시트에 만들지 않습니다.
      </p>
      {draft.showSheet ? (
        <section className="card settings-section-body" style={{ padding: 16, marginBottom: 12 }}>
          <h2 className="section-title">시트</h2>
          <Field label="HP">
            <input inputMode="numeric" value={draft.hp} disabled={pending} onChange={(e) => set('hp', e.target.value)} />
          </Field>
          <Field label={confirmed?.currency ?? "₩"}>
            <input inputMode="numeric" value={confirmed ? String(confirmed.balance) : draft.money} disabled={pending || !!confirmed} onChange={(e) => set('money', e.target.value)} />
          </Field>
          <Field label="장비 (줄마다 하나)">
            <textarea value={draft.gear} disabled={pending} onChange={(e) => set('gear', e.target.value)} />
          </Field>
          <Field label="보유 (줄마다 하나)">
            <textarea value={confirmed ? confirmed.items.map(i => `${i.name} × ${i.quantity} (${i.owner})`).join('\n') : draft.inventory} disabled={pending || !!confirmed} onChange={(e) => set('inventory', e.target.value)} />
          </Field>
          <Field label="특수 (줄마다 하나)">
            <textarea value={confirmed ? confirmed.skills.join('\n') : draft.traits} disabled={pending || !!confirmed} onChange={(e) => set('traits', e.target.value)} />
          </Field>
        </section>
      ) : null}
      {draft.showInfo ? (
        <section className="card settings-section-body" style={{ padding: 16, marginBottom: 12 }}>
          <h2 className="section-title">INFO</h2>
          <Field label="상태 (줄마다 하나)">
            <textarea value={draft.status} disabled={pending} onChange={(e) => set('status', e.target.value)} />
          </Field>
          <Field label="계약">
            <input value={draft.contract} disabled={pending} onChange={(e) => set('contract', e.target.value)} />
          </Field>
          <Field label="침식">
            <input value={draft.erosion} disabled={pending} onChange={(e) => set('erosion', e.target.value)} />
          </Field>
          <Field label="목표 (줄마다 하나)">
            <textarea value={draft.goals} disabled={pending} onChange={(e) => set('goals', e.target.value)} />
          </Field>
        </section>
      ) : null}
      {draft.showHunter ? (
        <section className="card settings-section-body" style={{ padding: 16, marginBottom: 12 }}>
          <h2 className="section-title">헌터</h2>
          <Field label="소속">
            <input value={draft.affiliation} disabled={pending} onChange={(e) => set('affiliation', e.target.value)} />
          </Field>
          <Field label="특성 이름">
            <input value={draft.traitName} disabled={pending} onChange={(e) => set('traitName', e.target.value)} />
          </Field>
          <Field label="특성 등급">
            <input value={confirmed ? confirmed.rank : draft.traitGrade} disabled={pending || !!confirmed} onChange={(e) => set('traitGrade', e.target.value)} />
          </Field>
          <Field label="가호">
            <input value={draft.patronName} disabled={pending} onChange={(e) => set('patronName', e.target.value)} />
          </Field>
          <Field label="퀘스트">
            <input value={confirmed ? confirmed.quests.filter(q => !['declined', 'settled'].includes(q.stage)).map(q => q.title).join(', ') : draft.quest} disabled={pending || !!confirmed} onChange={(e) => set('quest', e.target.value)} />
          </Field>
          <Field label="일정">
            <input value={draft.schedule} disabled={pending} onChange={(e) => set('schedule', e.target.value)} />
          </Field>
          <Field label="상황">
            <input value={draft.situation} disabled={pending} onChange={(e) => set('situation', e.target.value)} />
          </Field>
          <Field label="스킬 (줄마다 하나)">
            <textarea value={confirmed ? confirmed.skills.join('\n') : draft.skills} disabled={pending || !!confirmed} onChange={(e) => set('skills', e.target.value)} />
          </Field>
        </section>
      ) : null}
      {draft.statDefs.length ? (
        <section className="card settings-section-body" style={{ padding: 16, marginBottom: 12 }}>
          <h2 className="section-title">스탯</h2>
          {draft.statDefs.map((d) => (
            <Field key={d.id} label={`${d.label} (${d.min}–${d.max})`}>
              <input
                inputMode="numeric"
                value={draft.statValues[d.id] ?? ''}
                disabled={pending}
                onChange={(e) => onChange({
                  ...draft,
                  statValues: { ...draft.statValues, [d.id]: e.target.value },
                })}
              />
            </Field>
          ))}
        </section>
      ) : null}
    </SettingsPageLayout>
  );
}

export function ConversationSceneStatePage({
  conversationId,
  onBack,
}: {
  conversationId: string;
  onBack?: () => void;
}) {
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [adventureOpen, setAdventureOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [draft, setDraft] = useState<SceneStateDraft | null>(null);
  const [empty, setEmpty] = useState(false);
  const [missing, setMissing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const goBack = onBack ?? (() => back(settingsBackFallback(conversationId, 'leaf')));

  useEffect(() => {
    let live = true;
    setMissing(false);
    setEmpty(false);
    setDraft(null);
    setError(null);
    get<ConversationDetail>(`/api/conversations/${conversationId}`)
      .then((d) => {
        if (!live) return;
        setDetail(d);
        const scene = d.conversation.scene as Scene;
        if (!hasLivingState(scene)) {
          setEmpty(true);
          return;
        }
        setDraft(draftFromScene(scene));
      })
      .catch(() => {
        if (live) setMissing(true);
      });
    return () => {
      live = false;
    };
  }, [conversationId, refresh]);

  async function onSave() {
    if (!draft || pending) return;
    const body = buildSceneStatePatch(draft);
    if (!body) {
      setError('HP/₩는 정수만 저장합니다.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await patch(`/api/conversations/${conversationId}`, body);
      goBack();
    } catch {
      setError('저장에 실패했습니다.');
    } finally {
      setPending(false);
    }
  }

  if (adventureOpen && detail) return <AdventurePage key={conversationId} detail={detail} onBack={() => { setAdventureOpen(false); setRefresh(v => v + 1); }} />;

  if (missing) {
    return (
      <SettingsPageLayout header={<SettingsPageHeader title="장면 상태" onBack={goBack} />}>
        <SettingsEmptyState message="대화를 찾을 수 없습니다." />
      </SettingsPageLayout>
    );
  }

  if (empty) {
    return (
      <SettingsPageLayout header={<SettingsPageHeader title="장면 상태" onBack={goBack} />}>
        {detail?.conversation.story_id && <button className="btn" onClick={() => setAdventureOpen(true)}>등록·의뢰·소지품 확인</button>}
        <SettingsEmptyState message="이 대화에는 아직 비트 상태(HP·계약·퀘스트)가 없습니다. 호감 축은 scene에 필드가 없어 만들지 않습니다." />
      </SettingsPageLayout>
    );
  }

  if (!draft) {
    return (
      <SettingsPageLayout header={<SettingsPageHeader title="장면 상태" onBack={goBack} />}>
        <Spinner />
      </SettingsPageLayout>
    );
  }

  return (
    <SceneStateView
      draft={draft}
      pending={pending}
      error={error}
      confirmed={detail?.conversation.scene.adventure}
      onAdventure={detail?.conversation.story_id ? () => setAdventureOpen(true) : undefined}
      onChange={setDraft}
      onSave={() => void onSave()}
      onBack={goBack}
    />
  );
}
