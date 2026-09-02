/** f9-aux-candidate-supply-eval — C-1 (primary named) vs C-2 (closed candidate set). Bench-local prompts. */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { renderSceneDeltaPrompt, parseSceneDelta, currentSceneVersion } from '../../../apps/server/src/prompt/sceneDeltaPrompt.ts';
import { catalogFromStory } from '../../../apps/server/src/prompt/sceneCatalog.ts';
import { partyCastForGenerate } from '../../../apps/server/src/prompt/composeBeat.ts';
import type { CastMember } from '../../../apps/server/src/prompt/cast.ts';
import { T, N } from './fixtures.ts';

const CONV = '552e0205-1908-4d37-817f-32090628c57e';
const MODEL = '/Users/llm/models/Gemma-4-Dark-Thoughts-V2-31B.i1-Q4_K_M.gguf';
const URL = 'http://100.97.170.121:8083/v1/chat/completions';

async function call(prompt: string) {
  try {
    const r = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }],
        temperature: 0.2, top_p: 0.9, max_tokens: 300, chat_template_kwargs: { enable_thinking: false } }) });
    const j: any = await r.json();
    return j.choices?.[0]?.message?.content ?? '';
  } catch { return ''; }
}

async function main() {
  const db = new Database('/home/hermes/rpchat/data/rpchat.db', { readonly: true });
  const conv: any = db.prepare('SELECT * FROM conversations WHERE id=?').get(CONV);
  const roster: any[] = db.prepare('SELECT c.id,c.name,c.tags_json FROM story_characters sc JOIN characters c ON c.id=sc.character_id WHERE sc.story_id=?').all(conv.story_id);
  const catRow: any = db.prepare('SELECT scene_catalog FROM stories WHERE id=?').get(conv.story_id);
  const liveCast = partyCastForGenerate(conv, roster)!;
  db.close();

  const primary = liveCast.find((c) => c.name.startsWith('한소연'))!;
  const yuki = liveCast.find((c) => c.name.startsWith('유키'))!;
  // §4 bench-local cast extension: a present, duty-less secondary so the candidate set is >1.
  const clerk: CastMember = { id: 'bench-clerk-b', name: '직원B', aliases: [], duties: [],
    place: 'bureau_lobby', role: 'secondary', home_places: ['bureau_lobby'] };
  const cast = [...liveCast, clerk];
  const candidates = cast.filter((c) => c.id !== primary.id && c.role !== 'background');

  const catalog = { ...catalogFromStory(catRow.scene_catalog), cast };
  const scene = { location: 'bureau_lobby', present_ids: cast.map((c) => c.id), scene_version: 0 };
  const baseV = currentSceneVersion(scene);

  const C1 = (base: string) => base + [
    '', `현재 주화자는 '${primary.name}' 이다. 주화자는 이미 이 턴에 답한다.`,
    '주화자는 secondary 후보가 아니다. 주화자를 secondary_triggers 에 넣지 않는다.',
    'secondary_triggers 는 반드시 최상위에 포함한다. 해당 인물이 없으면 빈 배열로 낸다.',
    '주화자의 응답과 별개로 독립적인 개입 근거가 있는 인물만 넣는다. 단순히 관련 있다는 이유로 넣지 않는다.',
    `{"base_version": ${baseV}, "secondary_triggers": []}`,
  ].join('\n');

  const C2 = (base: string) => base + [
    '', `현재 주화자는 '${primary.name}' 이다. 주화자는 이미 이 턴에 답하므로 후보가 아니다.`,
    '아래 후보 각각에 대해서만 판정한다. 후보 목록에 없는 인물을 새로 만들지 않는다.',
    ...candidates.map((c) => `- id: ${c.id} / 이름: ${c.name} / 직무: ${c.duties.join(', ') || '(없음)'}`),
    '',
    `주화자의 응답과 별개로 그 후보가 지금 개입해야 할 독립적 근거가 있으면 approve, 없으면 reject 한다.`,
    '단순히 상황과 관련 있다는 이유만으로 approve 하지 않는다.',
    '최상위에 candidate_decisions 를 반드시 포함한다. 형식:',
    `{"base_version": ${baseV}, "candidate_decisions": [{"candidate_id": "...", "decision": "approve" | "reject", "reason": "짧은 사유"}]}`,
  ].join('\n');

  const variants = [['C1', C1], ['C2', C2]] as const;
  const all: any[] = [];
  for (const [vname, wrap] of variants) {
    for (const [bucket, list] of [['T', T], ['N', N]] as const) {
      for (const userText of list) {
        const raw = await call(wrap(renderSceneDeltaPrompt({ scene, catalog, userText })));
        const patch = parseSceneDelta(raw);
        let approvedIds: string[] = []; let namedUnknown = false; let formatOk = false;
        if (patch) {
          if (vname === 'C1') {
            const arr = Array.isArray((patch as any).secondary_triggers) ? (patch as any).secondary_triggers : null;
            formatOk = arr !== null;
            for (const t of arr ?? []) {
              const nm = typeof t?.character === 'string' ? t.character.trim() : '';
              const m = cast.find((c) => c.name === nm || (c.aliases ?? []).includes(nm));
              if (m) approvedIds.push(m.id); else if (nm) namedUnknown = true;
            }
          } else {
            const arr = Array.isArray((patch as any).candidate_decisions) ? (patch as any).candidate_decisions : null;
            formatOk = arr !== null;
            for (const d of arr ?? []) {
              const id = typeof d?.candidate_id === 'string' ? d.candidate_id.trim() : '';
              const ok = d?.decision === 'approve' && typeof d?.reason === 'string' && d.reason.trim();
              const m = cast.find((c) => c.id === id || c.name === id);
              if (!m) { if (id) namedUnknown = true; continue; }
              if (ok) approvedIds.push(m.id);
            }
          }
        }
        approvedIds = [...new Set(approvedIds)];
        all.push({ variant: vname, bucket, userText, raw, parsed_ok: patch !== null, formatOk,
          base_version_ok: patch ? (patch as any).base_version === baseV : false,
          approved: approvedIds, primary_reselected: approvedIds.includes(primary.id),
          yuki_approved: approvedIds.includes(yuki.id), clerk_approved: approvedIds.includes(clerk.id),
          unknown: namedUnknown });
        process.stdout.write(`${vname} ${bucket} ${all.length}/80 appr=${approvedIds.length} prim=${approvedIds.includes(primary.id)?1:0}\n`);
      }
    }
  }

  const summary: any = {};
  for (const [v] of variants) {
    const rows = all.filter((r) => r.variant === v);
    const t = rows.filter((r) => r.bucket === 'T'); const n = rows.filter((r) => r.bucket === 'N');
    const totalApprovals = rows.reduce((a, r) => a + r.approved.length, 0);
    summary[v] = {
      primary_reselection_rate: rows.filter((r) => r.primary_reselected).length / rows.length,
      recall_T: t.filter((r) => r.yuki_approved).length / t.length,
      fp_N: totalApprovals > 0 ? n.filter((r) => r.approved.length > 0).length / n.length : 'UNINTERPRETABLE',
      irrelevant_approval_rate: rows.filter((r) => r.clerk_approved).length / rows.length,
      unknown_candidate_rate: rows.filter((r) => r.unknown).length / rows.length,
      malformed: rows.filter((r) => !r.parsed_ok || !r.formatOk).length / rows.length,
      base_version_ok: rows.filter((r) => r.base_version_ok).length / rows.length,
      total_approvals: totalApprovals,
    };
  }
  const adopted = variants.map(([v]) => v).filter((v) => {
    const s = summary[v];
    return s.recall_T >= 0.60 && s.primary_reselection_rate <= 0.05 && s.malformed <= 0.10
      && s.unknown_candidate_rate <= 0.05 && (s.fp_N === 'UNINTERPRETABLE' || s.fp_N <= 0.20);
  });
  const best = Math.max(...variants.map(([v]) => summary[v].recall_T));
  const verdict = adopted.length ? `ADOPT_SUPPLY(${adopted.join(',')})` : best < 0.30 ? 'INSUFFICIENT' : 'INCONCLUSIVE';

  const out = { token: 'f9-aux-candidate-supply-eval',
    prereg_sha256: 'c4340d05153b71949b3f9712c91096f83ef639344d7d0149700bb2b403e1548e',
    baseline: { A_recall_T: 0.0, Aprime2_primary_reselection: 1.0 },
    head: 'v0.0.19-78-g1e827f1-dirty', summary, verdict,
    live_db_writes: 0, product_changes: 0, finished_at: new Date().toISOString(), rows: all };
  const file = path.join('bench/triggerSupply/results', `candidate-${out.finished_at.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log('\n=== RESULT ===');
  for (const [v] of variants) console.log(v, JSON.stringify(summary[v]));
  console.log('VERDICT:', verdict); console.log('file:', file);
}
main();
