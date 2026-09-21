/** Fixed Scene Status Panel catalog — types, strip/fallback, intent → existing routes. */

export const UI_STATES = ['default', 'loading', 'empty', 'error', 'disabled', 'refreshing'] as const;
export type UiState = (typeof UI_STATES)[number];

export const SCENE_PROGRESS = ['idle', 'active', 'paused', 'ended'] as const;
export type SceneProgress = (typeof SCENE_PROGRESS)[number];

export const SCENE_ACTION_INTENTS = ['open_scene_info', 'open_context', 'open_scene_state', 'retry'] as const;
export type SceneActionIntent = (typeof SCENE_ACTION_INTENTS)[number];

export const CATALOG_TYPES = ['SceneStatus', 'CastRow', 'LocationPill', 'SceneAction', 'EmptyHint', 'AlertInline'] as const;
export type CatalogType = (typeof CATALOG_TYPES)[number];

export const ALERT_SEVERITIES = ['info', 'warning', 'error'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const CAST_PRESENCE = ['present', 'away', 'speaking'] as const;
export type CastPresence = (typeof CAST_PRESENCE)[number];

export type CastMember = {
  id: string;
  name: string;
  presence?: CastPresence;
};

export type SpecElement = {
  type: CatalogType;
  props: Record<string, unknown>;
  children: string[];
};

export type SceneStatusSpec = {
  root: string;
  elements: Record<string, SpecElement>;
};

export const ALLOWED_PROPS: Record<CatalogType, readonly string[]> = {
  SceneStatus: ['title', 'progress', 'summary', 'uiState'],
  CastRow: ['members', 'uiState'],
  LocationPill: ['place', 'traversable', 'uiState'],
  SceneAction: ['label', 'intent', 'uiState'],
  EmptyHint: ['message', 'uiState'],
  AlertInline: ['message', 'severity', 'uiState'],
};

const ENUM_FALLBACK: Record<string, { values: readonly string[]; fallback: string }> = {
  uiState: { values: UI_STATES, fallback: 'default' },
  progress: { values: SCENE_PROGRESS, fallback: 'idle' },
  intent: { values: SCENE_ACTION_INTENTS, fallback: 'open_scene_state' },
  severity: { values: ALERT_SEVERITIES, fallback: 'info' },
  presence: { values: CAST_PRESENCE, fallback: 'present' },
};

export type SceneActionDispatch =
  | { kind: 'navigate'; href: string }
  | { kind: 'open_context' }
  | { kind: 'retry' };

/** SceneAction intents resolve to existing chat routes / drawers only. */
export function resolveSceneAction(intent: SceneActionIntent, conversationId: string): SceneActionDispatch {
  switch (intent) {
    case 'open_scene_info':
      return { kind: 'navigate', href: `/chat/${conversationId}/settings` };
    case 'open_scene_state':
      return { kind: 'navigate', href: `/chat/${conversationId}/settings/state` };
    case 'open_context':
      return { kind: 'open_context' };
    case 'retry':
      return { kind: 'retry' };
  }
}

function inList(list: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && list.includes(value);
}

function normalizeEnum(key: string, value: unknown): unknown {
  const rule = ENUM_FALLBACK[key];
  if (!rule) return value;
  return inList(rule.values, value) ? value : rule.fallback;
}

function normalizeMembers(raw: unknown): CastMember[] {
  if (!Array.isArray(raw)) return [];
  const out: CastMember[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== 'string' || typeof rec.name !== 'string') continue;
    const presence = inList(CAST_PRESENCE, rec.presence) ? (rec.presence as CastPresence) : 'present';
    out.push({ id: rec.id, name: rec.name, presence });
  }
  return out;
}

function stripProps(type: CatalogType, raw: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(ALLOWED_PROPS[type]);
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!allowed.has(k)) continue;
    if (k === 'members') props[k] = normalizeMembers(v);
    else if (k === 'traversable') props[k] = v === true;
    else if (k === 'title' || k === 'summary' || k === 'place' || k === 'label' || k === 'message') {
      props[k] = typeof v === 'string' ? v : '';
    } else props[k] = normalizeEnum(k, v);
  }
  return props;
}

export function parseSceneStatusSpec(
  raw: unknown,
  warn: (msg: string) => void = () => undefined,
): SceneStatusSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const doc = raw as { root?: unknown; elements?: unknown };
  if (typeof doc.root !== 'string' || !doc.elements || typeof doc.elements !== 'object' || Array.isArray(doc.elements)) {
    return null;
  }
  const elements: Record<string, SpecElement> = {};
  for (const [id, node] of Object.entries(doc.elements as Record<string, unknown>)) {
    if (!node || typeof node !== 'object') continue;
    const n = node as { type?: unknown; props?: unknown; children?: unknown };
    if (typeof n.type !== 'string' || !inList(CATALOG_TYPES, n.type)) {
      warn(`scene-status: skip unknown type ${String(n.type)}`);
      continue;
    }
    const type = n.type as CatalogType;
    const rawProps = n.props && typeof n.props === 'object' && !Array.isArray(n.props)
      ? (n.props as Record<string, unknown>)
      : {};
    const children = Array.isArray(n.children)
      ? n.children.filter((c): c is string => typeof c === 'string')
      : [];
    elements[id] = { type, props: stripProps(type, rawProps), children };
  }
  for (const el of Object.values(elements)) {
    el.children = el.children.filter((cid) => cid in elements);
  }
  if (!(doc.root in elements)) return null;
  return { root: doc.root, elements };
}
