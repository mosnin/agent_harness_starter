import type { FanOutDispatch } from "./fanout";

export interface LoadBalancerOptions {
  /** Extra attempts for a failed item on *other* agents. Default 2. */
  maxRetries?: number;
  /** Quarantine an agent after this many failures in a row. Default 3. */
  quarantineAfter?: number;
}

export interface BalancedResult<R> {
  results: R[];
  /** Total dispatch attempts (≥ item count when retries happen). */
  attempts: number;
  /** Agents removed from rotation for repeated failure. */
  quarantined: string[];
  failures: Array<{ index: number; error: string }>;
}

interface Pending {
  index: number;
  tried: Set<string>;
  retries: number;
}

/**
 * Fault-tolerant work distribution with **work-stealing**: a failed item is
 * re-dispatched to a *different* healthy member (up to `maxRetries`), and a
 * member that fails repeatedly is **quarantined** out of rotation so it stops
 * dragging the team down. Scheduling runs in parallel waves (width = healthy
 * roster), so throughput stays high while faults are absorbed. Where fan-out
 * assumes members are reliable, the balancer assumes they aren't.
 */
export class LoadBalancer<T, R> {
  private readonly maxRetries: number;
  private readonly quarantineAfter: number;

  constructor(
    private readonly agentIds: string[],
    private readonly dispatch: FanOutDispatch<T, R>,
    opts: LoadBalancerOptions = {}
  ) {
    this.maxRetries = opts.maxRetries ?? 2;
    this.quarantineAfter = opts.quarantineAfter ?? 3;
  }

  async run(items: T[]): Promise<BalancedResult<R>> {
    if (this.agentIds.length === 0) throw new Error("load balancer needs at least one agent");
    const results = new Array<R>(items.length);
    const done = new Array<boolean>(items.length).fill(false);
    const failures: Array<{ index: number; error: string }> = [];
    const consecFail = new Map<string, number>();
    const quarantined = new Set<string>();
    let attempts = 0;

    let pending: Pending[] = items.map((_, index) => ({ index, tried: new Set(), retries: 0 }));

    while (pending.length) {
      const healthy = this.agentIds.filter((a) => !quarantined.has(a));
      if (healthy.length === 0) {
        for (const p of pending) failures.push({ index: p.index, error: "no healthy agent available" });
        break;
      }

      // Assign a wave: prefer an agent that hasn't already failed this item (steal).
      const usedAgents = new Set<string>();
      const wave: Array<{ p: Pending; agent: string }> = [];
      const carry: Pending[] = [];
      for (const p of pending) {
        const agent =
          healthy.find((a) => !usedAgents.has(a) && !p.tried.has(a)) ??
          healthy.find((a) => !usedAgents.has(a));
        if (agent) {
          usedAgents.add(agent);
          wave.push({ p, agent });
        } else {
          carry.push(p);
        }
      }

      const outcomes = await Promise.all(
        wave.map(async ({ p, agent }) => {
          attempts++;
          try {
            const r = await this.dispatch(agent, items[p.index], p.index);
            return { p, agent, ok: true as const, r };
          } catch (err) {
            return { p, agent, ok: false as const, error: err instanceof Error ? err.message : String(err) };
          }
        })
      );

      const requeue: Pending[] = [];
      for (const o of outcomes) {
        if (o.ok) {
          results[o.p.index] = o.r;
          done[o.p.index] = true;
          consecFail.set(o.agent, 0);
        } else {
          o.p.tried.add(o.agent);
          o.p.retries++;
          const f = (consecFail.get(o.agent) ?? 0) + 1;
          consecFail.set(o.agent, f);
          if (f >= this.quarantineAfter) quarantined.add(o.agent);
          if (o.p.retries <= this.maxRetries) requeue.push(o.p);
          else failures.push({ index: o.p.index, error: o.error });
        }
      }
      pending = [...carry, ...requeue];
    }

    return {
      results: results.filter((_, i) => done[i]),
      attempts,
      quarantined: [...quarantined],
      failures,
    };
  }
}
