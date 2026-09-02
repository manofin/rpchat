import fs from 'node:fs';
import path from 'node:path';

/** Wire-request dump. Off unless RPCHAT_REQUEST_DUMP=1. Not an HTTP route. Does not write last.json. */
export function dumpRequestBody(opts: {
  dataDir: string;
  generationId?: string;
  createdAt: string;
  url: string;
  body: Record<string, unknown>;
}): void {
  if (process.env.RPCHAT_REQUEST_DUMP !== '1') return;
  const dir = path.join(opts.dataDir, 'prompt-dump');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'last-request.json');
  const payload: Record<string, unknown> = {
    createdAt: opts.createdAt,
    url: opts.url,
    body: opts.body,
  };
  if (opts.generationId !== undefined) payload.generationId = opts.generationId;
  fs.writeFileSync(file, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
