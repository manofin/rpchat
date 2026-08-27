import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from '../types.js';

/** Generation-input dump. Off unless RPCHAT_PROMPT_DUMP=1. Not an HTTP route. */
export function dumpGenerationPrompt(opts: {
  dataDir: string;
  generationId: string;
  conversationId: string;
  messageId: string;
  createdAt: string;
  messages: ChatMessage[];
}): void {
  if (process.env.RPCHAT_PROMPT_DUMP !== '1') return;
  const dir = path.join(opts.dataDir, 'prompt-dump');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'last.json');
  const payload = {
    generationId: opts.generationId,
    conversationId: opts.conversationId,
    messageId: opts.messageId,
    createdAt: opts.createdAt,
    messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  fs.writeFileSync(file, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
