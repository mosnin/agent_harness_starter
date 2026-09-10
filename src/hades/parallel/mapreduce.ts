import { FanOutCoordinator } from "./fanout";
import type { FanOutDispatch } from "./fanout";

export interface MapReduceSpec<T, M, R> {
  /** Per-item map, run on a team member (parallel scatter phase). */
  map: FanOutDispatch<T, M>;
  /** Fold the mapped results (in input order) into the final value. */
  reduce: (acc: R, mapped: M, index: number) => R;
  /** Seed for the reduce. */
  initial: R;
}

export interface MapReduceResult<M, R> {
  result: R;
  /** The per-item mapped values, in order (the gather). */
  mapped: M[];
  /** Load distribution across the roster during the map phase. */
  byAgent: Record<string, number>;
}

/**
 * Scatter → gather → reduce over the team. The **map** phase fans items across
 * the roster in parallel (via {@link FanOutCoordinator}); the **gather** keeps
 * results in input order; the **reduce** folds them into one value. This is the
 * classic map-reduce shape — the parallel work is the expensive map, so a team of
 * N shrinks it toward 1/N wall-clock while the reduce stays cheap and
 * deterministic.
 */
export async function mapReduce<T, M, R>(
  agentIds: string[],
  items: T[],
  spec: MapReduceSpec<T, M, R>
): Promise<MapReduceResult<M, R>> {
  const fan = new FanOutCoordinator<T, M>(agentIds, spec.map);
  const { results: mapped, byAgent } = await fan.map(items);
  let acc = spec.initial;
  for (let i = 0; i < mapped.length; i++) acc = spec.reduce(acc, mapped[i], i);
  return { result: acc, mapped, byAgent };
}
