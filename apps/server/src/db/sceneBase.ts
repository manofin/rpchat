/**
 * scene-branch-snapshot — which scene a generation starts from.
 *
 * `conversations.scene_json` is one row per conversation, but messages are a tree.
 * That mismatch is what made a regenerate accumulate: the abandoned turn's delta
 * was already written to the conversation, so regenerating read it back and applied
 * a second delta on top. Measured before this module existed, three regenerations
 * of one logical turn moved the clock 598 → 628 and `scene_version` 2 → 5.
 *
 * The fix is to stop asking the conversation what the world looks like and start
 * asking the branch. Each turn's first block records the scene it began from and
 * the scene its delta produced, so:
 *
 *   normal turn   → nearest ancestor turn start, `after_delta`
 *   regenerate    → the target turn's own start, `before_delta`
 *   anything else → `conversations.scene_json`, unchanged behaviour
 *
 * `after_delta` is the scene the turn *committed* — validated delta plus the
 * server-owned keys `finishBeat` / `finishDialogBeat` / `finishHunterBeat` write
 * (`last_beat`, `turn_no`). Those keys are not known when the first block is
 * inserted, so the route stamps the start row after a successful finish (one
 * extra UPDATE). An interrupted turn has no snapshot and falls back, which is
 * how we avoid treating a half-written generation as a completed world.
 *
 * `conversations.scene_json` keeps its job as the materialised state of the active
 * head; this only changes what the *next* generation reads before writing it.
 *
 * The walk stops at the first turn start it meets rather than the first snapshot.
 * Skipping past a legacy turn that has no snapshot would silently reach back to an
 * older turn's state, which is a worse answer than the conversation row.
 */
import { type DB, one, parseJson } from './index.js';
import type { MessageMeta, MessageRow, Scene } from '../types.js';

/** Bump only for a change that an older reader would misread, not for added keys. */
export const SCENE_SNAPSHOT_VERSION = 1;

export type SceneSnapshot = {
  schema_version: number;
  /** The scene this generation was planned against, before its delta. */
  before_delta: Scene;
  /** The scene the validated delta produced. Equal to `before_delta` on a no-op. */
  after_delta: Scene;
};

export type SceneBaseSource =
  /** Regenerating: the target turn's own starting point, so siblings agree. */
  | 'regen_before'
  /** Normal turn: the previous turn on this branch finished here. */
  | 'prev_after'
  /** No usable snapshot — legacy row, malformed meta, or the first turn. */
  | 'conversation';

export type SceneBase = {
  scene: Scene;
  source: SceneBaseSource;
  /** SELECT count along the walk. First turn is 0; a regenerate is 1. */
  hops: number;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep copy through JSON: Scene is plain data, and a shared reference here would
 *  let a later `applySceneDelta` mutate a snapshot that is supposed to be a record
 *  of the past. */
function freezeCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function buildSceneSnapshot(before: Scene, after: Scene): SceneSnapshot {
  return {
    schema_version: SCENE_SNAPSHOT_VERSION,
    before_delta: freezeCopy(before),
    after_delta: freezeCopy(after),
  };
}

/**
 * Reads a snapshot back, or null for anything this version cannot vouch for.
 *
 * Null is not an error path — it is the legacy path. Every conversation that
 * predates this module has it, so the caller falls back rather than failing.
 */
export function readSceneSnapshot(meta: MessageMeta): SceneSnapshot | null {
  const raw = (meta as { scene_state?: unknown }).scene_state;
  if (!isPlainObject(raw)) return null;
  if (raw.schema_version !== SCENE_SNAPSHOT_VERSION) return null;
  if (!isPlainObject(raw.before_delta) || !isPlainObject(raw.after_delta)) return null;
  return {
    schema_version: SCENE_SNAPSHOT_VERSION,
    before_delta: freezeCopy(raw.before_delta) as Scene,
    after_delta: freezeCopy(raw.after_delta) as Scene,
  };
}

/** Ancestor walk bound. A turn is 5–6 rows; this only has to clear one turn. */
const BASE_WALK_LIMIT = 64;

/**
 * The scene a generation about to start should plan against.
 *
 * `regenTurnStartId` is the turn start `resolveTurnStart` already found for a
 * regenerate. It is passed in rather than re-derived because the route has it and
 * because the distinction it encodes — replacing a turn versus continuing from one
 * — is not recoverable from `parentId` alone: both cases hand this function the
 * same user message.
 */
export function resolveSceneBase(db: DB, args: {
  conversationScene: Scene;
  parentId: string | null;
  regenTurnStartId?: string | null;
}): SceneBase {
  const fallback = (hops: number): SceneBase => ({
    scene: args.conversationScene, source: 'conversation', hops,
  });

  if (args.regenTurnStartId) {
    const start = one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', args.regenTurnStartId);
    if (!start) return fallback(1);
    const snap = readSceneSnapshot(parseJson<MessageMeta>(start.meta_json, {}));
    // A turn written before this module has no snapshot; regenerating it can only
    // fall back, and will then behave exactly as it did before.
    return snap
      ? { scene: snap.before_delta, source: 'regen_before', hops: 1 }
      : fallback(1);
  }

  const seen = new Set<string>();
  let cur = args.parentId;
  let hops = 0;
  for (; hops < BASE_WALK_LIMIT && cur; hops++) {
    if (seen.has(cur)) return fallback(hops);
    seen.add(cur);
    const row = one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ?', cur);
    if (!row) return fallback(hops + 1);
    if (row.role === 'assistant') {
      const meta = parseJson<MessageMeta>(row.meta_json, {});
      if (meta.beat_seq === 0) {
        const snap = readSceneSnapshot(meta);
        return snap
          ? { scene: snap.after_delta, source: 'prev_after', hops: hops + 1 }
          : fallback(hops + 1);
      }
    }
    cur = row.parent_id;
  }
  return fallback(hops);
}
