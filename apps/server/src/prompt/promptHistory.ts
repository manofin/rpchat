import { nowIso } from '../db/index.js';
import type { MessageRow } from '../types.js';

type PromptMessageIdentity = { id: string; prompt_preview_draft?: true };

/** Preview input occupies a turn slot and supplies text, but has no stored identity. */
export function isVirtualPromptMessage(message: PromptMessageIdentity): boolean {
  return message.prompt_preview_draft === true;
}

export function promptPathIds(history: readonly PromptMessageIdentity[]): Set<string> {
  return new Set(history.filter(m => !isVirtualPromptMessage(m)).map(m => m.id));
}

export function promptIndexById(history: readonly PromptMessageIdentity[]): Map<string, number> {
  const indices = new Map<string, number>();
  history.forEach((m, i) => { if (!isVirtualPromptMessage(m)) indices.set(m.id, i); });
  return indices;
}

export function promptRecentIds(history: readonly PromptMessageIdentity[], count: number): Set<string> {
  // Slice before excluding virtual identities: an actual send also occupies this slot.
  return promptPathIds(history.slice(-count));
}

export function previewDraftMessage(conversationId: string, parentId: string | null, content: string): MessageRow & { prompt_preview_draft: true } {
  return {
    id: 'draft', conversation_id: conversationId, parent_id: parentId, role: 'user', content,
    status: 'complete', meta_json: '{}', bookmarked: 0, created_at: nowIso(), prompt_preview_draft: true,
  };
}
