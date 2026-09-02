/**
 * f9-beat-render — `GET /media/assets/:characterId/:outfit/:file`.
 *
 * Registered next to the avatar route, i.e. before the SPA static handler, so a
 * missing asset returns `404 application/json` instead of falling through to
 * index.html. A web client that got HTML for a missing image would render a
 * broken picture instead of the intended "no image, just name + line".
 *
 * Local files only. No external outbound, no generation, no write path.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { ASSET_MIME, readAsset, resolveAssetPath } from '../media/assets.js';

export const ASSETS_DIR = 'assets';

export function mediaRoutes(mediaRoot: string) {
  const assetRoot = path.join(mediaRoot, ASSETS_DIR);
  fs.mkdirSync(assetRoot, { recursive: true });

  return async function plugin(app: FastifyInstance) {
    app.get<{ Params: { characterId: string; outfit: string; file: string } }>(
      '/media/assets/:characterId/:outfit/:file',
      async (req, reply) => {
        const m = /^(0|[1-9][0-9]{0,3})\.webp$/.exec(req.params.file);
        if (!m) return reply.code(404).send({ error: 'not found' });

        const full = resolveAssetPath(assetRoot, {
          characterId: req.params.characterId,
          outfit: req.params.outfit,
          n: m[1],
        });
        if (!full) return reply.code(404).send({ error: 'not found' });

        const buf = readAsset(full);
        if (!buf) return reply.code(404).send({ error: 'not found' });

        return reply.type(ASSET_MIME).send(buf);
      },
    );
  };
}
