/** A counting semaphore — bounds how many items occupy a stage at once. */
class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
  }
  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

/** One stage of the assembly line, optionally owned by a role and bounded. */
export interface PipelineStage<I = unknown, O = unknown> {
  name?: string;
  role?: string;
  /** Max items in this stage concurrently (default: unbounded). */
  concurrency?: number;
  handle: (input: I, index: number) => Promise<O>;
}

export interface PipelineResult<R> {
  results: R[];
  /** Items processed per stage (by name/role/index). */
  byStage: Record<string, number>;
}

export interface PipelineOptions {
  /** Keep going past a failed item instead of rejecting. Default false. */
  continueOnError?: boolean;
}

/**
 * Assembly-line parallelism across roles. Every item flows through all stages in
 * order, but **there is no barrier between stages** — item B can be in stage 1
 * while item A is already in stage 3 — so wall-clock is the slowest single-item
 * chain, not the sum of per-stage totals. Each stage carries its own concurrency
 * bound (its role's agent count), enforced by a semaphore. Results come back in
 * input order.
 */
export async function pipeline<R = unknown>(
  items: unknown[],
  stages: PipelineStage[],
  opts: PipelineOptions = {}
): Promise<PipelineResult<R>> {
  if (stages.length === 0) throw new Error("pipeline needs at least one stage");
  const sems = stages.map((s) => new Semaphore(s.concurrency ?? Infinity));
  const byStage: Record<string, number> = {};
  const label = (s: PipelineStage, i: number) => s.name ?? s.role ?? `stage${i}`;

  const runChain = async (item: unknown, index: number): Promise<{ ok: true; value: R } | { ok: false; error: string }> => {
    let current: unknown = item;
    for (let s = 0; s < stages.length; s++) {
      await sems[s].acquire();
      try {
        current = await stages[s].handle(current, index);
        const key = label(stages[s], s);
        byStage[key] = (byStage[key] ?? 0) + 1;
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      } finally {
        sems[s].release();
      }
    }
    return { ok: true, value: current as R };
  };

  const settled = await Promise.all(items.map((item, i) => runChain(item, i)));
  const results: R[] = [];
  for (let i = 0; i < settled.length; i++) {
    const o = settled[i];
    if (o.ok) results.push(o.value);
    else if (!opts.continueOnError) throw new Error(`pipeline item ${i} failed: ${o.error}`);
  }
  return { results, byStage };
}
