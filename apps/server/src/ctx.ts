import type { FastifyBaseLogger } from 'fastify';
import type { DB } from './db/index.js';
import type { ModelClient } from './model/adapter.js';
import type { GenerationQueue } from './model/queue.js';

export interface ModelHealth {
  ok: boolean;
  checkedAt: string;
  latencyMs: number | null;
  models: string[];
  error?: string;
}

export interface Ctx {
  db: DB;
  model: ModelClient;
  queue: GenerationQueue;
  log: FastifyBaseLogger;
  /** MODEL_NAME 이 비어 있으면 /v1/models 첫 항목으로 해석된 값 */
  resolvedModel: () => string;
  setResolvedModel: (name: string) => void;
  health: () => Promise<ModelHealth>;
}
