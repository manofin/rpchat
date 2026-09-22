export type ChatEvent =
  | { type: 'dialogue'; id: string; actorId: string | null; actorName: string | null; text: string }
  | { type: 'narration'; id: string; text: string }
  | { type: 'system'; id: string; text: string; presentation?: 'header' | 'info' | 'ui' | 'panel'; payload?: unknown }
  | { type: 'state_patch'; id: string; patch: Record<string, unknown> }
  | { type: 'error'; id: string; code: string; message: string };

export interface ChatEventSnapshot {
  eventVersion: 1;
  events: ChatEvent[];
}
