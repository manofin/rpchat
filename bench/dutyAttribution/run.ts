/** f9-duty-attribution-eval — one model call per scenario, then L0..L3 attribution layers offline. */
import fs from 'node:fs';
import { SCENARIOS, CAST, type Cand } from './fixtures.ts';

const MODEL = '/Users/llm/models/Gemma-4-Dark-Thoughts-V2-31B.i1-Q4_K_M.gguf';
const URL = 'http://100.97.170.121:8083/v1/chat/completions';
const CATS = ['DUTY','AUTHORITY','RELATIONSHIP','EXCLUSIVE_KNOWLEDGE','CURRENT_ACTION','DIRECT_ADDRESS','DIRECT_OBSERVATION'];

function attrLines(c: Cand): string {
  const a = c.attrs; const p: string[] = [];
  if (a.duties.length) p.push(`직무: ${a.duties.join(', ')}`);
  if (a.authority.length) p.push(`권한: ${a.authority.join(', ')}`);
  if (a.relationships.length) p.push(`관계: ${a.relationships.join(', ')}`);
  if (a.exclusive_knowledge.length) p.push(`아는 것: ${a.exclusive_knowledge.join(', ')}`);
  if (a.current_action.length) p.push(`지금 하는 일: ${a.current_action.join(', ')}`);
  return p.length ? p.join(' / ') : '(등록된 속성 없음)';
}

function prompt(s: typeof SCENARIOS[number]): string {
  const primary = CAST[s.primary];
  return [
    '너는 장면 진행 판정기다. 서사나 대사를 쓰지 않는다.',
    '', `현재 주화자는 '${primary.name}' 이다. 주화자는 이미 이 턴에 답하므로 후보가 아니다.`,
    '아래 후보 각각에 대해서만 판정한다. 후보 목록에 없는 인물을 새로 만들지 않는다.',
    ...s.candidates.map((id) => `- candidate_id: ${id} / 이름: ${CAST[id].name} / ${attrLines(CAST[id])}`),
    '', '## 사용자 입력', s.event,
    '', '주화자의 응답과 별개로 그 후보가 지금 개입해야 할 독립적 근거가 있으면 approve, 없으면 reject 한다.',
    '단순히 상황과 관련 있다는 이유만으로 approve 하지 않는다.',
    `claim_type 은 다음 중 하나여야 한다: ${CATS.join(' / ')}`,
    'reason 에는 그 후보가 실제로 가진 속성을 근거로 적는다.',
    '', '오직 JSON 하나만 출력한다. 형식:',
    '{"candidate_decisions": [{"candidate_id": "...", "decision": "approve" | "reject", "claim_type": "...", "reason": "짧은 근거"}]}',
  ].join('\n');
}

const STOP = ['은','는','이','가','을','를','의','에','로','와','과','도','만'];
function toks(s: string): string[] {
  return (s || '').split(/[^0-9A-Za-z가-힣]+/).filter((w) => w.length >= 2 && !STOP.includes(w));
}
function allAttrText(c: Cand): string {
  const a = c.attrs;
  return [...a.duties, ...a.authority, ...a.relationships, ...a.exclusive_knowledge, ...a.current_action].join(' ');
}
const NEG = /없음|없다|불가|아님|제외/;

