/**
 * f9-tags-catalog — characters.tags_json → CastMember[] / PartyCatalog.
 *
 * Pure mapping. No DB, no fetch, no model. The roster is fetched by the caller.
 * Only tags carrying the `party:` prefix are read, so existing genre tags
 * (["모험","판타지",…]) stay inert and 1:1 conversations map to no cast.
 *
 * Tag grammar (all optional, all repeatable unless noted):
 *   party:role=main|secondary|background   role (last wins; invalid → secondary)
 *   party:duty=<token>                     duty, used by extra approval (§4.3)
 *   party:alias=<token>                    name form the focus resolver matches (§4.1)
 *   party:place=<location id>              default location (last wins); also a home place
 *   party:home=<location id>               where this NPC normally stands (presence only)
 *   party:talkative=<0..1>                 ambient narration weight ONLY (§4.4)
 *   party:locked=1                         UI 🔒 and never a conversation target
 *   party:outfit=<token>                   default outfit; per-turn value is scene_json.roster
 *   party:weather=<token>                  catalog only
 *   party:arc=<arc id>                     catalog only
 *   party:stage=<arc id>/<stage id>        catalog only
 *   party:flag=<key>[@<owner_stage>]       catalog only
 */
import type { CastMember, CastRole } from './cast.js';
import type { PartyCatalog } from './applySceneDelta.js';

const PREFIX = 'party:';

export type PartyTagRow = { id: string; name: string; tags_json: string };

export type ParsedPartyTags = {
  tagged: boolean;
  role: CastRole | null;
  duties: string[];
  aliases: string[];
  place: string;
  home_places: string[];
  weathers: string[];
  arcs: string[];
  stages: Array<{ arc: string; stage: string }>;
  flags: Array<{ key: string; owner_stage?: string }>;
  /** f9-focus-eligible §4.4. undefined = the cast default, not 0. */
  talkativeness?: number;
  locked: boolean;
  outfit: string;
};

function isRole(v: string): v is CastRole {
  return v === 'main' || v === 'secondary' || v === 'background';
}

function pushUnique(list: string[], v: string): void {
  if (v && !list.includes(v)) list.push(v);
}

export function parsePartyTags(tags: unknown): ParsedPartyTags {
  const out: ParsedPartyTags = {
    tagged: false,
    role: null,
    duties: [],
    aliases: [],
    place: '',
    home_places: [],
    weathers: [],
    arcs: [],
    stages: [],
    flags: [],
    locked: false,
    outfit: '',
  };
  if (!Array.isArray(tags)) return out;

  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim();
    if (!tag.startsWith(PREFIX)) continue;
    out.tagged = true;

    const body = tag.slice(PREFIX.length);
    const eq = body.indexOf('=');
    if (eq < 0) continue;
    const key = body.slice(0, eq).trim();
    const value = body.slice(eq + 1).trim();
    if (!value) continue;

    switch (key) {
      case 'role':
        out.role = isRole(value) ? value : 'secondary';
        break;
      case 'duty':
        pushUnique(out.duties, value);
        break;
      case 'alias':
        pushUnique(out.aliases, value);
        break;
      case 'place':
        out.place = value;
        pushUnique(out.home_places, value);
        break;
      case 'home':
        pushUnique(out.home_places, value);
        break;
      case 'talkative': {
        // §4.4: ambient weight only. Out-of-range or unparseable values fall back
        // to the cast default rather than silencing or over-weighting a character.
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0 && n <= 1) out.talkativeness = n;
        break;
      }
      case 'locked':
        out.locked = value === '1' || value === 'true';
        break;
      case 'outfit':
        out.outfit = value;
        break;
      case 'weather':
        pushUnique(out.weathers, value);
        break;
      case 'arc':
        pushUnique(out.arcs, value);
        break;
      case 'stage': {
        const slash = value.indexOf('/');
        if (slash > 0 && slash < value.length - 1) {
          out.stages.push({ arc: value.slice(0, slash), stage: value.slice(slash + 1) });
        }
        break;
      }
      case 'flag': {
        const at = value.indexOf('@');
        if (at > 0) out.flags.push({ key: value.slice(0, at), owner_stage: value.slice(at + 1) });
        else out.flags.push({ key: value });
        break;
      }
      default:
        break; // unknown party: key is ignored, never thrown
    }
  }
  return out;
}

function safeTags(row: PartyTagRow): unknown {
  try {
    return JSON.parse(row.tags_json || '[]');
  } catch {
    return [];
  }
}

/**
 * Returns null when the roster is not a party: fewer than two rows carry any
 * `party:` tag. That keeps every existing 1:1 conversation unstamped.
 */
export function castFromCharacters(rows: PartyTagRow[], mainCharacterId: string): CastMember[] | null {
  const tagged = rows
    .map((row) => ({ row, parsed: parsePartyTags(safeTags(row)) }))
    .filter((x) => x.parsed.tagged);
  if (tagged.length < 2) return null;

  return tagged.map(({ row, parsed }): CastMember => {
    let role: CastRole;
    if (row.id === mainCharacterId) role = 'main';
    else if (parsed.role === 'background') role = 'background';
    else role = 'secondary';
    return {
      id: row.id,
      name: row.name,
      aliases: parsed.aliases,
      duties: parsed.duties,
      place: parsed.place,
      home_places: parsed.home_places,
      role,
      // Only set when the tag was present, so `talkativenessOf` can apply the
      // documented default instead of treating an untagged character as silent.
      ...(parsed.talkativeness !== undefined ? { talkativeness: parsed.talkativeness } : {}),
      ...(parsed.locked ? { locked: true } : {}),
      ...(parsed.outfit ? { outfit: parsed.outfit } : {}),
    };
  });
}

/**
 * The character this conversation was opened as must be able to speak even when
 * they have no `party:` tags (live 서리 on F9-LIVE-PARTY-SMOKE). Untagged rows
 * stay out of `castFromCharacters`; this splice puts only the starter back.
 */
export function withConversationStarter(
  cast: CastMember[],
  starter: { id: string; name: string },
): CastMember[] {
  if (cast.some((m) => m.id === starter.id)) {
    return cast.map((m) => (m.id === starter.id ? { ...m, role: 'main' } : m));
  }
  return [
    {
      id: starter.id,
      name: starter.name,
      aliases: [],
      duties: [],
      place: '',
      role: 'main',
    },
    ...cast,
  ];
}

export function catalogFromCharacters(rows: PartyTagRow[]): PartyCatalog {
  const locations: string[] = [];
  const weathers: string[] = [];
  const arcs: string[] = [];
  const stagesByArc: Record<string, string[]> = {};
  const flags: PartyCatalog['flags'] = {};

  for (const row of rows) {
    const parsed = parsePartyTags(safeTags(row));
    if (!parsed.tagged) continue;
    pushUnique(locations, parsed.place);
    for (const w of parsed.weathers) pushUnique(weathers, w);
    for (const a of parsed.arcs) pushUnique(arcs, a);
    for (const s of parsed.stages) {
      pushUnique(arcs, s.arc);
      if (!stagesByArc[s.arc]) stagesByArc[s.arc] = [];
      pushUnique(stagesByArc[s.arc], s.stage);
    }
    for (const f of parsed.flags) {
      flags[f.key] = f.owner_stage ? { owner_stage: f.owner_stage } : {};
    }
  }

  return { weathers, locations, arcs, stagesByArc, flags };
}
