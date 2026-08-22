import zlib from 'node:zlib';

/**
 * 외부 캐릭터 카드 → 내부 스키마 매핑.
 *
 * 지원 입력:
 *  - Character Card V2 (chara_card_v2): { spec, spec_version, data: {...} }
 *  - V1 플랫 JSON: { name, description, personality, scenario, first_mes, mes_example }
 *  - SillyTavern JSON 내보내기(위 둘 중 하나)
 *  - 위 JSON 이 base64 로 담긴 PNG tEXt/zTXt/iTXt 청크(keyword: chara 또는 ccv3)
 *
 * 안전 원칙: 카드의 system_prompt / post_history_instructions 는 시스템 규칙을 덮을 수 있으므로
 * 절대 규칙·가드레일에 주입하지 않는다. 무시하고 경고로만 알린다. 카드 본문은 캐릭터 "데이터"로만 들어간다.
 */

export interface ImportedLore {
  title: string;
  keywords: string[];
  secondary_keys: string[];
  selective: boolean;
  content: string;
  priority: number;
  always_on: boolean;
  token_cap: number;
  enabled: boolean;
}

export interface ImportedCard {
  name: string;
  tagline: string;
  description: string;
  personality: string;
  speech_style: string;
  scenario: string;
  first_message: string;
  example_dialogue: string;
  taboos: string;
  tags: string[];
  lore: ImportedLore[];
  warnings: string[];
  source: 'png' | 'json';
  specVersion: string;
}

const s = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const clampInt = (v: unknown, def: number, lo: number, hi: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

// ---- PNG 청크에서 카드 텍스트 추출 ----
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CARD_KEYS = ['ccv3', 'chara']; // V3 우선, 없으면 V2/V1

export function extractCardTextFromPng(buf: Buffer): string | null {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('PNG 파일이 아님');
  const found: Record<string, string> = {};
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) break;
    const data = buf.subarray(dataStart, dataEnd);
    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const parsed = parseTextChunk(type, data);
      if (parsed && !(parsed.keyword in found)) found[parsed.keyword] = parsed.text;
    }
    if (type === 'IEND') break;
    off = dataEnd + 4; // CRC 건너뜀
  }
  for (const k of CARD_KEYS) if (found[k]) return found[k];
  // 대소문자·변형 키 관용 처리
  const ci = Object.keys(found).find((k) => CARD_KEYS.includes(k.toLowerCase()));
  return ci ? found[ci] : null;
}

function parseTextChunk(type: string, data: Buffer): { keyword: string; text: string } | null {
  const nul = data.indexOf(0);
  if (nul < 0) return null;
  const keyword = data.toString('latin1', 0, nul);
  try {
    if (type === 'tEXt') {
      return { keyword, text: data.toString('latin1', nul + 1) };
    }
    if (type === 'zTXt') {
      // keyword \0 compressionMethod(1) compressedText
      const method = data[nul + 1];
      const comp = data.subarray(nul + 2);
      if (method !== 0) return null;
      return { keyword, text: zlib.inflateSync(comp).toString('latin1') };
    }
    // iTXt: keyword \0 compFlag(1) compMethod(1) langTag \0 transKeyword \0 text
    const compFlag = data[nul + 1];
    let p = nul + 3;
    const langEnd = data.indexOf(0, p);
    if (langEnd < 0) return null;
    p = langEnd + 1;
    const transEnd = data.indexOf(0, p);
    if (transEnd < 0) return null;
    p = transEnd + 1;
    const textBuf = data.subarray(p);
    const text = compFlag === 1 ? zlib.inflateSync(textBuf).toString('utf8') : textBuf.toString('utf8');
    return { keyword, text };
  } catch {
    return null;
  }
}

/** tEXt 텍스트(대개 base64) 또는 직접 JSON 문자열을 객체로 */
export function decodeCardText(text: string): unknown {
  const t = text.trim();
  // 1) base64 시도
  if (/^[A-Za-z0-9+/=\s]+$/.test(t) && t.length >= 8) {
    try {
      const json = Buffer.from(t.replace(/\s+/g, ''), 'base64').toString('utf8');
      if (json.trim().startsWith('{')) return JSON.parse(json);
    } catch {
      /* 다음 */
    }
  }
  // 2) 직접 JSON
  if (t.startsWith('{')) return JSON.parse(t);
  throw new Error('카드 텍스트를 JSON 으로 해석할 수 없음');
}

