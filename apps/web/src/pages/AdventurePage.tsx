import { useRef, useState } from 'react';
import type { AdventureAction, AdventureRequest, AdventureState, QuestStage } from '@rpchat/contracts/adventure';
import type { ConversationDetail } from '../types';
import { ApiError, get, post } from '../lib/api';
import { SettingsPageHeader, SettingsPageLayout } from '../components/settings';
import { useUi } from '../components/ui';

const stages: Record<QuestStage, string> = { offered: '제안', considering: '고려 중', accepted: '수락', in_progress: '진행 중', completed: '완료', settled: '정산 완료', declined: '거절' };
const kinds: Record<AdventureAction['kind'], string> = {
  initialize: '현재 상태로 기록 시작', register: '등록 완료·등록비 납부', payment: '실제 지급·수령', quest_offer: '의뢰 제안 기록',
  quest_stage: '의뢰 단계 확인', quest_settle: '완료 의뢰 정산', item_receive: '물품 실물 수령', item_reduce: '물품 반납·사용', progress: '경지·경험치·능력 확인',
};
type Field = { key: string; label: string; number?: boolean; optional?: boolean; options?: Array<[string, string]> };
function fields(kind: AdventureAction['kind'], state?: AdventureState): Field[] {
  const growth = [{ key: 'rank', label: '경지 (미정이면 비움)', optional: true }, { key: 'experience', label: '확인한 경험치', number: true }, { key: 'skills', label: '확인한 능력 (한 줄에 하나, 없으면 비움)', optional: true }];
  switch (kind) {
    case 'initialize': return [{ key: 'currency', label: '통화 단위' }, { key: 'balance', label: '현재 소지금', number: true }, ...growth];
    case 'register': return [{ key: 'organization', label: '등록 기관' }, { key: 'fee', label: '실제로 낸 등록비', number: true }];
    case 'payment': return [{ key: 'direction', label: '방향', options: [['pay', '지급'], ['receive', '수령']] }, { key: 'amount', label: '실제 금액', number: true }, { key: 'counterpart', label: '상대' }, { key: 'reason', label: '지급·수령 이유' }];
    case 'quest_offer': return [{ key: 'title', label: '의뢰 이름' }, { key: 'terms', label: '목표·기한·위험·수수료·준비 조건' }, { key: 'reward', label: '제안된 보수 (미정이면 비움)', number: true, optional: true }];
    case 'quest_stage': return [{ key: 'quest_id', label: '의뢰', options: (state?.quests ?? []).map(q => [q.id, `${q.title} (${stages[q.stage]})`]) }, { key: 'stage', label: '확인한 단계', options: ['considering', 'accepted', 'in_progress', 'completed', 'declined'].map(k => [k, stages[k as QuestStage]]) }];
    case 'quest_settle': return [{ key: 'quest_id', label: '완료 의뢰', options: (state?.quests ?? []).filter(q => q.stage === 'completed').map(q => [q.id, q.title]) }, { key: 'received', label: '실제로 받은 보수', number: true }];
    case 'item_receive': return [{ key: 'name', label: '받은 물품' }, { key: 'quantity', label: '실제 수량', number: true }, { key: 'ownership', label: '소유 구분', options: [['owned', '내 소유'], ['loan', '대여품']] }, { key: 'owner', label: '소유자' }, { key: 'terms', label: '사용·반납 조건 (기한 포함, 없으면 없음)' }, { key: 'source', label: '누구에게 어디서 받았는지' }];
    case 'item_reduce': return [{ key: 'item_id', label: '물품', options: (state?.items ?? []).map(i => [i.id, `${i.name} × ${i.quantity} (${i.owner})`]) }, { key: 'quantity', label: '반납·사용 수량', number: true }, { key: 'reason', label: '변경 이유', options: [['return', '대여품 반납'], ['use', '소유품 사용']] }];
    case 'progress': return growth;
  }
}

