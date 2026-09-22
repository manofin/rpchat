import { parseJson } from './index.js';
import type { MessageMeta } from '../types.js';

export function objectMessageMeta(value: unknown): MessageMeta {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as MessageMeta : {};
}

export function parseMessageMeta(raw: string): MessageMeta {
  return objectMessageMeta(parseJson<unknown>(raw, {}));
}
