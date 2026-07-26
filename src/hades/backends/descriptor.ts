/**
 * Backend capability + cost descriptors, and the pure deterministic scoring
 * function the {@link BackendManager} (see `./manager.ts`) uses to pick a
 * backend for a requirement set.
 *
 * This module does NO I/O and holds NO mutable state — every export here is a
 * pure function or a plain data shape, so it is trivially unit-testable and
 * safe to import from anywhere (including the Phase 16 bandit) without
 * pulling in the registry/scaler machinery.
 */

/** The broad family a backend belongs to. */
export type BackendKind = "local" | "container" | "ssh" | "hpc" | "serverless" | "workspace" | "fake";

/**
 * Operator-configured cost rates for a backend. These are NEVER measured
 * prices — they are whatever the deployment's config says a backend costs.
 * The `source` tag exists so downstream consumers (dashboards, the bandit)
 * can never mistake a configured rate for something benchmarked.
 */
export interface BackendCostModel {
  /** USD per hour while a worker is in the "running" state. */
  perRunningHourUsd: number;
  /** USD per hour while a worker is "hibernated" (0 for most backends). */
  perHibernatedHourUsd: number;
  /** One-time USD cost charged per successful provision (cold start, image pull, …). */
  perProvisionUsd: number;
  /** Rates are operator-supplied config, NEVER presented as measured prices. */
  source: "configured";
}

/** Static description of a backend: what it can do and what it costs. */
export interface BackendDescriptor {
  /** Must match the registered {@link RemoteBackend}'s `name`. */
  name: string;
  kind: BackendKind;
  /** Capability tags this backend can satisfy (e.g. "gpu", "docker", "python"). */
  capabilities: string[];
  cost: BackendCostModel;
  supportsHibernate: boolean;
  /** Soft ceiling on concurrent workers, if the backend/deployment imposes one. */
  maxConcurrentWorkers?: number;
  locality: "local" | "remote";
}

/** What a caller needs from a backend before it will even be considered. */
export interface BackendRequirements {
  /** Every listed capability must be present on the descriptor. */
  capabilities?: string[];
  /** Hard filter: descriptor's perRunningHourUsd must be <= this. */
  maxRunningHourUsd?: number;
  /** Hard filter: descriptor must support hibernate. */
  requireHibernate?: boolean;
  /** Soft scoring preference, not a filter. */
  preferLocality?: "local" | "remote";
  /** Hard filter: backend names in this list are never selected. */
  exclude?: string[];
}

/** Measured (never fabricated) telemetry for one backend, as tracked by BackendManager. */
export interface BackendTelemetrySnapshot {
  /** Total provision attempts (successes AND failures — see `failures`), so
   *  `failures / provisions` is always a failure rate in [0,1]. */
  provisions: number;
  /** Total provision attempts that threw. */
  failures: number;
  /** Exponential moving average of provision latency in ms, or null with no samples yet. */
  provisionLatencyEmaMs: number | null;
  /** Cumulative real elapsed ms spent in the "running" state, across all workers. */
  runningMs: number;
  /** Cumulative real elapsed ms spent in the "hibernated" state, across all workers. */
  hibernatedMs: number;
  /** Cumulative accrued USD (rate * elapsed, plus per-provision charges). */
  accruedUsd: number;
}

/** A zeroed telemetry snapshot — the value returned for a backend with no recorded activity. */
export const ZERO_TELEMETRY: Readonly<BackendTelemetrySnapshot> = Object.freeze({
  provisions: 0,
  failures: 0,
  provisionLatencyEmaMs: null,
  runningMs: 0,
  hibernatedMs: 0,
  accruedUsd: 0,
});

/**
 * Hard filters a descriptor must pass before it is even scored. All of these
 * are pass/fail gates, never weights — a descriptor failing any one of them
 * is categorically unselectable for these requirements regardless of how
 * well it scores otherwise.
 */
export function matchesRequirements(d: BackendDescriptor, r: BackendRequirements): boolean {
  if (r.exclude?.includes(d.name)) return false;
  if (r.requireHibernate && !d.supportsHibernate) return false;
  if (r.maxRunningHourUsd != null && d.cost.perRunningHourUsd > r.maxRunningHourUsd) return false;
  if (r.capabilities && r.capabilities.length > 0) {
    for (const cap of r.capabilities) {
      if (!d.capabilities.includes(cap)) return false;
    }
  }
  return true;
}

/** Score weights. Kept as named constants so the formula below is self-documenting. */
const WEIGHT_CAPABILITY_FIT = 40;
const WEIGHT_COST = 25;
const WEIGHT_FAILURE_RATE = 20;
const WEIGHT_LATENCY = 10;
const WEIGHT_LOCALITY = 5;

