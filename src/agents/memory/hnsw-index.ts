/**
 * Re-export barrel for memory module consumers that need HNSW / VectorStore.
 */

export { HNSWIndex } from "./hnsw";
export { VectorStore } from "./vector-store";
export type { HNSWConfig, HNSWNode, HNSWSearchResult } from "./hnsw";
export type { VectorEntry, VectorStoreConfig } from "./vector-store";
