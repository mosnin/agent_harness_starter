import type { HierarchyNode, HierarchyNodeInfo } from "./tree";

/**
 * The operations that define a *streaming* hierarchical fold. Unlike the base
 * `HierarchyExec` (which hands a coordinator the full `R[]` of its children at
 * once), this splits aggregation into an `seed` identity plus a binary
 * `combine` so results can be folded one at a time as they arrive.
 */
export interface StreamingAggExec<T, R> {
  /** Split a coordinator's task into one sub-task per child (order = children). */
  decompose: (task: T, node: HierarchyNodeInfo) => T[];
  /** Run a leaf task on a worker — the leaf produces an `R` directly. */
  execute: (task: T, node: HierarchyNodeInfo) => Promise<R>;
  /** Seed accumulator for a coordinator (identity element). */
  seed: (node: HierarchyNodeInfo) => R;
  /**
   * Fold ONE child's result into the running accumulator. MUST be commutative
   * + associative, because children resolve in arbitrary order.
   */
  combine: (acc: R, childResult: R, node: HierarchyNodeInfo) => R;
}

export interface StreamingOptions<R> {
  /** Called each time a child folds into a coordinator's accumulator (partial progress). */
  onPartial?: (partial: R, node: HierarchyNodeInfo) => void;
}

export interface StreamingStats {
  activeNodes: number;
  workerRuns: number;
  /** Total combine() calls. */
  folds: number;
  /** Max un-folded child results held at once across the whole run. */
  peakBuffered: number;
}

/**
 * Executes a task over a swarm hierarchy by **streaming aggregation**: rather
 * than a coordinator `await Promise.all(children)`-ing an array and then
 * reducing it, each child's result is folded into a single running accumulator
 * `acc = combine(acc, childResult)` the *moment* that child resolves.
 *
 * Why it wins over buffer-then-aggregate:
 *   - **Memory:** the classic path materializes an `R[]` of size B (the
 *     branching factor) at every coordinator before reducing — O(B) live
 *     results per level. Here a coordinator holds only its scalar accumulator
 *     plus the *one* child result currently being folded, so live results per
 *     level are O(1). Because folds are synchronous, a resolved-but-unfolded
 *     result never lingers: `peakBuffered` stays 1 no matter how wide the tree.
 *   - **Latency / streaming:** partial results propagate as soon as any child
 *     finishes (surfaced via `onPartial`), instead of being gated on the
 *     slowest sibling. The wall-clock is still the critical path, but useful
 *     partial state is observable much earlier.
 *
 * The tradeoff is that `combine` must be commutative + associative, since
 * children resolve in nondeterministic order.
 */
export class StreamingHierarchyAggregator<T, R> {
  private stats: StreamingStats = { activeNodes: 0, workerRuns: 0, folds: 0, peakBuffered: 0 };
  /** Child results that have resolved but not yet been folded, across the whole run. */
  private buffered = 0;

  constructor(
    private readonly root: HierarchyNode,
    private readonly exec: StreamingAggExec<T, R>,
    private readonly opts: StreamingOptions<R> = {}
  ) {}

  async run(rootTask: T): Promise<{ result: R; stats: StreamingStats }> {
    this.stats = { activeNodes: 0, workerRuns: 0, folds: 0, peakBuffered: 0 };
    this.buffered = 0;
    const result = await this.runNode(this.root, rootTask);
    return { result, stats: this.stats };
  }

  private async runNode(node: HierarchyNode, task: T): Promise<R> {
    this.stats.activeNodes++;

    // Worker leaf (or a childless node): execute directly, producing an R.
    if (node.info.kind === "worker" || node.children.length === 0) {
      this.stats.workerRuns++;
      return this.exec.execute(task, node.info);
    }

    // Decompose into sub-tasks and pair with children (1:1, up to child count).
    const subTasks = this.exec.decompose(task, node.info);
    const pairs = node.children
      .map((child, i) => ({ child, subTask: subTasks[i] }))
      .filter((p): p is { child: HierarchyNode; subTask: T } => p.subTask !== undefined);

    let acc = this.exec.seed(node.info);

    // Fold each child's result into `acc` the moment it resolves — NOT after a
    // Promise.all barrier. Each callback runs to completion atomically (JS is
    // single-threaded), so a resolved result is folded before the next
    // microtask, keeping `buffered` at 1 while it is live.
    const fold = (childResult: R): void => {
      this.buffered++;
      if (this.buffered > this.stats.peakBuffered) this.stats.peakBuffered = this.buffered;
      acc = this.exec.combine(acc, childResult, node.info);
      this.stats.folds++;
      this.buffered--;
      this.opts.onPartial?.(acc, node.info);
    };

    // Launch all child sub-computations concurrently; attach the fold to each.
    const folded = pairs.map((p) => this.runNode(p.child, p.subTask).then(fold));
    await Promise.all(folded);

    return acc;
  }
}
