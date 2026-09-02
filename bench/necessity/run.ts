/** f9-intervention-necessity-eval — paired SUFFICIENT / INSUFFICIENT contrast. */
import fs from 'node:fs';
import { SCENARIOS, CAST, type Cand } from '../dutyAttribution/fixtures.ts';

const MODEL = '/Users/llm/models/Gemma-4-Dark-Thoughts-V2-31B.i1-Q4_K_M.gguf';
const URL = 'http://100.97.170.121:8083/v1/chat/completions';
const CATS = ['DUTY','AUTHORITY','RELATIONSHIP','EXCLUSIVE_KNOWLEDGE','CURRENT_ACTION','DIRECT_ADDRESS','DIRECT_OBSERVATION'];
const T = SCENARIOS.filter((s) => s.bucket === 'T');

function attrLines(c: Cand): string {
  const a = c.attrs; const p: string[] = [];
  if (a.duties.length) p.push(`직무: ${a.duties.join(', ')}`);
  if (a.authority.length) p.push(`권한: ${a.authority.join(', ')}`);
  if (a.relationships.length) p.push(`관계: ${a.relationships.join(', ')}`);
  if (a.exclusive_knowledge.length) p.push(`아는 것: ${a.exclusive_knowledge.join(', ')}`);
  if (a.current_action.length) p.push(`지금 하는 일: ${a.current_action.join(', ')}`);
  return p.length ? p.join(' / ') : '(등록된 속성 없음)';
}

/** The ONLY thing that differs between conditions. */
function primaryLine(s: typeof T[number], cond: 'SUFF' | 'INSUF'): string {
  const target = CAST[s.correct[0]];
  if (cond === 'SUFF') {
    // primary fully covers the point the correct secondary would have raised
    return `제가 이미 확인했습니다. ${attrLines(target).replace(/^(직무|권한|관계|아는 것|지금 하는 일): /, '')} 부분은 제가 직접 처리했고, 결과도 방금 전부 전달드렸습니다. 더 필요한 건 없습니다.`;
  }
  return '저는 그 부분까지는 확인하지 못했습니다. 제 권한 밖이라 여기서 더 말씀드릴 게 없습니다.';
}

function promptV1(s: typeof T[number], cond: 'SUFF' | 'INSUF'): string {
  const primary = CAST[s.primary];
  return [
    '너는 장면 진행 판정기다. 서사나 대사를 쓰지 않는다.',
    '', `현재 주화자는 '${primary.name}' 이다. 주화자는 이미 이 턴에 답했으므로 후보가 아니다.`,
    '아래 후보 각각에 대해서만 판정한다. 후보 목록에 없는 인물을 새로 만들지 않는다.',
    ...s.candidates.map((id) => `- candidate_id: ${id} / 이름: ${CAST[id].name} / ${attrLines(CAST[id])}`),
    '', '## 사용자 입력', s.event,
    `## '${primary.name}' 가 방금 한 답변`, primaryLine(s, cond),
    '', `주화자가 방금 한 답변으로 이미 처리된 내용이면 approve 하지 않는다.`,
    '주화자의 답변에 더해 그 후보가 지금 반드시 덧붙여야 할 내용이 있을 때만 approve 한다.',
    `claim_type 은 다음 중 하나: ${CATS.join(' / ')}`,
    '', '오직 JSON 하나만 출력한다. 형식:',
    '{"candidate_decisions": [{"candidate_id": "...", "decision": "approve" | "reject", "claim_type": "...", "reason": "짧은 근거"}]}',
  ].join('\n');
}

function promptV2(s: typeof T[number], cond: 'SUFF' | 'INSUF'): string {
  const primary = CAST[s.primary];
  return [
    '너는 장면 진행 판정기다. 서사나 대사를 쓰지 않는다.',
    '', `현재 주화자는 '${primary.name}' 이다.`,
    '', '## 사용자 입력', s.event,
    `## '${primary.name}' 가 방금 한 답변`, primaryLine(s, cond),
    '', '## 이 장면의 다른 인물',
    ...s.candidates.map((id) => `- candidate_id: ${id} / 이름: ${CAST[id].name} / ${attrLines(CAST[id])}`),
    '', '먼저 판단한다: 주화자의 위 답변만으로 이 턴이 마무리되는가, 아니면 다른 인물이 반드시 한 마디 덧붙여야 하는가?',
    'extra_needed 를 먼저 정한다. 마무리된다면 no 이고, 그 경우 speaker 는 null 이다.',
    '', '오직 JSON 하나만 출력한다. 형식:',
    '{"extra_needed": "yes" | "no", "speaker": "candidate_id 또는 null", "reason": "짧은 근거"}',
  ].join('\n');
}

