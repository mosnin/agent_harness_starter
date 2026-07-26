export type EmbeddingProvider = "openai" | "mock" | "custom";

export interface EmbeddingResult {
  vector: number[];
  model: string;
  tokenCount?: number;
  cached: boolean;
}

export interface EmbeddingService {
  embed(text: string): Promise<EmbeddingResult>;
  embedBatch(texts: string[]): Promise<EmbeddingResult[]>;
  readonly dimensions: number;
  readonly model: string;
}

export interface ChunkOptions {
  strategy: "char" | "sentence" | "token";
  chunkSize: number;      // chars for "char", sentences for "sentence", approx tokens for "token"
  overlap: number;        // overlap between chunks (same unit as chunkSize)
}

export interface Chunk {
  text: string;
  index: number;
  startChar: number;
  endChar: number;
}

export type NormalizationStrategy = "l2" | "l1" | "minmax" | "none";
