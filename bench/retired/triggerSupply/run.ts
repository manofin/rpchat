/** f9-trigger-supply-a-eval — measurement runner. Read-only DB, inference only, no writes to live state. */
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

async function main() {
  const db = new Database('/home/hermes/rpchat/data/rpchat.db', { readonly: true });
  const conv: any = db.prepare('SELECT * FROM conversations WHERE id=?').get(CONV);
  const roster: any[] = db.prepare(
    'SELECT c.id,c.name,c.tags_json FROM story_characters sc JOIN characters c ON c.id=sc.character_id WHERE sc.story_id=?',
  ).all(conv.story_id);
  const catRow: any = db.prepare('SELECT scene_catalog FROM stories WHERE id=?').get(conv.story_id);
  const cast = partyCastForGenerate(conv, roster)!;
  const soyeon = cast.find((c) => c.name.startsWith('한소연'))!;
  const yuki = cast.find((c) => c.name.startsWith('유키'))!;
  const catalog = { ...catalogFromStory(catRow.scene_catalog), cast };
  const scene = { location: 'bureau_lobby', present_ids: cast.map((c) => c.id), scene_version: 0 };
  const baseV = currentSceneVersion(scene);
  db.close();

  const rows: any[] = [];
  for (const [bucket, list] of [['T', T], ['N', N]] as const) {
    for (const userText of list) {
      const prompt = renderSceneDeltaPrompt({ scene, catalog, userText });
      const t0 = Date.now();
      let text = '';
      let err: string | null = null;
      try {
        const r = await fetch(URL, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }],
            temperature: 0.2, top_p: 0.9, max_tokens: 200, chat_template_kwargs: { enable_thinking: false } }),
        });
        const j: any = await r.json();
        text = j.choices?.[0]?.message?.content ?? '';
      } catch (e) { err = String(e); }
      const ms = Date.now() - t0;
      const patch = parseSceneDelta(text);
      const triggers = parseSecondaryTriggers(patch);
      const elig = patch
        ? eligibleSecondaries({ triggers, cast, scene, mainId: soyeon.id })
        : [];
      rows.push({
        bucket, userText, ms, err, raw: text,
        parsed_ok: patch !== null,
        base_version_ok: patch ? patch.base_version === baseV : false,
        trigger_count: triggers.length,
        eligible_yuki: elig.some((e) => e.character_id === yuki.id),
        eligible: elig,
        unresolved: triggers.length > 0 && elig.length === 0,
      });
      process.stdout.write(`${bucket} ${rows.length}/40 trig=${triggers.length} elig=${elig.length} ${ms}ms\n`);
    }
  }

  const t = rows.filter((r) => r.bucket === 'T');
  const n = rows.filter((r) => r.bucket === 'N');
  const recall_T = t.filter((r) => r.eligible_yuki).length / t.length;
  const fp_N = n.filter((r) => r.trigger_count > 0).length / n.length;
  const malformed = rows.filter((r) => !r.parsed_ok || r.unresolved).length / rows.length;
  const base_version_ok = rows.filter((r) => r.base_version_ok).length / rows.length;

  const verdict = recall_T >= 0.60 && fp_N <= 0.20 && malformed <= 0.10
    ? 'ADOPT_A' : recall_T < 0.30 ? 'INSUFFICIENT_A' : 'INCONCLUSIVE';

  const out = {
    token: 'f9-trigger-supply-a-eval',
    prereg_sha256: '8ed4dce00a7419cbc55e11c6b6083118a22bc7b1b7d148d33605024e623f2e1d',
    head: 'v0.0.19-78-g1e827f1-dirty', model: MODEL,
    n_total: rows.length, recall_T, fp_N, malformed, base_version_ok, verdict,
    cuts: { ADOPT_A: 'recall_T>=0.60 && fp_N<=0.20 && malformed<=0.10', INSUFFICIENT_A: 'recall_T<0.30' },
    live_db_writes: 0, product_code_changes: 0,
    finished_at: new Date().toISOString(), rows,
  };
  const dir = path.join(import.meta.dirname ?? 'bench/triggerSupply', 'results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${out.finished_at.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log('\n=== RESULT ===');
  console.log('recall_T        :', recall_T.toFixed(3));
  console.log('fp_N            :', fp_N.toFixed(3));
  console.log('malformed       :', malformed.toFixed(3));
  console.log('base_version_ok :', base_version_ok.toFixed(3));
  console.log('VERDICT         :', verdict);
  console.log('file            :', file);
}
main();