async function call(p: string) {
  try {
    const r = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: p }],
        temperature: 0.2, top_p: 0.9, max_tokens: 400, chat_template_kwargs: { enable_thinking: false } }) });
    const j: any = await r.json(); return j.choices?.[0]?.message?.content ?? '';
  } catch { return ''; }
}
function parse(raw: string): any | null {
  const i = raw.indexOf('{'), k = raw.lastIndexOf('}');
  if (i < 0 || k <= i) return null;
  try { return JSON.parse(raw.slice(i, k + 1)); } catch { return null; }
}

async function main() {
  const rows: any[] = [];
  for (const V of ['V1', 'V2'] as const) {
    for (const s of T) {
      for (const cond of ['SUFF', 'INSUF'] as const) {
        const raw = await call(V === 'V1' ? promptV1(s, cond) : promptV2(s, cond));
        const o = parse(raw);
        let approved: string[] = []; let extraNeeded: string | null = null; let ok = false;
        if (o) {
          if (V === 'V1') {
            const arr = Array.isArray(o.candidate_decisions) ? o.candidate_decisions : null;
            ok = arr !== null;
            approved = (arr ?? []).filter((d: any) => d?.decision === 'approve')
              .map((d: any) => String(d?.candidate_id ?? '')).filter(Boolean);
          } else {
            ok = o.extra_needed === 'yes' || o.extra_needed === 'no';
            extraNeeded = ok ? o.extra_needed : null;
            const sp = o.speaker; const sps = typeof sp === 'string' ? sp.trim() : '';
            if (o.extra_needed === 'yes' && sps && sps !== 'null') approved = [sps];
          }
        }
        const unknown = approved.some((a) => !s.candidates.includes(a) && a !== s.primary);
        rows.push({ variant: V, scenario: s.id, cond, raw, ok, extraNeeded, approved,
          any: approved.length > 0, correct_target: approved.includes(s.correct[0]),
          primary_resel: approved.includes(s.primary), unknown });
        process.stdout.write(`${V} ${s.id} ${cond} any=${approved.length > 0 ? 1 : 0}\n`);
      }
    }
  }

  const summary: any = {};
  for (const V of ['V1', 'V2'] as const) {
    const rs = rows.filter((r) => r.variant === V);
    const su = rs.filter((r) => r.cond === 'SUFF'), ins = rs.filter((r) => r.cond === 'INSUF');
    const aS = su.filter((r) => r.any).length / su.length;
    const aI = ins.filter((r) => r.any).length / ins.length;
    const flips = T.filter((s) => {
      const a = rs.find((r) => r.scenario === s.id && r.cond === 'SUFF');
      const b = rs.find((r) => r.scenario === s.id && r.cond === 'INSUF');
      return a && b && a.any !== b.any;
    }).length / T.length;
    summary[V] = {
      necessity_discrimination: aI - aS,
      approve_rate_SUFFICIENT: aS, approve_rate_INSUFFICIENT: aI,
      correct_target_rate_INSUFFICIENT: ins.filter((r) => r.correct_target).length / ins.length,
      flip_rate: flips,
      extra_needed_yes_SUFF: V === 'V2' ? su.filter((r) => r.extraNeeded === 'yes').length / su.length : null,
      extra_needed_yes_INSUF: V === 'V2' ? ins.filter((r) => r.extraNeeded === 'yes').length / ins.length : null,
      malformed: rs.filter((r) => !r.ok).length / rs.length,
      unknown: rs.filter((r) => r.unknown).length / rs.length,
      primary_reselection: rs.filter((r) => r.primary_resel).length / rs.length,
    };
  }
  const mal = Math.max(summary.V1.malformed, summary.V2.malformed);
  let verdict: string;
  const rejected = (['V1','V2'] as const).filter((V) => {
    const s = summary[V];
    return s.necessity_discrimination >= 0.40 && s.approve_rate_INSUFFICIENT >= 0.60 && s.approve_rate_SUFFICIENT <= 0.30;
  });
  if (mal > 0.10) verdict = 'INSUFFICIENT';
  else if (rejected.length) verdict = `H5_REJECTED(${rejected.join(',')})`;
  else if ((['V1','V2'] as const).every((V) => summary[V].necessity_discrimination < 0.20)) verdict = 'H5_SUPPORTED';
  else verdict = 'INCONCLUSIVE';

  const out = { token: 'f9-intervention-necessity-eval',
    prereg_sha256: '2f9f19d46d61b259ac69cb29f14a153c9bb52c5f75dec69fde0cef715c210fb1',
    head: 'v0.0.19-78-g1e827f1-dirty', summary, verdict,
    live_db_writes: 0, product_changes: 0, finished_at: new Date().toISOString(), rows };
  fs.mkdirSync('bench/necessity/results', { recursive: true });
  const file = `bench/necessity/results/${out.finished_at.replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log('\n=== RESULT ===');
  for (const V of ['V1','V2']) console.log(V, JSON.stringify(summary[V]));
  console.log('VERDICT:', verdict); console.log('file:', file);
}
main();
