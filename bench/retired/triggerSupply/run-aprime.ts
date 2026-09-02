/** f9-trigger-supply-aprime-eval — prompt-strengthening variants. Bench-local prompt edits only. */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { renderSceneDeltaPrompt, parseSceneDelta, currentSceneVersion } from '../../../apps/server/src/prompt/sceneDeltaPrompt.ts';
import { catalogFromStory } from '../../../apps/server/src/prompt/sceneCatalog.ts';
import { partyCastForGenerate } from '../../../apps/server/src/prompt/composeBeat.ts';
import { parseSecondaryTriggers, eligibleSecondaries } from './retiredAuxGate.ts';
import { T, N } from './fixtures.ts';

const CONV = '552e0205-1908-4d37-817f-32090628c57e';
const MODEL = '/Users/llm/models/Gemma-4-Dark-Thoughts-V2-31B.i1-Q4_K_M.gguf';
const URL = 'http://100.97.170.121:8083/v1/chat/completions';

/** A'-1: make the key mandatory so "[]" and "absent" become distinguishable. */
const APRIME1 = (base: string, v: number) => base + [
  '',
  `secondary_triggers 는 **반드시** 최상위에 포함한다. 끼어들 인물이 없으면 빈 배열로 낸다.`,
  `{"base_version": ${v}, "secondary_triggers": []}`,
].join('\n');

/** A'-2: A'-1 plus an explicit criterion for when someone should interject. */
const APRIME2 = (base: string, v: number) => APRIME1(base, v) + [
  '',
  '끼어들 인물 판단 기준: 지금 참석 중이고, 방금 사용자 입력이 그 인물의 직무나 안전 책임과 직접 닿을 때만 넣는다.',
  '해당하면 {"character": 이름, "reason": 짧은 사유} 를 배열에 담는다. 해당 없으면 빈 배열을 유지한다.',
].join('\n');

async function main() {
  const db = new Database('/home/hermes/rpchat/data/rpchat.db', { readonly: true });
  const conv: any = db.prepare('SELECT * FROM conversations WHERE id=?').get(CONV);
  const roster: any[] = db.prepare('SELECT c.id,c.name,c.tags_json FROM story_characters sc JOIN characters c ON c.id=sc.character_id WHERE sc.story_id=?').all(conv.story_id);
  const catRow: any = db.prepare('SELECT scene_catalog FROM stories WHERE id=?').get(conv.story_id);
  const cast = partyCastForGenerate(conv, roster)!;
  const soyeon = cast.find((c) => c.name.startsWith('한소연'))!;
  const yuki = cast.find((c) => c.name.startsWith('유키'))!;
  const catalog = { ...catalogFromStory(catRow.scene_catalog), cast };
  const scene = { location: 'bureau_lobby', present_ids: cast.map((c) => c.id), scene_version: 0 };
  const baseV = currentSceneVersion(scene);
  db.close();

  const variants = [['A1', APRIME1], ['A2', APRIME2]] as const;
  const all: any[] = [];
  for (const [vname, wrap] of variants) {
    for (const [bucket, list] of [['T', T], ['N', N]] as const) {
      for (const userText of list) {
        const prompt = wrap(renderSceneDeltaPrompt({ scene, catalog, userText }), baseV);
        let text = ''; const t0 = Date.now();
        try {
          const r = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }],
              temperature: 0.2, top_p: 0.9, max_tokens: 200, chat_template_kwargs: { enable_thinking: false } }) });
          const j: any = await r.json(); text = j.choices?.[0]?.message?.content ?? '';
        } catch (e) { text = ''; }
        const patch = parseSceneDelta(text);
        const key_present = patch !== null && 'secondary_triggers' in patch;
        const triggers = parseSecondaryTriggers(patch);
        const elig = patch ? eligibleSecondaries({ triggers, cast, scene, mainId: soyeon.id }) : [];
        all.push({ variant: vname, bucket, userText, ms: Date.now() - t0, raw: text,
          parsed_ok: patch !== null, key_present,
          base_version_ok: patch ? patch.base_version === baseV : false,
          trigger_count: triggers.length, eligible_yuki: elig.some((e) => e.character_id === yuki.id),
          unresolved: triggers.length > 0 && elig.length === 0 });
        process.stdout.write(`${vname} ${bucket} ${all.length}/80 key=${key_present?1:0} trig=${triggers.length}\n`);
      }
    }
  }

  const summary: any = {};
  for (const [vname] of variants) {
    const rows = all.filter((r) => r.variant === vname);
    const t = rows.filter((r) => r.bucket === 'T'); const n = rows.filter((r) => r.bucket === 'N');
    const key_present_rate = rows.filter((r) => r.key_present).length / rows.length;
    const totalTrig = rows.reduce((a, r) => a + r.trigger_count, 0);
    const recall_T = t.filter((r) => r.eligible_yuki).length / t.length;
    const fp_N_raw = n.filter((r) => r.trigger_count > 0).length / n.length;
    summary[vname] = {
      key_present_rate, recall_T,
      fp_N: (key_present_rate >= 0.5 && totalTrig > 0) ? fp_N_raw : 'UNINTERPRETABLE',
      malformed: rows.filter((r) => !r.parsed_ok || r.unresolved).length / rows.length,
      base_version_ok: rows.filter((r) => r.base_version_ok).length / rows.length,
      total_triggers: totalTrig,
    };
  }
  const best = Math.max(...variants.map(([v]) => summary[v].recall_T));
  const adopted = variants.map(([v]) => v).filter((v) => {
    const s = summary[v];
    return s.recall_T >= 0.60 && s.malformed <= 0.10 && (s.fp_N === 'UNINTERPRETABLE' || s.fp_N <= 0.20);
  });
  const verdict = adopted.length ? `ADOPT_APRIME(${adopted.join(',')})` : best < 0.30 ? 'INSUFFICIENT' : 'INCONCLUSIVE';

  const out = { token: 'f9-trigger-supply-aprime-eval',
    prereg_sha256: 'da3cd78c2e8993a1cb303909e8dd7720c95ebf883afc5fd5796c53d38c556738',
    baseline_A_recall_T: 0.0, head: 'v0.0.19-78-g1e827f1-dirty',
    summary, verdict, live_db_writes: 0, product_prompt_changes: 0,
    finished_at: new Date().toISOString(), rows: all };
  const dir = path.join('bench/triggerSupply', 'results');
  const file = path.join(dir, `aprime-${out.finished_at.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log('\n=== RESULT ===');
  for (const [v] of variants) console.log(v, JSON.stringify(summary[v]));
  console.log('VERDICT:', verdict); console.log('file:', file);
}
main();
