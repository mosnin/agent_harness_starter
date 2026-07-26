import type { EmbeddingService, EmbeddingResult } from "../types";

export interface MockEmbeddingOptions {
  dimensions?: number;  // default: 384
  seed?: number;        // for deterministic "embeddings"
}

function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash >>> 0;
  }
  return hash;
}

function lcgStep(seed: number): { value: number; nextSeed: number } {
  const nextSeed = (1664525 * seed + 1013904223) >>> 0;
  const value = (nextSeed / 0xffffffff) * 2 - 1;
  return { value, nextSeed };
}

export class MockEmbeddingService implements EmbeddingService {
  readonly dimensions: number;
  readonly model: string = "mock-embedding-v1";
  private readonly seed: number;

  constructor(options?: MockEmbeddingOptions) {
    this.dimensions = options?.dimensions ?? 384;
    this.seed = options?.seed ?? 0;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const textHash = djb2(text);
    let seed = (textHash + this.seed) >>> 0;

    const vector: number[] = [];
    for (let i = 0; i < this.dimensions; i++) {
      const { value, nextSeed } = lcgStep(seed);
      vector.push(value);
      seed = nextSeed;
    }

    return {
      vector,
      model: this.model,
      tokenCount: Math.ceil(text.length / 4),
      cached: false,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  }
}
