function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash >>> 0;
  }
  return hash;
}

export class EmbeddingCache {
  private readonly maxEntries: number;
  private readonly store: Map<string, number[]>;

  constructor(maxEntries: number = 1000) {
    this.maxEntries = maxEntries;
    this.store = new Map();
  }

  private makeKey(key: string): string {
    return String(djb2(key));
  }

  get(key: string): number[] | undefined {
    const k = this.makeKey(key);
    const value = this.store.get(k);
    if (value === undefined) return undefined;
    // Move to end (most recently used)
    this.store.delete(k);
    this.store.set(k, value);
    return value;
  }

  set(key: string, vector: number[]): void {
    const k = this.makeKey(key);
    if (this.store.has(k)) {
      // Remove so we can re-insert at end
      this.store.delete(k);
    } else if (this.store.size >= this.maxEntries) {
      // Evict least recently used (first key in map)
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) {
        this.store.delete(firstKey);
      }
    }
    this.store.set(k, vector);
  }

  has(key: string): boolean {
    return this.store.has(this.makeKey(key));
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}
