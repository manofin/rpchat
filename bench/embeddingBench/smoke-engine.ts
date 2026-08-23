/** Task 2 게이트: H1/H2 로드 + dim 검증. 실행: npx tsx bench/embeddingBench/smoke-engine.ts */
import { getEngine } from './engine.ts';

const which = (process.argv[2] ?? 'all') as 'H1' | 'H2' | 'all';

async function smoke(name: 'H1' | 'H2') {
  const eng = getEngine(name);
  const v = await eng.embed(['테스트']);
  console.log(`${name}_DIM`, v[0].length);
  const [a] = await eng.embed(['서리는 만년필을 소중히 여긴다'], name === 'H2' ? 'passage' : undefined);
  const [b] = await eng.embed(['서리가 전임 사서에게 물려받은 펜을 아낀다'], name === 'H2' ? 'query' : undefined);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  console.log(`${name}_COSINE_SANITY`, s.toFixed(4));
}

async function main() {
  if (which === 'H1' || which === 'all') await smoke('H1');
  if (which === 'H2' || which === 'all') await smoke('H2');
  console.log('SMOKE_OK');
}
main().catch((e) => { console.error(e); process.exit(1); });