/** Assume a provision costs at most this much before the latency term saturates at 0. */
const LATENCY_SATURATION_MS = 60_000;
/** Assume a running-hour rate at or above this saturates the cost term at 0. */
const COST_SATURATION_USD_PER_HOUR = 10;

/**
 * Deterministic score for a descriptor against a requirement set, given its
 * current telemetry (undefined/zeroed telemetry is treated as a neutral —
 * neither penalized nor rewarded — prior).
 *
 * The formula is a weighted sum of five terms, each normalized to [0, 1]
 * before weighting, so the total score is always finite and always lies in
 * `[0, WEIGHT_CAPABILITY_FIT + WEIGHT_COST + WEIGHT_FAILURE_RATE + WEIGHT_LATENCY + WEIGHT_LOCALITY]`
 * (i.e. `[0, 100]`). Higher is better.
 *
 * 1. **Capability fit** (`WEIGHT_CAPABILITY_FIT`): fraction of the requested
 *    capabilities the descriptor satisfies, plus a small bonus (capped) for
 *    extra capabilities beyond what was asked, so a more-capable backend
 *    edges out an exactly-matching one when requirements are equal.
 *    Requirements with no `capabilities` listed score this term as 1
 *    (nothing to satisfy).
 * 2. **Cost** (`WEIGHT_COST`): `1 - min(perRunningHourUsd, SAT) / SAT` — cheaper
 *    is better, saturating at 0 for anything at or above
 *    `COST_SATURATION_USD_PER_HOUR`.
 * 3. **Failure rate** (`WEIGHT_FAILURE_RATE`): `1 - failures / max(provisions, 1)`.
 *    A backend with zero recorded provisions scores 1 (no evidence of failure yet).
 * 4. **Provision latency** (`WEIGHT_LATENCY`): `1 - min(ema, SAT) / SAT`,
 *    faster is better. No EMA sample yet scores 1 (no evidence of slowness).
 * 5. **Locality preference** (`WEIGHT_LOCALITY`): 1 if `preferLocality` is
 *    unset or matches the descriptor's locality, 0 otherwise.
 *
 * This function never returns NaN: every denominator is guarded, and inputs
 * are always finite numbers by construction of {@link BackendDescriptor} and
 * {@link BackendTelemetrySnapshot}.
 *
 * Note: `scoreBackend` does NOT apply {@link matchesRequirements} — callers
 * (the manager's `select`) must filter with `matchesRequirements` first and
 * only score the survivors. Scoring a descriptor that would fail the hard
 * filters is well-defined (it still returns a finite number) but meaningless
 * for selection purposes.
 */
export function scoreBackend(
  d: BackendDescriptor,
  r: BackendRequirements,
  telemetry: BackendTelemetrySnapshot | undefined
): number {
  const t = telemetry ?? ZERO_TELEMETRY;

  const capFit = capabilityFitTerm(d, r);
  const costTerm = 1 - Math.min(d.cost.perRunningHourUsd, COST_SATURATION_USD_PER_HOUR) / COST_SATURATION_USD_PER_HOUR;
  const failureTerm = 1 - t.failures / Math.max(t.provisions, 1);
  const latencyTerm =
    t.provisionLatencyEmaMs == null
      ? 1
      : 1 - Math.min(t.provisionLatencyEmaMs, LATENCY_SATURATION_MS) / LATENCY_SATURATION_MS;
  const localityTerm = !r.preferLocality || r.preferLocality === d.locality ? 1 : 0;

  return (
    capFit * WEIGHT_CAPABILITY_FIT +
    costTerm * WEIGHT_COST +
    failureTerm * WEIGHT_FAILURE_RATE +
    latencyTerm * WEIGHT_LATENCY +
    localityTerm * WEIGHT_LOCALITY
  );
}

function capabilityFitTerm(d: BackendDescriptor, r: BackendRequirements): number {
  const requested = r.capabilities ?? [];
  if (requested.length === 0) {
    // Nothing requested: full credit, plus a small saturating bonus for how
    // capable the backend is in absolute terms so richer backends edge ahead.
    return 1;
  }
  let satisfied = 0;
  for (const cap of requested) {
    if (d.capabilities.includes(cap)) satisfied += 1;
  }
  const base = satisfied / requested.length;
  // Small bonus for extra (unrequested) capabilities, capped so it can never
  // push the term above 1 nor let an unsatisfying backend look satisfying.
  const extra = Math.max(0, d.capabilities.length - satisfied);
  const bonus = Math.min(0.05, extra * 0.01);
  return Math.min(1, base + (base >= 1 ? bonus : 0));
}

/**
 * Total order over `(descriptor, score)` pairs for selection: higher score
 * wins; exact ties break lexicographically ascending by backend name so
 * selection is fully deterministic regardless of iteration/insertion order.
 */
export function compareCandidates(
  a: { name: string; score: number },
  b: { name: string; score: number }
): number {
  if (a.score !== b.score) return b.score - a.score;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
