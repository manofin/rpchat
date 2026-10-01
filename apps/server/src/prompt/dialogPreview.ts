import { type DB, nowIso, one } from '../db/index.js';
import { getPath, resolveTurnStart } from '../db/tree.js';
import { resolveSceneBase } from '../db/sceneBase.js';
import type { ConversationRow, MessageRow, Scene } from '../types.js';
import { dialogPlanInput } from './dialogContext.js';
import { buildDialogPrompt } from './dialogPrompt.js';
import { planDialogBeat } from './composeDialog.js';
import { renderSceneDeltaPrompt } from './sceneDeltaPrompt.js';
import type { InjectContext } from './injectContext.js';

export function previewDialog(db: DB, conv: ConversationRow, contextTokens: number, model: string,
  opts: { draft?: string; regenerate?: string; branch?: string; inject?: InjectContext }) {
  let parentId = conv.head_message_id;
  let regenTurnStartId: string | null = null;
  if (opts.regenerate || opts.branch) {
    const target = one<MessageRow>(db, 'SELECT * FROM messages WHERE id = ? AND conversation_id = ?', opts.regenerate || opts.branch, conv.id);
    if (!target) throw new Error('message not found');
    if (opts.branch) {
      if (target.role !== 'user') throw new Error('user message required');
      parentId = target.parent_id;
    } else if (target.role === 'assistant') {
      const turn = resolveTurnStart(db, target);
      if (turn.kind === 'unresolved') throw new Error('turn boundary unresolved');
      parentId = turn.parentId;
      regenTurnStartId = turn.kind === 'multi' ? turn.startId : null;
    } else parentId = target.id;
  }
  const history = getPath(db, { ...conv, head_message_id: parentId });
  const scene = resolveSceneBase(db, {
    conversationScene: JSON.parse(conv.scene_json || '{}') as Scene, parentId, regenTurnStartId,
  }).scene;
  if (opts.draft !== undefined) {
    const draft: MessageRow & { prompt_preview_draft: true } = {
      id: 'draft', conversation_id: conv.id, parent_id: parentId, role: 'user', content: opts.draft.trim(),
      status: 'complete', meta_json: '{}', bookmarked: 0, created_at: nowIso(), prompt_preview_draft: true,
    };
    history.push(draft);
  }
  const last = history.at(-1);
  const userText = last?.role === 'user' ? last.content : '';
  const seed = last?.role === 'user' ? last.parent_id : parentId;
  const input = dialogPlanInput(db, conv, scene, userText, seed);
  if (!input) return null;
  const plan = planDialogBeat(input);
  const built = buildDialogPrompt(db, conv, history, plan.pass_s, userText, contextTokens, model, opts.inject, plan.applied.state);
  return {
    ...built, path: 'dialog',
    // Preview is read-only: the model's scene proposal has not run. Script assembly uses the unchanged branch scene.
    scene_delta: { pending: true, messages: [{ role: 'user', content: renderSceneDeltaPrompt({ scene, catalog: { ...input.catalog, cast: input.cast }, userText }) }] },
  };
}
