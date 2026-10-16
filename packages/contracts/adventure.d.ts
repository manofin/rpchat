/** Public, human-confirmed state. No exchange rate or automatic progression. */
export type QuestStage = 'offered' | 'considering' | 'accepted' | 'in_progress' | 'completed' | 'settled' | 'declined';
export interface AdventureState {
  version: 1;
  revision: number;
  currency: string;
  balance: number;
  registration: { organization: string } | null;
  rank: string;
  experience: number;
  skills: string[];
  quests: Array<{ id: string; title: string; terms: string; reward: number | null; stage: QuestStage }>;
  items: Array<{ id: string; name: string; quantity: number; ownership: 'owned' | 'loan'; owner: string; terms: string; source: string }>;
}
export type AdventureAction =
  | { kind: 'initialize'; currency: string; balance: number; rank: string; experience: number; skills: string[] }
  | { kind: 'register'; organization: string; fee: number }
  | { kind: 'payment'; direction: 'pay' | 'receive'; amount: number; counterpart: string; reason: string }
  | { kind: 'quest_offer'; title: string; terms: string; reward: number | null }
  | { kind: 'quest_stage'; quest_id: string; stage: Exclude<QuestStage, 'offered' | 'settled'> }
  | { kind: 'quest_settle'; quest_id: string; received: number }
  | { kind: 'item_receive'; name: string; quantity: number; ownership: 'owned' | 'loan'; owner: string; terms: string; source: string }
  | { kind: 'item_reduce'; item_id: string; quantity: number; reason: 'return' | 'use' }
  | { kind: 'progress'; rank: string; experience: number; skills: string[] };
export interface AdventureRequest {
  expected_head_id: string;
  expected_scene_version: number;
  idempotency_key: string;
  action: AdventureAction;
}
