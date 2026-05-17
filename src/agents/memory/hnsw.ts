/**
 * HNSW (Hierarchical Navigable Small World) index
 *
 * Pure-TypeScript, zero external dependencies.
 * Port of the ruflo HNSW algorithm for fast approximate nearest-neighbor search.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HNSWConfig {
  /** Dimensions of each vector. Required. */
  dimensions: number;
  /** Max connections per node per layer. Default: 16 */
  M?: number;
  /** Construction-time candidate list size. Default: 200 */
  efConstruction?: number;
  /** Search-time candidate list size. Default: 50 */
  ef?: number;
  /** Level multiplier. Default: 1/ln(M) */
  mL?: number;
  /** Distance metric. Default: "cosine" */
  metric?: "cosine" | "euclidean" | "dot";
}

export interface HNSWNode {
  id: string;
  vector: Float32Array;
  metadata?: Record<string, unknown>;
  /** This node's top level in the hierarchy. */
  level: number;
  /** level → list of neighbor node IDs */
  neighbors: Map<number, string[]>;
}

export interface HNSWSearchResult {
  id: string;
  /** Similarity score — higher is more similar for cosine/dot. */
  score: number;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Distance functions
// ---------------------------------------------------------------------------

function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 1;
  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function euclideanDistance(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function dotDistance(a: Float32Array, b: Float32Array): number {
  // Higher dot product = more similar, so distance = -dot
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return -dot;
}

// ---------------------------------------------------------------------------
// Serialization shape
// ---------------------------------------------------------------------------

interface SerializedNode {
  id: string;
  vector: number[];
  metadata?: Record<string, unknown>;
  level: number;
  neighbors: Array<[number, string[]]>;
}

interface SerializedIndex {
  config: Required<HNSWConfig>;
  entryPointId: string | null;
  maxLevel: number;
  nodes: SerializedNode[];
}

// ---------------------------------------------------------------------------
// HNSWIndex
// ---------------------------------------------------------------------------

export class HNSWIndex {
  private readonly dimensions: number;
  private readonly M: number;
  private readonly Mmax0: number;       // max connections at level 0 = 2*M
  private readonly efConstruction: number;
  private readonly ef: number;
  private readonly mL: number;
  private readonly metric: "cosine" | "euclidean" | "dot";
  private readonly distanceFn: (a: Float32Array, b: Float32Array) => number;

  private nodes: Map<string, HNSWNode> = new Map();
  private entryPointId: string | null = null;
  private maxLevel = 0;

  constructor(config: HNSWConfig) {
    this.dimensions = config.dimensions;
    this.M = config.M ?? 16;
    this.Mmax0 = this.M * 2;
    this.efConstruction = config.efConstruction ?? 200;
    this.ef = config.ef ?? 50;
    this.mL = config.mL ?? 1 / Math.log(this.M);
    this.metric = config.metric ?? "cosine";

    switch (this.metric) {
      case "euclidean":
        this.distanceFn = euclideanDistance;
        break;
      case "dot":
        this.distanceFn = dotDistance;
        break;
      default:
        this.distanceFn = cosineDistance;
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  get size(): number {
    return this.nodes.size;
  }

  get(id: string): HNSWNode | undefined {
    return this.nodes.get(id);
  }

  add(
    id: string,
    vector: Float32Array | number[],
    metadata?: Record<string, unknown>
  ): void {
    const vec =
      vector instanceof Float32Array ? vector : new Float32Array(vector);

    if (vec.length !== this.dimensions) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.dimensions}, got ${vec.length}`
      );
    }

    // If node already exists, remove old one first (upsert semantics)
    if (this.nodes.has(id)) {
      this.remove(id);
    }

    const nodeLevel = this.assignLevel();
    const node: HNSWNode = {
      id,
      vector: vec,
      metadata,
      level: nodeLevel,
      neighbors: new Map(),
    };
    for (let l = 0; l <= nodeLevel; l++) {
      node.neighbors.set(l, []);
    }

    this.nodes.set(id, node);

    // First node — becomes entry point
    if (this.entryPointId === null) {
      this.entryPointId = id;
      this.maxLevel = nodeLevel;
      return;
    }

    let currentEntryPoints: string[] = [this.entryPointId];

    // Greedy descent from maxLevel down to nodeLevel+1 — find 1 NN per level
    for (let level = this.maxLevel; level > nodeLevel; level--) {
      const result = this.beamSearch(currentEntryPoints, vec, level, 1);
      if (result.length > 0) {
        currentEntryPoints = [result[0].id];
      }
    }

    // From min(nodeLevel, maxLevel) down to 0 — insert with efConstruction
    for (let level = Math.min(nodeLevel, this.maxLevel); level >= 0; level--) {
      const candidates = this.beamSearch(
        currentEntryPoints,
        vec,
        level,
        this.efConstruction
      );

      // Select up to M neighbors
      const maxNeighbors = level === 0 ? this.Mmax0 : this.M;
      const selected = candidates.slice(0, maxNeighbors);

      // Set neighbors for new node at this level
      node.neighbors.set(
        level,
        selected.map((c) => c.id)
      );

      // Add bidirectional connections, pruning if necessary
      for (const { id: neighborId } of selected) {
        const neighbor = this.nodes.get(neighborId);
        if (!neighbor) continue;

        const neighborNeighbors = neighbor.neighbors.get(level) ?? [];
        neighborNeighbors.push(id);

        // Prune if over limit
        if (neighborNeighbors.length > maxNeighbors) {
          // Keep the closest maxNeighbors by distance
          const pruned = neighborNeighbors
            .map((nid) => ({
              id: nid,
              dist: this.distance(neighbor.vector, nid),
            }))
            .sort((a, b) => a.dist - b.dist)
            .slice(0, maxNeighbors)
            .map((x) => x.id);
          neighbor.neighbors.set(level, pruned);
        } else {
          neighbor.neighbors.set(level, neighborNeighbors);
        }
      }

      // Advance entry points for next level
      currentEntryPoints = selected.map((c) => c.id);
      if (currentEntryPoints.length === 0) {
        currentEntryPoints = [this.entryPointId];
      }
    }

    // Update entry point if new node has a higher level
    if (nodeLevel > this.maxLevel) {
      this.maxLevel = nodeLevel;
      this.entryPointId = id;
    }
  }

  search(query: Float32Array | number[], k = 10): HNSWSearchResult[] {
    if (this.nodes.size === 0 || this.entryPointId === null) return [];

    const vec =
      query instanceof Float32Array ? query : new Float32Array(query);

    let currentEntryPoints: string[] = [this.entryPointId];

    // Greedy descent from maxLevel down to level 1
    for (let level = this.maxLevel; level > 0; level--) {
      const result = this.beamSearch(currentEntryPoints, vec, level, 1);
      if (result.length > 0) {
        currentEntryPoints = [result[0].id];
      }
    }

    // Beam search at level 0 with ef candidates
    const candidates = this.beamSearch(
      currentEntryPoints,
      vec,
      0,
      Math.max(this.ef, k)
    );

    // Convert distances to scores and return top k
    return candidates.slice(0, k).map(({ id, dist }) => {
      const node = this.nodes.get(id)!;
      return {
        id,
        score: distanceToScore(dist, this.metric),
        metadata: node.metadata,
      };
    });
  }

  remove(id: string): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;

    // Remove from all neighbors' adjacency lists
    for (let level = 0; level <= node.level; level++) {
      const nodeNeighbors = node.neighbors.get(level) ?? [];
      for (const neighborId of nodeNeighbors) {
        const neighbor = this.nodes.get(neighborId);
        if (!neighbor) continue;
        const nns = neighbor.neighbors.get(level) ?? [];
        neighbor.neighbors.set(
          level,
          nns.filter((nid) => nid !== id)
        );
      }
    }

    this.nodes.delete(id);

    // If we removed the entry point, pick a new one
    if (this.entryPointId === id) {
      if (this.nodes.size === 0) {
        this.entryPointId = null;
        this.maxLevel = 0;
      } else {
        // Find node with highest level
        let bestId = "";
        let bestLevel = -1;
        for (const [nid, n] of this.nodes) {
          if (n.level > bestLevel) {
            bestLevel = n.level;
            bestId = nid;
          }
        }
        this.entryPointId = bestId;
        this.maxLevel = bestLevel;
      }
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------------

  serialize(): SerializedIndex {
    const nodes: SerializedNode[] = [];
    for (const node of this.nodes.values()) {
      nodes.push({
        id: node.id,
        vector: Array.from(node.vector),
        metadata: node.metadata,
        level: node.level,
        neighbors: Array.from(node.neighbors.entries()),
      });
    }
    return {
      config: {
        dimensions: this.dimensions,
        M: this.M,
        efConstruction: this.efConstruction,
        ef: this.ef,
        mL: this.mL,
        metric: this.metric,
      },
      entryPointId: this.entryPointId,
      maxLevel: this.maxLevel,
      nodes,
    };
  }

  static deserialize(data: object): HNSWIndex {
    const d = data as SerializedIndex;
    const index = new HNSWIndex(d.config);
    index.entryPointId = d.entryPointId;
    index.maxLevel = d.maxLevel;

    for (const sn of d.nodes) {
      const node: HNSWNode = {
        id: sn.id,
        vector: new Float32Array(sn.vector),
        metadata: sn.metadata,
        level: sn.level,
        neighbors: new Map(sn.neighbors),
      };
      index.nodes.set(sn.id, node);
    }

    return index;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private assignLevel(): number {
    return Math.floor(-Math.log(Math.random()) * this.mL);
  }

  /** Compute distance from a node (by ID) to a query vector. */
  private distance(query: Float32Array, nodeId: string): number {
    const node = this.nodes.get(nodeId);
    if (!node) return Infinity;
    return this.distanceFn(query, node.vector);
  }

  /**
   * Beam search: explore the graph at `level` starting from `entryPoints`,
   * returning up to `ef` nearest candidates sorted by distance (ascending).
   */
  private beamSearch(
    entryPoints: string[],
    query: Float32Array,
    level: number,
    ef: number
  ): Array<{ id: string; dist: number }> {
    const visited = new Set<string>();

    // candidates: min-heap modelled as sorted array (ascending by dist)
    // results: same sorted array — top ef closest found
    const candidates: Array<{ id: string; dist: number }> = [];
    const results: Array<{ id: string; dist: number }> = [];

    for (const epId of entryPoints) {
      if (visited.has(epId)) continue;
      visited.add(epId);
      const d = this.distance(query, epId);
      if (!isFinite(d)) continue;
      const entry = { id: epId, dist: d };
      sortedInsert(candidates, entry);
      sortedInsert(results, entry);
    }

    while (candidates.length > 0) {
      // Pop closest candidate
      const current = candidates.shift()!;

      // If closest candidate is further than worst result and results are full — stop
      if (results.length >= ef && current.dist > results[results.length - 1].dist) {
        break;
      }

      // Explore neighbors at this level
      const node = this.nodes.get(current.id);
      if (!node) continue;
      const neighbors = node.neighbors.get(level) ?? [];

      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const d = this.distance(query, neighborId);
        if (!isFinite(d)) continue;

        const worstResult = results[results.length - 1];
        if (results.length < ef || d < worstResult.dist) {
          const entry = { id: neighborId, dist: d };
          sortedInsert(candidates, entry);
          sortedInsert(results, entry);
          // Trim results to ef
          if (results.length > ef) {
            results.pop();
          }
        }
      }
    }

    return results;
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Insert into ascending-sorted array in O(n). */
function sortedInsert(
  arr: Array<{ id: string; dist: number }>,
  item: { id: string; dist: number }
): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].dist < item.dist) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, item);
}

/** Convert a raw distance to a similarity score. */
function distanceToScore(
  dist: number,
  metric: "cosine" | "euclidean" | "dot"
): number {
  switch (metric) {
    case "cosine":
      // dist = 1 - cosine_sim; score = cosine_sim = 1 - dist
      return 1 - dist;
    case "dot":
      // dist = -dot; score = dot = -dist
      return -dist;
    case "euclidean":
      // score = 1 / (1 + dist) so closer → higher score
      return 1 / (1 + dist);
  }
}
