import type {
  EmbeddingService,
  EmbeddingResult,
  EmbeddingProvider,
  ChunkOptions,
  Chunk,
  NormalizationStrategy,
} from "./types";
import { MockEmbeddingService } from "./providers/mock";
import { OpenAIEmbeddingService } from "./providers/openai";
import { EmbeddingCache } from "./cache";
import { chunkText } from "./chunker";
import { normalizeVector } from "./normalizer";

export interface EmbeddingServiceConfig {
  provider: EmbeddingProvider;
  openai?: { apiKey?: string; model?: string };
  mock?: { dimensions?: number; seed?: number };
  cache?: { enabled?: boolean; maxEntries?: number };
  normalize?: NormalizationStrategy;  // default: "none"
}

type EnhancedEmbeddingService = EmbeddingService & {
  embedWithCache(text: string): Promise<EmbeddingResult>;
  embedAndChunk(
    text: string,
    chunkOptions: ChunkOptions
  ): Promise<Array<{ chunk: Chunk; embedding: EmbeddingResult }>>;
};

export function createEmbeddingService(
  config: EmbeddingServiceConfig
): EnhancedEmbeddingService {
  // Build the underlying provider
  let provider: EmbeddingService;
  if (config.provider === "mock") {
    provider = new MockEmbeddingService(config.mock);
  } else if (config.provider === "openai") {
    provider = new OpenAIEmbeddingService(config.openai);
  } else {
    throw new Error(`Unknown provider: ${config.provider as string}`);
  }

  const cacheEnabled = config.cache?.enabled !== false; // default true
  const cache = cacheEnabled
    ? new EmbeddingCache(config.cache?.maxEntries)
    : null;
  const normalizeStrategy: NormalizationStrategy = config.normalize ?? "none";

  function cacheKey(text: string, model: string): string {
    return `${text}::${model}`;
  }

  function applyNormalization(result: EmbeddingResult): EmbeddingResult {
    if (normalizeStrategy === "none") return result;
    return {
      ...result,
      vector: normalizeVector(result.vector, normalizeStrategy),
    };
  }

  async function embedWithCache(text: string): Promise<EmbeddingResult> {
    if (cache) {
      const key = cacheKey(text, provider.model);
      const cached = cache.get(key);
      if (cached !== undefined) {
        return {
          vector: cached,
          model: provider.model,
          cached: true,
        };
      }
      const result = await provider.embed(text);
      const normalized = applyNormalization(result);
      cache.set(key, normalized.vector);
      return normalized;
    }
    const result = await provider.embed(text);
    return applyNormalization(result);
  }

  async function embed(text: string): Promise<EmbeddingResult> {
    return embedWithCache(text);
  }

  async function embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (cache) {
      const results: EmbeddingResult[] = new Array(texts.length);
      const uncachedIndices: number[] = [];
      const uncachedTexts: string[] = [];

      // Check cache for each text
      for (let i = 0; i < texts.length; i++) {
        const key = cacheKey(texts[i], provider.model);
        const cached = cache.get(key);
        if (cached !== undefined) {
          results[i] = { vector: cached, model: provider.model, cached: true };
        } else {
          uncachedIndices.push(i);
          uncachedTexts.push(texts[i]);
        }
      }

      // Fetch uncached in batch
      if (uncachedTexts.length > 0) {
        const batchResults = await provider.embedBatch(uncachedTexts);
        for (let j = 0; j < uncachedTexts.length; j++) {
          const normalized = applyNormalization(batchResults[j]);
          const idx = uncachedIndices[j];
          cache.set(cacheKey(texts[idx], provider.model), normalized.vector);
          results[idx] = normalized;
        }
      }

      return results;
    }

    const batchResults = await provider.embedBatch(texts);
    return batchResults.map(applyNormalization);
  }

  async function embedAndChunk(
    text: string,
    chunkOptions: ChunkOptions
  ): Promise<Array<{ chunk: Chunk; embedding: EmbeddingResult }>> {
    const chunks = chunkText(text, chunkOptions);
    const embeddings = await embedBatch(chunks.map((c) => c.text));
    return chunks.map((chunk, i) => ({ chunk, embedding: embeddings[i] }));
  }

  return {
    get dimensions() {
      return provider.dimensions;
    },
    get model() {
      return provider.model;
    },
    embed,
    embedBatch,
    embedWithCache,
    embedAndChunk,
  };
}
