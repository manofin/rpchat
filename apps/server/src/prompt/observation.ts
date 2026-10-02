import { readSceneSnapshot } from '../db/sceneBase.js';
import { z } from 'zod';
import { parseMessageMeta } from '../db/messageMeta.js';
import type { MessageRow } from '../types.js';
import { sanitizeGeneratedContent } from '../contracts/chatEventAdapter.js';

// This contract belongs to the server/API, never to free-form model output.
export const audienceSchema = z.discriminatedUnion('visibility', [
  z.object({ visibility: z.literal('public') }).strict(),
  z.object({ visibility: z.literal('private'), recipient_ids: z.array(z.string().min(1)).max(100), observer_ids: z.array(z.string().min(1)).max(100).default([]) }).strict(),
]);
export type Audience = z.infer<typeof audienceSchema>;
export const PUBLIC: Audience = { visibility: 'public' };
export const USER = 'user';
export const GM = 'gm';
const OBSERVATION = '[비공개 대화가 있었다.]';

export function authorizeAudience(value: Audience, participantIds: string[], sender = USER): Audience {
  if (value.visibility === 'public') return PUBLIC;
  const allowed = new Set([...participantIds, USER, GM]);
  for (const id of [...value.recipient_ids, ...value.observer_ids]) {
    if (!allowed.has(id)) throw new Error(`등록되지 않은 수신자: ${id}`);
  }
  return { ...value, recipient_ids: [...new Set([sender, ...value.recipient_ids])], observer_ids: [...new Set(value.observer_ids)] };
}
export function audienceOf(row?: MessageRow): Audience | undefined {
  const parsed = audienceSchema.safeParse(row ? parseMessageMeta(row.meta_json).observation : undefined);
  return parsed.success ? parsed.data : undefined;
}
export function project(text: string, audience: Audience | undefined, actor: string, enabled: boolean): string {
  if (!enabled) return sanitizeGeneratedContent(text).trim();
  if (!audience) return '';
  if (audience.visibility === 'public' || audience.recipient_ids.includes(actor)) return sanitizeGeneratedContent(text).trim();
  return audience.observer_ids.includes(actor) ? OBSERVATION : '';
}
export function inheritedAudience(audiences: Array<Audience | undefined>, actor: string): Audience {
  const privateInputs = audiences.filter((a): a is Extract<Audience, {visibility:'private'}> => a?.visibility === 'private' && a.recipient_ids.includes(actor));
  if (!privateInputs.length) return PUBLIC;
  // A model exposed to secrets cannot declare its answer public, even via visible_action.
  return { visibility: 'private', recipient_ids: [actor, USER], observer_ids: [] };
}

export function successfulObservationRows(rows: MessageRow[]): MessageRow[] {
  const successful = new Set(rows.filter(m => m.status === 'complete' && readSceneSnapshot(parseMessageMeta(m.meta_json)))
    .map(m => parseMessageMeta(m.meta_json).generation_id).filter((id): id is string => typeof id === 'string'));
  const users = new Set<string>();
  let userId: string | undefined;
  for (const row of rows) {
    if (row.role === 'user') userId = row.id;
    else if (userId && successful.has(parseMessageMeta(row.meta_json).generation_id ?? '')) users.add(userId);
  }
  return rows.filter(m => m.status === 'complete' && (m.role === 'user' ? users.has(m.id) : successful.has(parseMessageMeta(m.meta_json).generation_id ?? '')));
}
