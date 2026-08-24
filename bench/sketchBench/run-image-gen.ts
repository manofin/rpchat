/**
 * Single-shot image smoke. After Task 1 this hits the real Draw Things contract.
 * Until then: DRAW_THINGS_BASE_URL must point at a stub or the real base — no invented port.
 *
 *   DRAW_THINGS_BASE_URL=http://127.0.0.1:9999 npx tsx run-image-gen.ts
 */
import { generateImage, requireDrawThingsBase } from './lib/drawThingsClient.ts';

async function main() {
  const base = requireDrawThingsBase();
  const r = await generateImage({ prompt: 'sketchBench run-image-gen smoke', timeoutMs: 30_000 });
  console.log(JSON.stringify({ base, ...r }, null, 2));
  if (!r.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