async function main() {
  const rows: any[] = [];
  for (const s of SCENARIOS) {
    let raw = '';
    try {
      const r = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt(s) }],
          temperature: 0.2, top_p: 0.9, max_tokens: 400, chat_template_kwargs: { enable_thinking: false } }) });
      const j: any = await r.json(); raw = j.choices?.[0]?.message?.content ?? '';
    } catch { raw = ''; }
    const i = raw.indexOf('{'), k = raw.lastIndexOf('}');
    let decisions: any[] = []; let parsed = false;
    try { const o = JSON.parse(raw.slice(i, k + 1)); decisions = o.candidate_decisions ?? []; parsed = Array.isArray(decisions); } catch {}

    const per = s.candidates.map((cid) => {
      const c = CAST[cid];
      const d = decisions.find((x: any) => x?.candidate_id === cid);
      const approved = d?.decision === 'approve';
      const reason = typeof d?.reason === 'string' ? d.reason : '';
      const claim = typeof d?.claim_type === 'string' ? d.claim_type : '';
      const attrText = allAttrText(c);
      const primaryText = allAttrText(CAST[s.primary]);
      // L1 simple substring overlap against duties only (the back-tested rule)
      const l1 = c.attrs.duties.some((x) => reason.includes(x)) && c.attrs.duties.length > 0;
      // L2 token overlap over ALL attributes, negation-aware
      const rt = toks(reason), at = toks(attrText), pt = toks(primaryText);
      const ovA = rt.filter((w) => at.includes(w)).length;
      const ovP = rt.filter((w) => pt.includes(w)).length;
      const negated = at.some((w) => rt.includes(w)) && NEG.test(attrText);
      const l2 = ovA > 0 && ovA >= ovP && !negated;
      // L3 structured category: claim_type must map to a non-empty attribute field
      const field: Record<string, string[]> = {
        DUTY: c.attrs.duties, AUTHORITY: c.attrs.authority, RELATIONSHIP: c.attrs.relationships,
        EXCLUSIVE_KNOWLEDGE: c.attrs.exclusive_knowledge, CURRENT_ACTION: c.attrs.current_action,
        DIRECT_ADDRESS: [], DIRECT_OBSERVATION: c.attrs.exclusive_knowledge,
      };
      const l3 = !!field[claim] && field[claim].length > 0 && !NEG.test(field[claim].join(' '));
      return { cid, type: c.type, approved, claim, reason,
        correct: s.correct.includes(cid), L0: approved, L1: approved && l1, L2: approved && l2, L3: approved && l3 };
    });
    rows.push({ ...s, raw, parsed, per });
    process.stdout.write(`${s.id} appr=${per.filter((p) => p.approved).length}/${per.length}\n`);
  }

  const summary: any = {};
  for (const L of ['L0','L1','L2','L3'] as const) {
    const T = rows.filter((r) => r.bucket === 'T'), N = rows.filter((r) => r.bucket === 'N');
    const recall = T.filter((r) => r.per.some((p: any) => p.correct && p[L])).length / T.length;
    const fp = N.filter((r) => r.per.some((p: any) => p[L])).length / N.length;
    const noAppr = N.filter((r) => !r.per.some((p: any) => p[L])).length / N.length;
    const allP = rows.flatMap((r) => r.per);
    const irrelevant = allP.filter((p: any) => !p.correct && p[L]).length / allP.filter((p: any) => !p.correct).length;
    const nonduty = ['E','F','G'];
    const ndTotal = allP.filter((p: any) => p.correct && nonduty.includes(p.type));
    summary[L] = {
      correct_secondary_recall_T: recall, fp_N: fp, no_approval_rate_N: noAppr,
      irrelevant_candidate_approval_rate: irrelevant,
      false_silence_rate_T: 1 - recall,
      nonduty_legit_retention: ndTotal.length ? ndTotal.filter((p: any) => p[L]).length / ndTotal.length : null,
      type_pass_rate: Object.fromEntries(['A','B','C','D','E','F','G','H'].map((t) => {
        const g = allP.filter((p: any) => p.type === t);
        return [t, g.length ? g.filter((p: any) => p[L]).length / g.length : null];
      })),
    };
  }
  const malformed = rows.filter((r) => !r.parsed).length / rows.length;
  const unknown = rows.filter((r) => { const i = r.raw.indexOf('{'), k = r.raw.lastIndexOf('}');
    try { const o = JSON.parse(r.raw.slice(i, k + 1)); return (o.candidate_decisions ?? []).some((d: any) => !r.candidates.includes(d?.candidate_id)); } catch { return false; } }).length / rows.length;
  const primaryResel = rows.filter((r) => { const i = r.raw.indexOf('{'), k = r.raw.lastIndexOf('}');
    try { const o = JSON.parse(r.raw.slice(i, k + 1)); return (o.candidate_decisions ?? []).some((d: any) => d?.candidate_id === r.primary && d?.decision === 'approve'); } catch { return false; } }).length / rows.length;

  const L0r = summary.L0.correct_secondary_recall_T;
  let verdict: string;
  if (L0r < 0.30 || malformed > 0.10) verdict = 'INSUFFICIENT';
  else {
    const support = (['L1','L2','L3'] as const).filter((L) => {
      const s = summary[L], b = summary.L0;
      return s.irrelevant_candidate_approval_rate <= b.irrelevant_candidate_approval_rate * 0.5
        && s.fp_N <= b.fp_N * 0.5
        && (b.correct_secondary_recall_T - s.correct_secondary_recall_T) <= 0.15
        && (s.nonduty_legit_retention ?? 0) >= 0.50;
    });
    const killedNonDuty = (['L1','L2','L3'] as const).every((L) => (summary[L].nonduty_legit_retention ?? 0) < 0.25);
    verdict = support.length ? `SUPPORT_H1(${support.join(',')})` : killedNonDuty ? 'REJECT_H1(nonduty_overfit)' : 'INCONCLUSIVE';
  }

  const out = { token: 'f9-duty-attribution-eval',
    prereg_sha256: '2bac3a1310d702692f6cf967f25ee9b921a12077fd5fcde16a018c514ecea827',
    head: 'v0.0.19-78-g1e827f1-dirty', q1: L0r >= 0.50 ? 'Q1_SIGNAL_PRESENT' : L0r < 0.30 ? 'Q1_ABSENT' : 'Q1_WEAK',
    summary, malformed_rate: malformed, unknown_candidate_rate: unknown, primary_reselection_rate: primaryResel,
    verdict, live_db_writes: 0, product_changes: 0, finished_at: new Date().toISOString(), rows };
  const file = `bench/dutyAttribution/results/${out.finished_at.replace(/[:.]/g, '-')}.json`;
  fs.mkdirSync('bench/dutyAttribution/results', { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log('\n=== RESULT ===');
  for (const L of ['L0','L1','L2','L3']) {
    const s = summary[L];
    console.log(L, `recall_T=${s.correct_secondary_recall_T.toFixed(2)} fp_N=${s.fp_N.toFixed(2)} irrel=${s.irrelevant_candidate_approval_rate.toFixed(2)} nondutyRet=${s.nonduty_legit_retention?.toFixed(2)}`);
  }
  console.log('malformed', malformed, 'unknown', unknown, 'primary_resel', primaryResel);
  console.log('Q1:', out.q1); console.log('VERDICT:', verdict); console.log('file:', file);
}
main();
