/**
 * Parallel fan-out — the "carry out tasks in parallel in a fraction of the time"
 * primitive. Items are distributed across the team's members through a **shared
 * work queue**: every member processes one item at a time and pulls the next as
 * soon as it's free, so max parallelism equals the roster size and faster members
 * naturally do more work (implicit balancing). Results come back in input order.
 */

/** How a subtask is executed on a given member (RPC, local fn, …). Injectable. */
export type FanOutDispatch<T, R> = (agentId: string, item: T, index: number) => Promise<R>;

export interface FanOutResult<R> {
  results: R[];
  /** How many items each member processed (load distribution). */
  byAgent: Record<string, number>;
  /** Indices that failed, with the error, when `continueOnError` is set. */
  failures: Array<{ index: number; error: string }>;
}

export interface FanOutOptions {
  /** Keep going past a failed item (default false → first error rejects). */
  continueOnError?: boolean;
}

export class FanOutCoordinator<T, R> {
  constructor(
    private readonly agentIds: string[],
    private readonly dispatch: FanOutDispatch<T, R>
  ) {}

  async map(items: T[], opts: FanOutOptions = {}): Promise<FanOutResult<R>> {
    if (this.agentIds.length === 0) throw new Error("fan-out needs at least one agent");
    const results = new Array<R>(items.length);
    const byAgent: Record<string, number> = {};
    const failures: Array<{ index: number; error: string }> = [];
    let next = 0;

    const worker = async (agentId: string): Promise<void> => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        try {
          results[index] = await this.dispatch(agentId, items[index], index);
          byAgent[agentId] = (byAgent[agentId] ?? 0) + 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!opts.continueOnError) throw new Error(`fan-out item ${index} on ${agentId} failed: ${message}`);
          failures.push({ index, error: message });
        }
      }
    };

    // One concurrent worker per member → parallelism == roster size.
    await Promise.all(this.agentIds.map((a) => worker(a)));

    const kept = opts.continueOnError
      ? results.filter((_, i) => !failures.some((f) => f.index === i))
      : results;
    return { results: kept, byAgent, failures };
  }
}
