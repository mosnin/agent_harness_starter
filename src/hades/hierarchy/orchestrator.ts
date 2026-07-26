import type { HierarchyNode, HierarchyNodeInfo } from "./tree";

/** The three operations that define a hierarchical computation. */
export interface HierarchyExec<T, R> {
  /** Split a coordinator's task into one sub-task per child (order = children). */
  decompose: (task: T, node: HierarchyNodeInfo) => T[];
  /** Run a leaf task on a worker. */
  execute: (task: T, node: HierarchyNodeInfo) => Promise<R>;
  /** Combine children's results at a coordinator. */
  aggregate: (childResults: R[], task: T, node: HierarchyNodeInfo) => R;
}

export interface RunStats {
  /** Nodes that actually ran (a coordinator may leave children idle). */
  activeNodes: number;
  workerRuns: number;
  aggregations: number;
  reachedDepth: number;
  /** Peak number of siblings executed concurrently. */
  peakConcurrency: number;
}

/**
 * Executes a task over a swarm hierarchy: each coordinator decomposes its task,
 * dispatches the pieces to its children **in parallel**, and aggregates their
 * results; workers execute leaves. Wall-clock is bounded by the critical path
 * (depth × per-hop cost), not the total work — the point of the tree. Handlers
 * are injectable, so a real deployment plugs the swarm/LLM in behind `execute`
 * while tests stay pure.
 */
export class HierarchyOrchestrator<T, R> {
  private stats: RunStats = { activeNodes: 0, workerRuns: 0, aggregations: 0, reachedDepth: 0, peakConcurrency: 1 };

  constructor(
    private readonly root: HierarchyNode,
    private readonly exec: HierarchyExec<T, R>
  ) {}

  async run(rootTask: T): Promise<{ result: R; stats: RunStats }> {
    this.stats = { activeNodes: 0, workerRuns: 0, aggregations: 0, reachedDepth: 0, peakConcurrency: 1 };
    const result = await this.runNode(this.root, rootTask);
    return { result, stats: this.stats };
  }

  private async runNode(node: HierarchyNode, task: T): Promise<R> {
    this.stats.activeNodes++;
    this.stats.reachedDepth = Math.max(this.stats.reachedDepth, node.info.depth);

    if (node.info.kind === "worker" || node.children.length === 0) {
      this.stats.workerRuns++;
      return this.exec.execute(task, node.info);
    }

    // Decompose into sub-tasks and pair with children (1:1, up to child count).
    const subTasks = this.exec.decompose(task, node.info);
    const pairs = node.children
      .map((child, i) => ({ child, subTask: subTasks[i] }))
      .filter((p) => p.subTask !== undefined);

    this.stats.peakConcurrency = Math.max(this.stats.peakConcurrency, pairs.length);

    // Fan out to children in parallel — the hierarchy's speed comes from here.
    const childResults = await Promise.all(pairs.map((p) => this.runNode(p.child, p.subTask)));

    this.stats.aggregations++;
    return this.exec.aggregate(childResults, task, node.info);
  }
}