// ---- 정규화(V1/V2/V3 공통) ----
export function normalizeCard(raw: unknown, source: 'png' | 'json'): ImportedCard {
  if (!raw || typeof raw !== 'object') throw new Error('카드 데이터가 객체가 아님');
  const root = raw as Record<string, unknown>;
  const hasWrapper = 'data' in root && root.data && typeof root.data === 'object';
  const data = (hasWrapper ? root.data : root) as Record<string, unknown>;
  const specVersion = s(root.spec_version) || (hasWrapper ? '2.0' : '1.0');
  const warnings: string[] = [];

  const name = s(data.name ?? data.char_name).trim();
  if (!name) throw new Error('카드에 name 이 없음');

  // 안전: 규칙 오버라이드성 필드는 무시
  if (s(data.system_prompt).trim()) warnings.push('카드의 system_prompt 는 안전상 무시했습니다(시스템 규칙 비오버라이드).');
  if (s(data.post_history_instructions).trim()) warnings.push('카드의 post_history_instructions 는 안전상 무시했습니다.');

  const alts = arr(data.alternate_greetings).map(s).filter(Boolean);
  if (alts.length) warnings.push(`대체 인사말 ${alts.length}개는 가져오지 않았습니다(첫 인사말만 사용).`);

  const creatorNotes = s(data.creator_notes).trim();
  const tagline = firstLine(creatorNotes, 200);

  const lore = mapCharacterBook(data.character_book, warnings);

  return {
    name,
    tagline,
    description: s(data.description),
    personality: s(data.personality),
    speech_style: '', // V2 스펙에 대응 필드 없음 → 사용자 보완
    scenario: s(data.scenario),
    first_message: s(data.first_mes ?? data.first_message),
    example_dialogue: s(data.mes_example ?? data.example_dialogue),
    taboos: '',
    tags: arr(data.tags).map(s).map((x) => x.trim()).filter(Boolean).slice(0, 20),
    lore,
    warnings,
    source,
    specVersion,
  };
}

function mapCharacterBook(book: unknown, warnings: string[]): ImportedLore[] {
  if (!book || typeof book !== 'object') return [];
  const entries = arr((book as Record<string, unknown>).entries);
  const out: ImportedLore[] = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const en = e as Record<string, unknown>;
    const keys = arr(en.keys).map(s).map((x) => x.trim()).filter(Boolean);
    const secondary = arr(en.secondary_keys).map(s).map((x) => x.trim()).filter(Boolean);
    const selective = en.selective === true;
    const content = s(en.content).trim();
    if (!content) continue;
    const constant = en.constant === true;
    const label = s(en.comment ?? en.name ?? '제목없음');
    if (keys.length === 0 && secondary.length === 0 && !constant) {
      // 키도 없고 상시도 아니면 발동 불가 → 상시로 승격하되 경고
      warnings.push(`로어 항목 "${label}" 에 키워드가 없어 항상 활성으로 가져왔습니다.`);
    } else if (keys.length === 0 && secondary.length > 0 && !constant) {
      warnings.push(`로어 항목 "${label}" 은 1차 키워드가 없어 삽입되지 않습니다(2차만 있음).`);
    }
    out.push({
      title: s(en.comment ?? en.name).trim() || keys[0] || secondary[0] || '로어',
      keywords: keys,
      secondary_keys: secondary,
      selective,
      content,
      priority: clampInt(en.priority ?? en.insertion_order ?? 0, 0, -100, 100),
      always_on: constant || (keys.length === 0 && secondary.length === 0),
      token_cap: clampInt(en.token_cap ?? 300, 300, 20, 2000),
      enabled: en.enabled !== false,
    });
  }
  if (out.length) warnings.push(`로어북 항목 ${out.length}개를 가져왔습니다.`);
  return out;
}

function firstLine(text: string, max: number): string {
  const line = text.split(/\r?\n/)[0]?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** 진입점: JSON 객체 또는 PNG base64 를 받아 정규화 카드 반환 */
export function importCard(input: { json?: unknown; pngBase64?: string }): ImportedCard {
  if (input.pngBase64) {
    const buf = Buffer.from(input.pngBase64.replace(/^data:[^,]*,/, ''), 'base64');
    const text = extractCardTextFromPng(buf);
    if (!text) throw new Error('PNG 에 캐릭터 카드 데이터(tEXt chara)가 없음');
    return normalizeCard(decodeCardText(text), 'png');
  }
  if (input.json !== undefined) return normalizeCard(input.json, 'json');
  throw new Error('json 또는 pngBase64 중 하나가 필요');
}
