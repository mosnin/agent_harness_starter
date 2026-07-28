import type { HierarchyNode } from "./tree";
import type { HierarchyExec } from "./orchestrator";
import type { SetTimeoutFn, ClearTimeoutFn } from "./timers";

/** Options tuning how aggressively the orchestrator recovers from failures. */
export interface ResilientOptions {
  /** Re-delegations of a failed subtask to OTHER children before giving up. Default 2. */
  maxReassignments?: number;
  /** Mark a node dead after this many failures; it is skipped thereafter. Default 3. */
  deadAfter?: number;
  /** Optional per-subtask timeout (ms). Uses injectable setTimeoutFn for tests. */
  timeoutMs?: number;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
  onEvent?: (e: ResilientEvent) => void;
}

/** A single observable moment in the resilience machinery, for logging/tests. */
export interface ResilientEvent {
  type: "retry" | "reassign" | "dead-node" | "subtask-failed";
  nodeId: string;
  detail?: string;
}

export interface ResilientRunStats {
  /** runNode invocations that actually executed (retries count again). */
  activeNodes: number;
  workerRuns: number;
  aggregations: number;
  reachedDepth: number;
  /** Total re-executions of a subtask after a failure (reassignments + same-node retries). */
  retries: number;
  /** Re-executions dispatched to a DIFFERENT node than the one that just failed. */
  reassignments: number;
  /** Ids of nodes retired after crossing `deadAfter` failures. */
  deadNodes: string[];
}

interface Cursor {
  i: number;
}

/**
 * Fault-tolerant variant of {@link HierarchyOrchestrator}.
 *
 * The resilience model is **coordinator-driven recovery**: a coordinator owns
 * the outcome of every sub-task it hands out, not the child it happened to pick.
 * After `decompose`, each sub-task is assigned to a child (natural child i) and
 * the children run concurrently. If a child's *subtree* rejects or blows past
 * `timeoutMs`, the coordinator catches it, retires-or-blames the child, and
 * **re-delegates that one sub-task to a different, not-yet-dead sibling**,
 * chosen round-robin among the remaining healthy children. It keeps re-delegating
 * up to `maxReassignments` times; only when no healthy sibling remains (and the
 * failed node is itself dead) does the sub-task — and hence the coordinator —
 * fail, which simply becomes a failure its *own* parent will try to reassign.
 * A localized fault therefore never sinks the whole run: it is absorbed at the
 * lowest level that still has healthy capacity.
 *
 * Failures are tallied per node id; once a node reaches `deadAfter` failures it
 * is marked dead, emitted as a `dead-node` event, and never assigned again.
 *
 * `retry` vs `reassign`: a re-execution normally moves to a healthy sibling
 * (a *reassignment*). When a sub-task fails and there is no other healthy
 * sibling left but the failed node is not yet dead, it is retried in place
 * (a *retry*) — both are re-executions (counted in `retries`), only the former
 * counts in `reassignments`.
 *
 * Timeouts are enforced by racing a child subtree against a timer created with
 * the injectable `setTimeoutFn`/`clearTimeoutFn`, so tests drive the clock
 * deterministically. A timed-out subtree is treated exactly like a rejection.
 */
export class ResilientHierarchyOrchestrator<T, R> {
  private readonly maxReassignments: number;
  private readonly deadAfter: number;
  private readonly timeoutMs: number | undefined;
  private readonly setTimeoutFn: SetTimeoutFn;
  private readonly clearTimeoutFn: ClearTimeoutFn;
  private readonly onEvent: ((e: ResilientEvent) => void) | undefined;

  private failures = new Map<string, number>();
  private dead = new Set<string>();
  private stats: ResilientRunStats = ResilientHierarchyOrchestrator.freshStats();

  constructor(
    private readonly root: HierarchyNode,
    private readonly exec: HierarchyExec<T, R>,
    opts: ResilientOptions = {}
  ) {
    this.maxReassignments = opts.maxReassignments ?? 2;
    this.deadAfter = opts.deadAfter ?? 3;
    this.timeoutMs = opts.timeoutMs;
    this.setTimeoutFn = opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((t) => clearTimeout(t));
    this.onEvent = opts.onEvent;
  }

  private static freshStats(): ResilientRunStats {
    return {
      activeNodes: 0,
      workerRuns: 0,
      aggregations: 0,
      reachedDepth: 0,
      retries: 0,
      reassignments: 0,
      deadNodes: [],
    };
  }

  async run(rootTask: T): Promise<{ result: R; stats: ResilientRunStats }> {
    this.failures = new Map<string, number>();
    this.dead = new Set<string>();
    this.stats = ResilientHierarchyOrchestrator.freshStats();
    const result = await this.runNode(this.root, rootTask);
    return { result, stats: this.stats };
  }

  private emit(e: ResilientEvent): void {
    this.onEvent?.(e);
  }

