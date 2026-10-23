import { createServer, type Server } from 'node:http';
import type { GenerationQueue } from './queue.js';

/** A separate loopback listener: never register an auth bypass on the public API. */
export async function startBusySignal(queue: GenerationQueue, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // A local process can read counts, but browser-origin and proxied requests
    // must not turn this listener into a public API through header forwarding.
    if (req.headers.origin || req.headers.forwarded || req.headers['x-forwarded-for'] ||
        req.headers['tailscale-user-login']) {
      res.writeHead(403).end('{}');
    } else if (req.url !== '/busy') {
      res.writeHead(404).end('{}');
    } else if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.writeHead(405).end('{}');
    } else {
      res.end(JSON.stringify({ schema_version: 1, ...queue.load }));
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return server;
}