export function AdventurePage({ detail: initial, onBack }: { detail: ConversationDetail; onBack: () => void }) {
  const ui = useUi();
  const [detail, setDetail] = useState(initial);
  const state = detail.conversation.scene.adventure;
  const [kind, setKind] = useState<AdventureAction['kind']>(state ? 'quest_offer' : 'initialize');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const retry = useRef<AdventureRequest | null>(null);
  const actionFields = fields(kind, state);
  const conv = detail.conversation;
  const last = detail.messages.at(-1);
  const disabled = busy || !!detail.activeGeneration || !!conv.ended_at || last?.role !== 'assistant' || last.status !== 'complete';
  async function refresh() { setDetail(await get<ConversationDetail>(`/api/conversations/${conv.id}`)); }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (disabled || !conv.head_message_id) return;
    const action: Record<string, unknown> = { kind };
    for (const f of actionFields) {
      const value = (draft[f.key] ?? '').trim();
      if (!value && !f.optional) { setError(`${f.label}을 입력해 주세요.`); return; }
      if (f.number && value && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) { setError('수치는 0 이상의 정수로 입력해 주세요.'); return; }
      action[f.key] = f.key === 'skills' ? value.split('\n').map(s => s.trim()).filter(Boolean) : f.number ? (value ? Number(value) : null) : value;
    }
    const review = actionFields.map(f => { const value = f.options?.find(([v]) => v === draft[f.key])?.[1] ?? draft[f.key] ?? '없음'; return `${f.label}: ${value.length > 60 ? value.slice(0, 60) + '…' : value}`; }).join('\n');
    setNotice(null);
    if (!await ui.confirm(`${kinds[kind]}\n\n${review}\n\n실제로 확인한 내용만 공개 상태에 기록합니다.`, { okLabel: '확인하고 기록' })) return;
    setBusy(true); setError(null); setNotice(null);
    const body = retry.current ?? { expected_head_id: conv.head_message_id, expected_scene_version: conv.scene.scene_version ?? 0,
      idempotency_key: crypto.randomUUID(), action: action as AdventureAction };
    retry.current = body;
    let recorded = false;
    try {
      await post(`/api/conversations/${conv.id}/adventure-actions`, body);
      recorded = true;
      await refresh();
      retry.current = null; setDraft({}); setKind('quest_offer'); setNotice('확인 내역을 대화에 기록했습니다.');
    } catch (e) {
      if (!recorded && e instanceof ApiError && e.status < 500) {
        retry.current = null;
        await refresh().catch(() => {});
      }
      setError(e instanceof Error ? e.message : '기록을 확인하지 못했습니다. 같은 내용으로 다시 시도할 수 있습니다.');
    } finally { setBusy(false); }
  }
  return <SettingsPageLayout header={<SettingsPageHeader title="등록·의뢰·소지품 확인" onBack={onBack} />}>
    <p className="sub">실제로 한 행동을 확인하면 대화에 기록됩니다. 질문·제안·고려만으로 돈이나 물품이 바뀌지 않습니다. 이 기록은 공개 정보입니다.</p>
    {state ? <section className="card" style={{ padding: 16, marginBottom: 16 }}>
      <p><strong>{state.balance.toLocaleString()} {state.currency}</strong> · {state.registration ? `${state.registration.organization} 등록 완료` : '미등록'}</p>
      <p>경지 {state.rank || '미정'} · 경험치 {state.experience} · 능력 {state.skills.join(', ') || '없음'}</p>
      <h3>의뢰</h3>{state.quests.length ? state.quests.map(q => <p key={q.id}><strong>{q.title} · {stages[q.stage]}</strong><br />{q.terms}<br />제안 보수: {q.reward == null ? '미정' : `${q.reward} ${state.currency}`}</p>) : <p>기록된 의뢰 없음</p>}
      <h3>소지품·대여품</h3>{state.items.length ? state.items.map(i => <p key={i.id}><strong>{i.name} × {i.quantity} · {i.ownership === 'loan' ? '대여' : '소유'}</strong><br />소유자: {i.owner} · {i.terms}<br />출처: {i.source}</p>) : <p>확인한 물품 없음</p>}
    </section> : <p>기존 대화의 내용을 자동으로 옮기지 않습니다. 현재 금액·통화·능력을 확인한 뒤 시작하고, 이미 등록했거나 받은 물품은 이어서 기록해 주세요. 통화 환산과 경험치 자동 지급은 하지 않습니다.</p>}
    {error && <p role="alert" className="banner err">{error}</p>}{notice && <p role="status">{notice}</p>}
    <form onSubmit={save}>
      <fieldset disabled={disabled} style={{ border: 0, padding: 0 }}>
        {state && <label className="field">기록할 행동<select aria-label="기록할 행동" value={kind} onChange={e => { setKind(e.target.value as AdventureAction['kind']); setDraft({}); retry.current = null; }}>
          {Object.entries(kinds).filter(([k]) => k !== 'initialize').map(([k, text]) => <option key={k} value={k}>{text}</option>)}
        </select></label>}
        {actionFields.map(f => <label className="field" key={f.key}>{f.label}{f.number && state ? ` (${['quantity', 'experience'].includes(f.key) ? '수량' : state.currency})` : ''}
          {f.options ? <select aria-label={f.label} required={!f.optional} value={draft[f.key] ?? ''} onChange={e => { setDraft({ ...draft, [f.key]: e.target.value }); retry.current = null; }}>
            <option value="">선택해 주세요</option>{f.options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select> : ['skills', 'terms', 'source', 'reason'].includes(f.key) ? <textarea aria-label={f.label} required={!f.optional} rows={3} value={draft[f.key] ?? ''}
            maxLength={f.key === 'skills' ? 1600 : 240} onChange={e => { setDraft({ ...draft, [f.key]: e.target.value }); retry.current = null; }} />
            : <input aria-label={f.label} required={!f.optional} inputMode={f.number ? 'numeric' : 'text'} value={draft[f.key] ?? ''}
              maxLength={f.number ? 10 : 80} onChange={e => { setDraft({ ...draft, [f.key]: e.target.value }); retry.current = null; }} />}
        </label>)}
        <button className="btn primary" type="submit">{busy ? '기록 중…' : '확인하고 기록'}</button>
      </fieldset>
      {disabled && !busy && <p>생성이 끝난 응답에서 기록할 수 있습니다. <button className="btn sm" type="button" onClick={() => void refresh().catch(e => setError(e.message))}>최신 상태 확인</button></p>}
    </form>
  </SettingsPageLayout>;
}
