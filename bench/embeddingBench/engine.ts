/**
 * P3 임베딩 벤치 엔진 어댑터. 계약(사전등록 §8):
 *   embed(texts) → L2-normalized vectors. 코사인은 harness가 계산.
 * H1: Xenova/paraphrase-multilingual-MiniLM-L12-v2 (접두어 없음)
 * H2: Xenova/multilingual-e5-small (e5 규약: entry 본문='passage: ', 판정 문장='query: ')
 * 모델 캐시: ~/.cache/rpchat-embed (repo 밖).
 */
import { pipeline, env } from '@xenova/transformers';
import type { FeatureExtractionPipeline } from '@xenova/transformers';
import os from 'node:os';
import path from 'node:path';

env.cacheDir = path.join(os.homedir(), '.cache', 'rpchat-embed');
// 벤치는 원격 코드 실행 금지. 모델 파일은 최초 1회 HF Hub에서 캐시로 다운로드(allowRemoteModels=true일 때)
// 이후 로컬 캐시에서만 로드한다. (allowRemoteModels=false는 사전 다운로드 완료 후에만 켤 수 있어 기본 true 유지)
(env as any).allowRemoteCode = false;

export interface EmbedEngine {
  name: string;
  dim: number;
  /** 사전등록 §3의 접두어 규약을 적용해 임베딩한다. kind는 H2(e5)에서만 사용. */
  embed(texts: string[], kind?: 'query' | 'passage'): Promise<number[][]>;
}

function normalize(v: Float32Array | number[]): number[] {
  const arr = Array.from(v as ArrayLike<number>);
  const norm = Math.sqrt(arr.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? arr : arr.map((x) => x / norm);
}

abstract class BaseEngine implements EmbedEngine {
  abstract name: string;
  abstract dim: number;
  protected extractor: FeatureExtractionPipeline | null = null;
  protected readonly modelId: string;

  constructor(modelId: string) {
    this.modelId = modelId;
  }

  protected async get(): Promise<FeatureExtractionPipeline> {
    if (!this.extractor) {
      this.extractor = await pipeline('feature-extraction', this.modelId, { quantized: true });
    }
    return this.extractor;
  }

  async raw(texts: string[]): Promise<number[][]> {
    const ex = await this.get();
    const out: number[][] = [];
    for (const t of texts) {
      const res = await ex(t, { pooling: 'mean', normalize: false });
      out.push(normalize(res.data as Float32Array));
    }
    return out;
  }

  abstract embed(texts: string[], kind?: 'query' | 'passage'): Promise<number[][]>;
}

class H1Engine extends BaseEngine {
  name = 'H1';
  dim = 384;
  constructor() {
    super('Xenova/paraphrase-multilingual-MiniLM-L12-v2');
  }
  async embed(texts: string[]): Promise<number[][]> {
    return this.raw(texts); // 접두어 없음
  }
}

class H2Engine extends BaseEngine {
  name = 'H2';
  dim = 384;
  constructor() {
    super('Xenova/multilingual-e5-small');
  }
  async embed(texts: string[], kind: 'query' | 'passage' = 'query'): Promise<number[][]> {
    // e5 규약 (사전등록 §3 고정): query:/passage: 접두어
    return this.raw(texts.map((t) => `${kind}: ${t}`));
  }
}

export function getEngine(name: 'H1' | 'H2'): EmbedEngine {
  if (name === 'H1') return new H1Engine();
  if (name === 'H2') return new H2Engine();
  throw new Error(`unknown engine ${name}`);
}

export function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s; // both L2-normalized
}
