/** 로어 삽입 여부. scanText 는 이미 toLowerCase 된 활성 컨텍스트. */
export function loreEntryActive(opts: {
  always_on: boolean | number;
  keywords: string[];
  secondary_keys?: string[];
  selective?: boolean | number;
  scanText: string;
}): boolean {
  if (opts.always_on === true || opts.always_on === 1) return true;
  const keys = (opts.keywords ?? []).map((k) => k.toLowerCase()).filter(Boolean);
  const secondary = (opts.secondary_keys ?? []).map((k) => k.toLowerCase()).filter(Boolean);
  const primaryHit = keys.some((k) => opts.scanText.includes(k));
  if (!primaryHit) return false;
  const selective = opts.selective === true || opts.selective === 1;
  if (selective && secondary.length > 0) {
    return secondary.some((k) => opts.scanText.includes(k));
  }
  return true;
}

/** 로어 매칭 진단. hit 판정은 loreEntryActive 와 동일. always_on 이면 matched=[] */
export function loreEntryMatch(opts: {
  always_on: boolean | number;
  keywords: string[];
  secondary_keys?: string[];
  selective?: boolean | number;
  scanText: string;
}): { hit: boolean; matched: string[] } {
  if (opts.always_on === true || opts.always_on === 1) return { hit: true, matched: [] };
  const keys = (opts.keywords ?? []).map((k) => k.toLowerCase()).filter(Boolean);
  const secondary = (opts.secondary_keys ?? []).map((k) => k.toLowerCase()).filter(Boolean);
  const matched = keys.filter((k) => opts.scanText.includes(k));
  if (matched.length === 0) return { hit: false, matched: [] };
  const selective = opts.selective === true || opts.selective === 1;
  if (selective && secondary.length > 0) {
    const sec = secondary.filter((k) => opts.scanText.includes(k));
    return { hit: sec.length > 0, matched: [...matched, ...sec] };
  }
  return { hit: true, matched };
}
