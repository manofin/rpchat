/** Fixed Scene Status Panel catalog — types, strip/fallback, intent → existing routes. */

export const UI_STATES = ['default', 'loading', 'empty', 'error', 'disabled', 'refreshing'] as const;
export type UiState = (typeof UI_STATES)[number];

export const SCENE_PROGRESS = ['idle', 'active', 'paused', 'ended'] as const;
export type SceneProgress = (typeof SCENE_PROGRESS)[number];

export const SCENE_ACTION_INTENTS = ['open_scene_info', 'open_context', 'open_scene_state', 'retry'] as const;
export type SceneActionIntent = (typeof SCENE_ACTION_INTENTS)[number];

export const CATALOG_TYPES = ['SceneStatus', 'CastRow', 'LocationPill', 'SceneAction', 'EmptyHint', 'AlertInline'] as const;
export type CatalogType = (typeof CATALOG_TYPES)[number];

export const ALERT_TONES = ['error', 'warn', 'info'] as const;
export type AlertTone = (typeof ALERT_TONES)[number];

export type CastMember = {
  id: string;
  name: string;
  active?: boolean;
};

export type SceneActionItem = {
  id: string;
  label: string;
  intent: SceneActionIntent;
  enabled?: boolean;
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
  LocationPill: ['name', 'traversable', 'uiState'],
  SceneAction: ['actions', 'uiState'],
  EmptyHint: ['title', 'body', 'uiState'],
  AlertInline: ['tone', 'message', 'actionLabel', 'uiState'],
};

const ENUM_FALLBACK: Record<string, { values: readonly string[]; fallback: string }> = {
  uiState: { values: UI_STATES, fallback: 'default' },
  progress: { values: SCENE_PROGRESS, fallback: 'idle' },
  intent: { values: SCENE_ACTION_INTENTS, fallback: 'open_scene_state' },
  tone: { values: ALERT_TONES, fallback: 'info' },
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
    out.push({ id: rec.id, name: rec.name, active: rec.active === true });
  }
  return out;
}

function normalizeActions(raw: unknown): SceneActionItem[] {
  if (!Array.isArray(raw)) return [];
  const out: SceneActionItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== 'string' || typeof rec.label !== 'string') continue;
    const intent = inList(SCENE_ACTION_INTENTS, rec.intent)
      ? (rec.intent as SceneActionIntent)
      : 'open_scene_state';
    out.push({
      id: rec.id,
      label: rec.label,
      intent,
      enabled: rec.enabled === false ? false : true,
    });
  }
  return out;
}

function stripProps(type: CatalogType, raw: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(ALLOWED_PROPS[type]);
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!allowed.has(k)) continue;
    if (k === 'members') props[k] = normalizeMembers(v);
    else if (k === 'actions') props[k] = normalizeActions(v);
    else if (k === 'traversable') {
      if (v === true) props[k] = true;
      else if (v === false) props[k] = false;
      else props[k] = null;
    } else if (k === 'title' || k === 'summary' || k === 'name' || k === 'label' || k === 'message' || k === 'body' || k === 'actionLabel') {
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
