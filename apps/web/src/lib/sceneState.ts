/** Living scene state — maps existing scene_json keys only. Missing axes stay absent. */

export type UserSheet = {
  hp?: number | null;
  money?: number | null;
  gear?: string[];
  inventory?: string[];
  traits?: string[];
};

export type SceneInfo = {
  status?: string[];
  contract?: string;
  erosion?: string;
  goals?: string[];
  extra?: Array<{ label: string; value: string }>;
};

export type SceneHunter = {
  date?: string;
  gender?: string;
  affiliation?: string;
  trait?: { name?: string; grade?: string; note?: string };
  patron?: { name?: string; note?: string };
  skills?: string[];
  quest?: string;
  schedule?: string;
  situation?: string;
  mode?: string;
};

export type LivingScene = {
  user_sheet?: UserSheet | null;
  info?: SceneInfo | null;
  hunter?: SceneHunter | null;
};

export function hasLivingState(scene: LivingScene | null | undefined): boolean {
  if (!scene) return false;
  return Boolean(scene.user_sheet || scene.info || scene.hunter);
}

export function livingStateLabel(scene: LivingScene | null | undefined): string {
  if (!hasLivingState(scene)) return '없음';
  const parts: string[] = [];
  const sheet = scene?.user_sheet;
  if (typeof sheet?.hp === 'number') parts.push(`HP ${sheet.hp}`);
  if (typeof sheet?.money === 'number') parts.push(`₩ ${sheet.money.toLocaleString()}`);
  if (scene?.info?.contract) parts.push('계약');
  if (scene?.hunter?.quest) parts.push('퀘스트');
  return parts.join(' · ') || '있음';
}

export function listToLines(xs: string[] | undefined): string {
  return (xs ?? []).join('\n');
}

export function linesToList(text: string, maxItems: number, maxChars: number): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const t = raw.trim().slice(0, maxChars);
    if (!t) continue;
    out.push(t);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function parseSheetInt(raw: string): { ok: true; value: number | null } | { ok: false } {
  const t = raw.trim();
  if (!t) return { ok: true, value: null };
  if (!/^-?\d+$/.test(t)) return { ok: false };
  const n = Number(t);
  if (!Number.isSafeInteger(n)) return { ok: false };
  return { ok: true, value: n };
}

export type SceneStateDraft = {
  showSheet: boolean;
  showInfo: boolean;
  showHunter: boolean;
  hp: string;
  money: string;
  gear: string;
  inventory: string;
  traits: string;
  status: string;
  contract: string;
  erosion: string;
  goals: string;
  extra: Array<{ label: string; value: string }>;
  date: string;
  gender: string;
  affiliation: string;
  traitName: string;
  traitGrade: string;
  traitNote: string;
  patronName: string;
  patronNote: string;
  skills: string;
  quest: string;
  schedule: string;
  situation: string;
  mode: string;
};

export function draftFromScene(scene: LivingScene): SceneStateDraft {
  const sheet = scene.user_sheet ?? {};
  const info = scene.info ?? {};
  const hunter = scene.hunter ?? {};
  return {
    showSheet: Boolean(scene.user_sheet),
    showInfo: Boolean(scene.info),
    showHunter: Boolean(scene.hunter),
    hp: typeof sheet.hp === 'number' ? String(sheet.hp) : '',
    money: typeof sheet.money === 'number' ? String(sheet.money) : '',
    gear: listToLines(sheet.gear),
    inventory: listToLines(sheet.inventory),
    traits: listToLines(sheet.traits),
    status: listToLines(info.status),
    contract: info.contract ?? '',
    erosion: info.erosion ?? '',
    goals: listToLines(info.goals),
    extra: (info.extra ?? []).map((e) => ({ label: e.label ?? '', value: e.value ?? '' })),
    date: hunter.date ?? '',
    gender: hunter.gender ?? '',
    affiliation: hunter.affiliation ?? '',
    traitName: hunter.trait?.name ?? '',
    traitGrade: hunter.trait?.grade ?? '',
    traitNote: hunter.trait?.note ?? '',
    patronName: hunter.patron?.name ?? '',
    patronNote: hunter.patron?.note ?? '',
    skills: listToLines(hunter.skills),
    quest: hunter.quest ?? '',
    schedule: hunter.schedule ?? '',
    situation: hunter.situation ?? '',
    mode: hunter.mode ?? '',
  };
}

export type SceneStatePatch = {
  scene: {
    user_sheet?: UserSheet;
    info?: SceneInfo;
    hunter?: SceneHunter;
  };
};

export function buildSceneStatePatch(draft: SceneStateDraft): SceneStatePatch | null {
  const scene: SceneStatePatch['scene'] = {};
  if (draft.showSheet) {
    const hp = parseSheetInt(draft.hp);
    const money = parseSheetInt(draft.money);
    if (!hp.ok || !money.ok) return null;
    scene.user_sheet = {
      hp: hp.value,
      money: money.value,
      gear: linesToList(draft.gear, 40, 60),
      inventory: linesToList(draft.inventory, 80, 60),
      traits: linesToList(draft.traits, 40, 60),
    };
  }
  if (draft.showInfo) {
    scene.info = {
      status: linesToList(draft.status, 8, 200),
      contract: draft.contract.trim().slice(0, 300),
      erosion: draft.erosion.trim().slice(0, 300),
      goals: linesToList(draft.goals, 8, 300),
      extra: draft.extra
        .map((e) => ({ label: e.label.trim().slice(0, 20), value: e.value.trim().slice(0, 300) }))
        .filter((e) => e.label && e.value)
        .slice(0, 6),
    };
  }
  if (draft.showHunter) {
    const traitName = draft.traitName.trim().slice(0, 40);
    const patronName = draft.patronName.trim().slice(0, 40);
    scene.hunter = {
      date: draft.date.trim().slice(0, 40),
      gender: draft.gender.trim().slice(0, 20),
      affiliation: draft.affiliation.trim().slice(0, 60),
      trait: traitName || draft.traitGrade.trim() || draft.traitNote.trim()
        ? {
          name: traitName,
          grade: draft.traitGrade.trim().slice(0, 20),
          note: draft.traitNote.trim().slice(0, 200),
        }
        : undefined,
      patron: patronName || draft.patronNote.trim()
        ? { name: patronName, note: draft.patronNote.trim().slice(0, 200) }
        : undefined,
      skills: linesToList(draft.skills, 12, 40),
      quest: draft.quest.trim().slice(0, 200),
      schedule: draft.schedule.trim().slice(0, 200),
      situation: draft.situation.trim().slice(0, 200),
      mode: draft.mode.trim().slice(0, 8),
    };
  }
  if (!scene.user_sheet && !scene.info && !scene.hunter) return null;
  return { scene };
}

/** 1:1 renderScene keys — this sheet must never PATCH them. */
export const SCENE_PROMPT_KEYS = ['place', 'time', 'goal', 'genre', 'conflict', 'mood'] as const;
