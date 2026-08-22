import fs from 'node:fs';
import path from 'node:path';
import { type DB, many, one, run, nowIso, uid, getSetting, setSetting } from './index.js';

const DEFAULT_PROFILES: Array<[string, number, number, number, string]> = [
  // name, temperature, top_p, max_tokens, notes
  ['rp-balanced', 0.8, 0.95, 400, '일상 대화 기본값. 짧고 빠르게.'],
  ['rp-creative', 1.0, 0.95, 700, '스토리 모드·장면 묘사. 길고 서사적으로.'],
  ['summary', 0.3, 0.9, 600, '에피소드 요약 초안 (JSON 출력).'],
  ['memory-extract', 0.2, 0.9, 400, '후보 기억 추출 (JSON 출력).'],
];

export const DEFAULT_CONTENT_POLICY =
  '성인 이용자 대상이다. 동의하는 성인 사이의 성적·폭력·어두운 묘사를 장면과 캐릭터 설정에 맞게 허용한다.';

export function seed(db: DB, contentDir: string, log: (msg: string) => void): void {
  // 프로필
  const existing = new Set(many<{ name: string }>(db, 'SELECT name FROM model_profiles').map((r) => r.name));
  for (const [name, temperature, top_p, max_tokens, notes] of DEFAULT_PROFILES) {
    if (existing.has(name)) continue;
    run(
      db,
      'INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)',
      name, temperature, top_p, max_tokens, '[]', 'system', notes,
    );
  }

  // 설정 기본값
  if (!one(db, 'SELECT 1 FROM settings WHERE key = ?', 'content_policy')) setSetting(db, 'content_policy', DEFAULT_CONTENT_POLICY);
  if (!one(db, 'SELECT 1 FROM settings WHERE key = ?', 'token_calibration')) setSetting(db, 'token_calibration', '1.0');
  getSetting(db, 'recent_window', '40');

  // 샘플 캐릭터/페르소나 (빈 DB 일 때만)
  const charCount = one<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM characters')?.c ?? 0;
  if (charCount === 0) {
    const dir = path.join(contentDir, 'characters');
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
        try {
          const card = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Record<string, unknown>;
          const id = uid();
          const t = nowIso();
          run(
            db,
            `INSERT INTO characters (id, name, tagline, description, personality, speech_style, scenario, first_message, example_dialogue, taboos, tags_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            String(card.name ?? f),
            String(card.tagline ?? ''),
            String(card.description ?? ''),
            String(card.personality ?? ''),
            String(card.speech_style ?? ''),
            String(card.scenario ?? ''),
            String(card.first_message ?? ''),
            String(card.example_dialogue ?? ''),
            String(card.taboos ?? ''),
            JSON.stringify(Array.isArray(card.tags) ? card.tags : []),
            t, t,
          );
          const lbId = uid();
          run(db, 'INSERT INTO lorebooks (id, character_id, name, created_at) VALUES (?, ?, ?, ?)', lbId, id, `${String(card.name)} 로어북`, t);
          const lore = Array.isArray(card.lore) ? (card.lore as Array<Record<string, unknown>>) : [];
          for (const e of lore) {
            run(
              db,
              'INSERT INTO lore_entries (id, lorebook_id, title, keywords_json, content, priority, always_on, token_cap, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)',
              uid(), lbId, String(e.title ?? ''), JSON.stringify(Array.isArray(e.keywords) ? e.keywords : []), String(e.content ?? ''),
              Number(e.priority ?? 0), e.always_on ? 1 : 0, Number(e.token_cap ?? 300),
            );
          }
          log(`샘플 캐릭터 적재: ${String(card.name)} (${f})`);
        } catch (err) {
          log(`샘플 캐릭터 적재 실패 ${f}: ${(err as Error).message}`);
        }
      }
    }
  }
  const personaCount = one<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM personas')?.c ?? 0;
  if (personaCount === 0) {
    const dir = path.join(contentDir, 'personas');
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
        try {
          const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Record<string, unknown>;
          const t = nowIso();
          run(
            db,
            'INSERT INTO personas (id, name, address_as, appearance, personality, relationship, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            uid(), String(p.name ?? '나'), String(p.address_as ?? ''), String(p.appearance ?? ''), String(p.personality ?? ''),
            String(p.relationship ?? ''), p.is_default ? 1 : 0, t, t,
          );
          log(`샘플 페르소나 적재: ${String(p.name)} (${f})`);
        } catch (err) {
          log(`샘플 페르소나 적재 실패 ${f}: ${(err as Error).message}`);
        }
      }
    }
  }
}
