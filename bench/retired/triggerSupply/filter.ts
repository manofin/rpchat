/** Validity filter: only sentences where pickSpeaker keeps 한소연 as main are eligible. */
import Database from 'better-sqlite3';
import { partyCastForGenerate } from '../../../apps/server/src/prompt/composeBeat.ts';
import { pickSpeaker } from './retiredRouter.ts';
import { T, N } from './fixtures.ts';

const CONV = '552e0205-1908-4d37-817f-32090628c57e';
const db = new Database('/home/hermes/rpchat/data/rpchat.db', { readonly: true });
const conv: any = db.prepare('SELECT * FROM conversations WHERE id=?').get(CONV);
const roster: any[] = db.prepare(
  'SELECT c.id,c.name,c.tags_json FROM story_characters sc JOIN characters c ON c.id=sc.character_id WHERE sc.story_id=?',
).all(conv.story_id);
const cast = partyCastForGenerate(conv, roster)!;
const scene = { location: 'bureau_lobby', present_ids: cast.map((c) => c.id), scene_version: 0 };
const soyeon = cast.find((c) => c.name.startsWith('한소연'))!;

function report(label: string, list: string[]) {
  let ok = 0;
  const rejected: string[] = [];
  for (const s of list) {
    const r = pickSpeaker({ user_text: s, scene, cast });
    const mainId = r.main_speaker_id ?? conv.character_id;
    if (mainId === soyeon.id) ok++;
    else rejected.push(`${r.decided_stage}|${cast.find((c) => c.id === mainId)?.name}|${s.slice(0, 40)}`);
  }
  console.log(`${label}: eligible ${ok}/${list.length}`);
  for (const r of rejected) console.log(`   REJECT ${r}`);
}
report('T', T);
report('N', N);
db.close();