  private async runNode(node: HierarchyNode, task: T): Promise<R> {
    this.stats.activeNodes++;
    this.stats.reachedDepth = Math.max(this.stats.reachedDepth, node.info.depth);

    if (node.info.kind === "worker" || node.children.length === 0) {
      this.stats.workerRuns++;
      return this.exec.execute(task, node.info);
    }
    return this.runCoordinator(node, task);
  }

  private async runCoordinator(node: HierarchyNode, task: T): Promise<R> {
    const subTasks = this.exec.decompose(task, node.info);
    const pairs = node.children
      .map((child, i) => ({ child, subTask: subTasks[i], index: i }))
      .filter((p) => p.subTask !== undefined);

    const cursor: Cursor = { i: 0 };
    const childResults = await Promise.all(
      pairs.map((p) => this.runSubtask(node, p.subTask, p.index, p.child, cursor))
    );

    this.stats.aggregations++;
    return this.exec.aggregate(childResults, task, node.info);
  }

  /**
   * Drive one sub-task to completion, reassigning across healthy siblings (and,
   * as a last resort, retrying a still-alive node) until it succeeds or the
   * resilience budget is exhausted.
   */
  private async runSubtask(
    coordinator: HierarchyNode,
    subTask: T,
    index: number,
    naturalChild: HierarchyNode,
    cursor: Cursor
  ): Promise<R> {
    const attempted = new Set<string>();
    let current: HierarchyNode | undefined = naturalChild;
    let reExecUsed = 0;
    let lastError: unknown;

    while (true) {
      // Never dispatch to a node already retired; slide to a healthy sibling.
      if (!current || this.dead.has(current.info.id)) {
        const alt = this.pickHealthySibling(coordinator.children, attempted, cursor);
        if (!alt) break;
        current = alt;
      }

      attempted.add(current.info.id);
      try {
        return await this.runNodeWithTimeout(current, subTask);
      } catch (err) {
        lastError = err;
        this.registerFailure(current);
        this.emit({ type: "subtask-failed", nodeId: current.info.id, detail: describeError(err) });

        if (reExecUsed >= this.maxReassignments) break;

        const sibling = this.pickHealthySibling(coordinator.children, attempted, cursor);
        if (sibling) {
          reExecUsed++;
          this.stats.retries++;
          this.stats.reassignments++;
          this.emit({
            type: "reassign",
            nodeId: sibling.info.id,
            detail: `re-delegated subtask ${index} from ${current.info.id}`,
          });
          current = sibling;
          continue;
        }

        // No other healthy sibling: retry the same node while it is still alive.
        if (!this.dead.has(current.info.id)) {
          reExecUsed++;
          this.stats.retries++;
          this.emit({
            type: "retry",
            nodeId: current.info.id,
            detail: `retry subtask ${index} in place`,
          });
          continue;
        }
        break;
      }
    }

    throw new Error(
      `subtask ${index} under coordinator ${coordinator.info.id} exhausted resilience ` +
        `(re-executions used: ${reExecUsed}, max: ${this.maxReassignments}): ${describeError(lastError)}`
    );
  }

  /** Race a child subtree against the optional per-subtask timeout. */
  private runNodeWithTimeout(node: HierarchyNode, task: T): Promise<R> {
    const work = this.runNode(node, task);
    if (this.timeoutMs === undefined) return work;

    const ms = this.timeoutMs;
    return new Promise<R>((resolve, reject) => {
      let settled = false;
      const timer = this.setTimeoutFn(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`subtask timed out after ${ms}ms at node ${node.info.id}`));
      }, ms);
      work.then(
        (value) => {
          if (settled) return;
          settled = true;
          this.clearTimeoutFn(timer);
          resolve(value);
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          this.clearTimeoutFn(timer);
          reject(err instanceof Error ? err : new Error(describeError(err)));
        }
      );
    });
  }

  /** Round-robin pick of a healthy, not-yet-attempted sibling; undefined if none. */
  private pickHealthySibling(
    children: HierarchyNode[],
    attempted: Set<string>,
    cursor: Cursor
  ): HierarchyNode | undefined {
    const n = children.length;
    for (let k = 0; k < n; k++) {
      const idx = cursor.i % n;
      cursor.i++;
      const candidate = children[idx];
      if (!attempted.has(candidate.info.id) && !this.dead.has(candidate.info.id)) {
        return candidate;
      }
    }
    return undefined;
  }

  private registerFailure(node: HierarchyNode): void {
    const id = node.info.id;
    const count = (this.failures.get(id) ?? 0) + 1;
    this.failures.set(id, count);
    if (count >= this.deadAfter && !this.dead.has(id)) {
      this.dead.add(id);
      this.stats.deadNodes.push(id);
      this.emit({ type: "dead-node", nodeId: id, detail: `retired after ${count} failure(s)` });
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
