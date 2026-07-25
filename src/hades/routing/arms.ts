/**
 * The routable arm space: provider x model x (optional) execution target,
 * built from the REAL model registry (`../models/registry`) and REAL
 * published prices (`../models/client`), plus a measured, honestly-labelled
 * cost/latency predictor.
 *
 * This is the layer the bandit and the risk gate both sit on top of. It
 * answers two questions:
 *
 *   1. "What can I route to?" -- {@link ArmCatalog}. A deterministic list of
 *      {@link RoutingArm}s built once from a {@link ModelRegistry}, plus
 *      `eligible()`, a hard filter that turns an {@link ArmRequirements}
 *      policy into the subset of arms that satisfy it -- and, critically,
 *      *why* every rejected arm was rejected, so a router can explain "why
 *      was nothing eligible" instead of silently returning an empty list.
 *
 *   2. "What will pulling it cost, in dollars and milliseconds?" --
 *      {@link ArmCostModel}. Feed it real {@link UsageSample}s as they
 *      happen; it answers with a {@link CostEstimate} that is explicit about
 *      its own provenance: `"measured"` once enough real history exists,
 *      `"priced-prior"` (a list-price-derived estimate) while it doesn't,
 *      and `"unpriced"` -- never a fabricated `$0` -- for a model with no
 *      published {@link PriceEntry} at all.
 *
 * ## The adversarial cost hole this module exists to close
 *
 * `computeCost()` (imported, never re-implemented) returns `0` for a model
 * id it doesn't recognize -- a deliberate, documented behavior so live
 * accounting never throws mid-run. Composed naively, that `0` looks exactly
 * like "this arm is free", which is exactly the kind of thing a
 * cost-sensitive bandit would happily route every call to. This module
 * refuses to let that `0` escape unlabelled:
 *
 *   - {@link RoutingArm.unpriced} is `true` and {@link RoutingArm.price} is
 *     `null` for any model with no matching {@link PriceEntry} -- computed
 *     once, in {@link ArmCatalog}'s constructor, from the real price table.
 *   - {@link ArmCatalog.eligible} drops every `unpriced` arm by default
 *     (`code: "unpriced"`); a caller has to opt in with
 *     `allowUnpriced: true` to see it at all.
 *   - {@link ArmCostModel.estimate} reports `source: "unpriced"` for such an
 *     arm *unconditionally* -- never `"measured"`, never `"priced-prior"` --
 *     regardless of how many usage samples have been recorded for it, so a
 *     consumer that checks `source` (or the `unpriced` flag on the arm it
 *     came from) can never mistake it for a cheap, well-measured arm.
 *
 * ## Purity
 *
 * No `Date.now()`, no `Math.random()`, no I/O anywhere in this file. Every
 * time-dependent computation takes `now` (or a sample's `at`) as an
 * argument supplied by the caller.
 */

import type { ModelInfo } from "../models/registry";
import { ModelRegistry } from "../models/registry";
import type { PriceEntry } from "../models/client";
import { DEFAULT_PRICES, computeCost } from "../models/client";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link parseArmId} on a malformed arm id and by
 * {@link ArmCostModel.restore} on any snapshot it will not trust. `code` is
 * a stable machine-readable discriminator; `message` is the human-readable
 * detail.
 */
export class RoutingArmError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RoutingArmError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Arm identity
// ---------------------------------------------------------------------------

/** Keys that must never appear as an object key or arm id -- prototype-pollution guard. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Build the LOCKED arm id: `provider/modelId` when there is no execution
 * target, else `provider/modelId@execTarget`. `parseArmId` is its exact
 * inverse for any id this function produces.
 */
export function encodeArmId(
  provider: string,
  modelId: string,
  execTarget: string | null,
): string {
  const base = `${provider}/${modelId}`;
  return execTarget == null ? base : `${base}@${execTarget}`;
}

/**
 * Inverse of {@link encodeArmId}. Splits on the FIRST `/` for `provider`
 * (providers are not expected to contain `/`) and the LAST `@` in the
 * remainder for `execTarget` (so an execution target itself may safely
 * contain `/`, e.g. `local/gpu0`). Throws {@link RoutingArmError} with code
 * `"invalid-arm-id"` on anything that isn't a well-formed id.
 */
export function parseArmId(
  id: string,
): { provider: string; modelId: string; execTarget: string | null } {
  if (typeof id !== "string" || id.length === 0) {
    throw new RoutingArmError("invalid-arm-id", "arm id must be a non-empty string");
  }
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) {
    throw new RoutingArmError(
      "invalid-arm-id",
      `arm id "${id}" is not of the form "provider/modelId" or "provider/modelId@execTarget"`,
    );
  }
  const provider = id.slice(0, slash);
  const rest = id.slice(slash + 1);
  const at = rest.lastIndexOf("@");
  if (at === -1) {
    return { provider, modelId: rest, execTarget: null };
  }
  if (at === 0 || at === rest.length - 1) {
    throw new RoutingArmError("invalid-arm-id", `arm id "${id}" has a malformed execTarget suffix`);
  }
  return { provider, modelId: rest.slice(0, at), execTarget: rest.slice(at + 1) };
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface RoutingArm {
  id: string;
  provider: string;
  modelId: string;
  execTarget: string | null;
  displayName: string;
  contextWindow: number | null;
  tags: readonly string[];
  price: PriceEntry | null;
  /** True iff no {@link PriceEntry} matched `modelId` -- never a fabricated $0. */
  unpriced: boolean;
}

export interface ArmRequirements {
  providers?: readonly string[];
  requireTags?: readonly string[];
  excludeTags?: readonly string[];
  excludeArms?: readonly string[];
  minContextWindow?: number;
  maxUsdPerTask?: number;
  maxLatencyMs?: number;
  allowUnpriced?: boolean;
}

export interface ArmCatalogOptions {
  registry: ModelRegistry;
  prices?: readonly PriceEntry[];
  /**
   * Execution targets to cross with every model, e.g. `["local", "cloud"]`.
   * Omitted or empty => every model gets exactly one arm with
   * `execTarget: null`. De-duplicated and sorted internally so option
   * ordering never affects `arms()` ordering.
   */
  execTargets?: readonly string[];
  /**
   * Real-time availability predicate (e.g. "is this backend currently up").
   * Consulted only by `eligible()` (code `"unavailable"`) -- `arms()`,
   * `get()`, and `has()` always reflect the static, full arm space.
   */
  available?: (arm: RoutingArm) => boolean;
}

export type RejectionCode =
  | "unavailable"
  | "provider-excluded"
  | "tag-missing"
  | "tag-excluded"
  | "arm-excluded"
  | "context-too-small"
  | "over-usd-cap"
  | "over-latency-cap"
  | "unpriced";

export interface EligibilityResult {
  arms: RoutingArm[];
  rejected: Array<{ armId: string; code: RejectionCode; detail: string }>;
}

export interface TaskCostContext {
  promptTokens: number;
  expectedOutputTokens: number;
}

export interface UsageSample {
  armId: string;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  latencyMs: number;
  at: number;
}

export interface CostEstimate {
  armId: string;
  usdMean: number;
  usdP90: number;
  usdStdDev: number;
  latencyMsMean: number;
  latencyMsP90: number;
  samples: number;
  source: "measured" | "priced-prior" | "unpriced";
}

export interface ArmCostModelOptions {
  prices?: readonly PriceEntry[];
  /** Minimum real samples before `source` may say `"measured"`. Default 5, clamped to >= 1. */
  minSamples?: number;
  /** EWMA half-life, in ms, over inter-sample elapsed time. Default 30 minutes, clamped to >= 1. */
  halfLifeMs?: number;
  /** Bounded sliding-window size used for P90 and variance. Default 50, clamped to >= 1. */
  window?: number;
}

export interface ArmCostSnapshot {
  version: 1;
  arms: Array<{
    armId: string;
    totalCount: number;
    ewmaUsdRate: number;
    ewmaLatency: number;
    lastAt: number;
    usdRateWindow: number[];
    latencyWindow: number[];
  }>;
}

// ---------------------------------------------------------------------------
// ArmCatalog
// ---------------------------------------------------------------------------

export class ArmCatalog {
  private readonly armList: readonly RoutingArm[];
  private readonly armMap: ReadonlyMap<string, RoutingArm>;
  private readonly availableFn?: (arm: RoutingArm) => boolean;

  constructor(opts: ArmCatalogOptions) {
    const prices = opts.prices ? [...opts.prices] : DEFAULT_PRICES;
    this.availableFn = opts.available;

    const execTargets: ReadonlyArray<string | null> =
      opts.execTargets && opts.execTargets.length > 0
        ? [...new Set(opts.execTargets)].sort((a, b) => a.localeCompare(b))
        : [null];

    const models: ModelInfo[] = [...opts.registry.list()].sort((a, b) =>
      a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider),
    );

    const list: RoutingArm[] = [];
    const map = new Map<string, RoutingArm>();
    for (const model of models) {
      const priceEntry = prices.find((p) => p.model === model.id) ?? null;
      for (const execTarget of execTargets) {
        const arm: RoutingArm = {
          id: encodeArmId(model.provider, model.id, execTarget),
          provider: model.provider,
          modelId: model.id,
          execTarget,
          displayName: model.displayName,
          contextWindow: model.contextWindow ?? null,
          tags: model.tags ? [...model.tags] : [],
          price: priceEntry,
          unpriced: priceEntry === null,
        };
        list.push(arm);
        map.set(arm.id, arm);
      }
    }
    this.armList = list;
    this.armMap = map;
  }

  /** Deterministic order: provider, then modelId, then execTarget. */
  arms(): RoutingArm[] {
    return [...this.armList];
  }

  get(armId: string): RoutingArm | undefined {
    return this.armMap.get(armId);
  }

  has(armId: string): boolean {
    return this.armMap.has(armId);
  }

  /**
   * Apply a hard eligibility filter. Every arm ends up in exactly one of
   * `arms` (passed everything) or `rejected` (with the id, the first
   * requirement it failed, and a human-readable detail) -- nothing is
   * silently dropped, so a router can always explain "why was nothing
   * eligible".
   *
   * Budget checks (`maxUsdPerTask` / `maxLatencyMs`) compare against the
   * P90 estimate, not the mean -- this is a hard gate, so it is
   * deliberately conservative. Because this method has no wall clock of its
   * own (`now` is not part of the locked signature), it calls
   * `cost.estimate(arm, ctx, 0)`: combined with `ArmCostModel`'s clamping of
   * negative elapsed time to zero, a `now` of `0` always evaluates as
   * maximally fresh (no staleness blending toward the list-price prior) --
   * the conservative choice for a gate that would rather over- than
   * under-estimate risk from stale data.
   */
  eligible(req: ArmRequirements, ctx: TaskCostContext, cost: ArmCostModel): EligibilityResult {
    const arms: RoutingArm[] = [];
    const rejected: EligibilityResult["rejected"] = [];

    for (const arm of this.armList) {
      if (this.availableFn && !this.availableFn(arm)) {
        rejected.push({
          armId: arm.id,
          code: "unavailable",
          detail: `arm "${arm.id}" was reported unavailable by the catalog's availability predicate`,
        });
        continue;
      }

      if (req.excludeArms && req.excludeArms.includes(arm.id)) {
        rejected.push({
          armId: arm.id,
          code: "arm-excluded",
          detail: `arm "${arm.id}" is explicitly excluded by excludeArms`,
        });
        continue;
      }

      if (req.providers && req.providers.length > 0 && !req.providers.includes(arm.provider)) {
        rejected.push({
          armId: arm.id,
          code: "provider-excluded",
          detail: `provider "${arm.provider}" is not in the allowed provider list [${req.providers.join(", ")}]`,
        });
        continue;
      }

      if (req.requireTags && req.requireTags.length > 0) {
        const missing = req.requireTags.filter((t) => !arm.tags.includes(t));
        if (missing.length > 0) {
          rejected.push({
            armId: arm.id,
            code: "tag-missing",
            detail: `arm "${arm.id}" is missing required tag(s): ${missing.join(", ")}`,
          });
          continue;
        }
      }

      if (req.excludeTags && req.excludeTags.length > 0) {
        const hit = req.excludeTags.filter((t) => arm.tags.includes(t));
        if (hit.length > 0) {
          rejected.push({
            armId: arm.id,
            code: "tag-excluded",
            detail: `arm "${arm.id}" carries excluded tag(s): ${hit.join(", ")}`,
          });
          continue;
        }
      }

      if (req.minContextWindow != null) {
        if (arm.contextWindow == null || arm.contextWindow < req.minContextWindow) {
          rejected.push({
            armId: arm.id,
            code: "context-too-small",
            detail: `context window ${arm.contextWindow ?? "unknown"} is below the required minimum ${req.minContextWindow}`,
          });
          continue;
        }
      }

      if (arm.unpriced && !req.allowUnpriced) {
        rejected.push({
          armId: arm.id,
          code: "unpriced",
          detail: `arm "${arm.id}" (model "${arm.modelId}") has no published price entry and allowUnpriced is not set`,
        });
        continue;
      }

      if (req.maxUsdPerTask != null || req.maxLatencyMs != null) {
        const estimate = cost.estimate(arm, ctx, 0);
        if (req.maxUsdPerTask != null && estimate.usdP90 > req.maxUsdPerTask) {
          rejected.push({
            armId: arm.id,
            code: "over-usd-cap",
            detail: `estimated P90 cost $${estimate.usdP90.toFixed(6)} exceeds cap $${req.maxUsdPerTask}`,
          });
          continue;
        }
        if (req.maxLatencyMs != null && estimate.latencyMsP90 > req.maxLatencyMs) {
          rejected.push({
            armId: arm.id,
            code: "over-latency-cap",
            detail: `estimated P90 latency ${estimate.latencyMsP90}ms exceeds cap ${req.maxLatencyMs}ms`,
          });
          continue;
        }
      }

      arms.push(arm);
    }

    return { arms, rejected };
  }
}

// ---------------------------------------------------------------------------
// Small numeric helpers -- pure, NaN/Infinity-free by construction
// ---------------------------------------------------------------------------

/** Coerce to a finite, non-negative number (never NaN/Infinity/-0/negative). */
function cleanNonNeg(v: unknown): number {
  const n = typeof v === "number" ? v : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return 0;
  return Object.is(n, -0) ? 0 : n;
}

/** Push `value` onto `arr` (most-recent-last), evicting the oldest once over `cap`. Mutates `arr`. */
function pushBounded(arr: number[], value: number, cap: number): void {
  arr.push(value);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

/** Welford's single-pass, numerically-stable mean/variance (population variance; 0 for n<=1). */
function welford(values: readonly number[]): { mean: number; variance: number } {
  let mean = 0;
  let m2 = 0;
  let n = 0;
  for (const x of values) {
    n++;
    const delta = x - mean;
    mean += delta / n;
    const delta2 = x - mean;
    m2 += delta * delta2;
  }
  if (n === 0) return { mean: 0, variance: 0 };
  return { mean, variance: n > 1 ? m2 / n : 0 };
}

/**
 * P90 (or any 0..1 quantile) of an already-sorted array using linear
 * interpolation between closest ranks (the same rule as NumPy's default
 * `"linear"` method): `idx = p * (n - 1)`, interpolate between
 * `floor(idx)` and `ceil(idx)`. Returns 0 for an empty array.
 */
function percentileSorted(sorted: readonly number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const idx = p * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

function sortedCopy(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// ArmCostModel
// ---------------------------------------------------------------------------

interface ArmState {
  /** All-time count of recorded samples for this arm -- never shrinks, gates `minSamples`. */
  totalCount: number;
  /** Time-decayed EWMA of `usd / max(1, tokensIn + tokensOut)`. */
  ewmaUsdRate: number;
  /** Time-decayed EWMA of `latencyMs`. */
  ewmaLatency: number;
  lastAt: number;
  /** Bounded sliding window of raw per-sample $/token rates, for P90 + Welford variance. */
  usdRateWindow: number[];
  /** Bounded sliding window of raw per-sample latencies, for P90. */
  latencyWindow: number[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function assertSafeKeys(obj: Record<string, unknown>, where: string): void {
  for (const key of Object.keys(obj)) {
    if (UNSAFE_KEYS.has(key)) {
      throw new RoutingArmError("unsafe-key", `${where} contains a disallowed key "${key}"`);
    }
  }
}

function assertFiniteNonNegative(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || Object.is(v, -0) || v < 0) {
    throw new RoutingArmError(
      "invalid-number",
      `field "${field}" must be a finite, non-negative number (received ${JSON.stringify(v)})`,
    );
  }
  return v;
}

/**
 * Measured, honestly-labelled cost/latency predictor for {@link RoutingArm}s.
 *
 * `estimate()` picks one of three `source`s, in order of trustworthiness:
 *
 *   - `"measured"` -- the arm is priced AND has at least `minSamples` real
 *     {@link UsageSample}s. `usdMean`/`usdP90` come from a time-decayed EWMA
 *     of the observed `$`-per-token rate, scaled to the requested task's
 *     token count (this is what makes estimates monotone in
 *     `promptTokens`/`expectedOutputTokens` rather than a flat historical
 *     average) and blended with the list-price prior as staleness (`now -
 *     lastAt`) grows, using the same half-life decay as the EWMA itself.
 *   - `"priced-prior"` -- the arm is priced but hasn't accumulated
 *     `minSamples` yet. `usdMean` is exactly `computeCost(...)` against the
 *     model's real published price at the requested token counts; `usdP90
 *     === usdMean` and `usdStdDev === 0` because there is no observed
 *     variance to report yet.
 *   - `"unpriced"` -- the arm has no {@link PriceEntry} at all. This is
 *     UNCONDITIONAL: even if real samples exist for it, `source` never says
 *     `"measured"` or `"priced-prior"`, because there is no vendor price to
 *     validate those numbers against. `usdMean`/`usdP90` are 0 with
 *     `samples: 0` when nothing has ever been recorded; if real samples do
 *     exist they are reported (rate-scaled, same as `"measured"`) but the
 *     `source` label still says `"unpriced"` so a consumer that checks it
 *     can never treat this as an interchangeably "cheap" arm.
 *
 * Latency (`latencyMsMean`/`latencyMsP90`) has no analogous published prior
 * -- there is no vendor "list latency" -- so it is *always* derived purely
 * from measured samples (0 with 0 samples), independent of `source`.
 */
export class ArmCostModel {
  private readonly prices: readonly PriceEntry[];
  private readonly minSamples: number;
  private readonly halfLifeMs: number;
  private readonly window: number;
  private readonly states = new Map<string, ArmState>();

  constructor(opts: ArmCostModelOptions = {}) {
    this.prices = opts.prices ? [...opts.prices] : DEFAULT_PRICES;
    this.minSamples = Math.max(1, Math.floor(cleanNonNeg(opts.minSamples ?? 5)) || 1);
    this.halfLifeMs = Math.max(1, opts.halfLifeMs ?? 30 * 60 * 1000);
    this.window = Math.max(1, Math.floor(opts.window ?? 50));
  }

  record(sample: UsageSample): void {
    const armId = String(sample.armId);
    const usd = cleanNonNeg(sample.usd);
    const tokensIn = cleanNonNeg(sample.tokensIn);
    const tokensOut = cleanNonNeg(sample.tokensOut);
    const latencyMs = cleanNonNeg(sample.latencyMs);
    const at = cleanNonNeg(sample.at);
    const tokens = Math.max(1, tokensIn + tokensOut);
    const rate = usd / tokens;

    let state = this.states.get(armId);
    if (!state) {
      state = {
        totalCount: 0,
        ewmaUsdRate: rate,
        ewmaLatency: latencyMs,
        lastAt: at,
        usdRateWindow: [],
        latencyWindow: [],
      };
      this.states.set(armId, state);
    } else {
      const dt = Math.max(0, at - state.lastAt);
      const decay = Math.pow(0.5, dt / this.halfLifeMs);
      state.ewmaUsdRate = decay * state.ewmaUsdRate + (1 - decay) * rate;
      state.ewmaLatency = decay * state.ewmaLatency + (1 - decay) * latencyMs;
      state.lastAt = at;
    }
    state.totalCount++;
    pushBounded(state.usdRateWindow, rate, this.window);
    pushBounded(state.latencyWindow, latencyMs, this.window);
  }

  samples(armId: string): number {
    return this.states.get(armId)?.totalCount ?? 0;
  }

  estimate(arm: RoutingArm, ctx: TaskCostContext, now: number): CostEstimate {
    const promptTokens = cleanNonNeg(ctx.promptTokens);
    const outputTokens = cleanNonNeg(ctx.expectedOutputTokens);
    const totalTokens = promptTokens + outputTokens;
    const state = this.states.get(arm.id);
    const totalCount = state?.totalCount ?? 0;

    const latencyMsMean = state ? cleanNonNeg(state.ewmaLatency) : 0;
    const latencyMsP90 = state && state.latencyWindow.length > 0
      ? cleanNonNeg(percentileSorted(sortedCopy(state.latencyWindow), 0.9))
      : 0;

    const priced = !arm.unpriced && arm.price != null;

    if (!priced) {
      // UNCONDITIONALLY "unpriced" -- see class doc. Real measured samples,
      // if any exist, are still surfaced (rate-scaled), but never relabelled.
      if (!state || totalCount === 0) {
        return {
          armId: arm.id,
          usdMean: 0,
          usdP90: 0,
          usdStdDev: 0,
          latencyMsMean: 0,
          latencyMsP90: 0,
          samples: 0,
          source: "unpriced",
        };
      }
      const { variance } = welford(state.usdRateWindow);
      const usdMean = cleanNonNeg(state.ewmaUsdRate) * totalTokens;
      const usdStdDev = cleanNonNeg(Math.sqrt(Math.max(0, variance)) * totalTokens);
      const usdP90 = cleanNonNeg(
        percentileSorted(sortedCopy(state.usdRateWindow), 0.9) * totalTokens,
      );
      return {
        armId: arm.id,
        usdMean,
        usdP90,
        usdStdDev,
        latencyMsMean,
        latencyMsP90,
        samples: totalCount,
        source: "unpriced",
      };
    }

    const priceEntry = arm.price as PriceEntry;
    const pricedPriorUsd = cleanNonNeg(
      computeCost(arm.modelId, promptTokens, outputTokens, [priceEntry]),
    );

    if (totalCount >= this.minSamples && state) {
      const dtSinceLast = Math.max(0, cleanNonNeg(now) - state.lastAt);
      const blend = Math.pow(0.5, dtSinceLast / this.halfLifeMs); // 1 = fully "measured", ->0 fully "priced-prior"
      const measuredUsd = cleanNonNeg(state.ewmaUsdRate) * totalTokens;
      const { variance } = welford(state.usdRateWindow);
      const rateP90 = percentileSorted(sortedCopy(state.usdRateWindow), 0.9);

      const usdMean = cleanNonNeg(blend * measuredUsd + (1 - blend) * pricedPriorUsd);
      const usdStdDev = cleanNonNeg(blend * Math.sqrt(Math.max(0, variance)) * totalTokens);
      const usdP90 = cleanNonNeg(blend * rateP90 * totalTokens + (1 - blend) * pricedPriorUsd);

      return {
        armId: arm.id,
        usdMean,
        usdP90,
        usdStdDev,
        latencyMsMean,
        latencyMsP90,
        samples: totalCount,
        source: "measured",
      };
    }

    return {
      armId: arm.id,
      usdMean: pricedPriorUsd,
      usdP90: pricedPriorUsd,
      usdStdDev: 0,
      latencyMsMean,
      latencyMsP90,
      samples: totalCount,
      source: "priced-prior",
    };
  }

  snapshot(): ArmCostSnapshot {
    const arms = [...this.states.entries()]
      .filter(([, s]) => s.totalCount > 0)
      .map(([armId, s]) => ({
        armId,
        totalCount: s.totalCount,
        ewmaUsdRate: s.ewmaUsdRate,
        ewmaLatency: s.ewmaLatency,
        lastAt: s.lastAt,
        usdRateWindow: [...s.usdRateWindow],
        latencyWindow: [...s.latencyWindow],
      }))
      .sort((a, b) => a.armId.localeCompare(b.armId));
    return { version: 1, arms };
  }

  static restore(snap: unknown, opts?: ArmCostModelOptions): ArmCostModel {
    if (!isPlainObject(snap)) {
      throw new RoutingArmError("not-an-object", "snapshot must be a plain object");
    }
    assertSafeKeys(snap, "snapshot");
    if (snap.version !== 1) {
      throw new RoutingArmError(
        "bad-version",
        `unsupported snapshot version: ${JSON.stringify(snap.version)}`,
      );
    }
    if (!Array.isArray(snap.arms)) {
      throw new RoutingArmError("malformed-arm", "snapshot.arms must be an array");
    }

    const model = new ArmCostModel(opts);
    const seen = new Set<string>();

    for (const raw of snap.arms) {
      if (!isPlainObject(raw)) {
        throw new RoutingArmError("malformed-arm", "each snapshot arm entry must be a plain object");
      }
      assertSafeKeys(raw, "snapshot arm entry");

      const armId = raw.armId;
      if (typeof armId !== "string" || armId.length === 0) {
        throw new RoutingArmError("malformed-arm", "arm entry armId must be a non-empty string");
      }
      if (UNSAFE_KEYS.has(armId)) {
        throw new RoutingArmError("unsafe-key", `armId "${armId}" is a disallowed key`);
      }
      if (seen.has(armId)) {
        throw new RoutingArmError("duplicate-arm", `duplicate armId in snapshot: "${armId}"`);
      }
      seen.add(armId);

      const totalCount = raw.totalCount;
      if (
        typeof totalCount !== "number" ||
        !Number.isInteger(totalCount) ||
        Object.is(totalCount, -0) ||
        totalCount < 0
      ) {
        throw new RoutingArmError(
          "negative-count",
          `arm "${armId}" totalCount must be a non-negative integer (received ${JSON.stringify(totalCount)})`,
        );
      }

      const ewmaUsdRate = assertFiniteNonNegative(raw.ewmaUsdRate, `${armId}.ewmaUsdRate`);
      const ewmaLatency = assertFiniteNonNegative(raw.ewmaLatency, `${armId}.ewmaLatency`);
      const lastAt = assertFiniteNonNegative(raw.lastAt, `${armId}.lastAt`);

      if (!Array.isArray(raw.usdRateWindow) || !Array.isArray(raw.latencyWindow)) {
        throw new RoutingArmError("malformed-arm", `arm "${armId}" window fields must be arrays`);
      }
      const usdRateWindow = raw.usdRateWindow.map((v, i) =>
        assertFiniteNonNegative(v, `${armId}.usdRateWindow[${i}]`),
      );
      const latencyWindow = raw.latencyWindow.map((v, i) =>
        assertFiniteNonNegative(v, `${armId}.latencyWindow[${i}]`),
      );

      // Direct access to another instance's private fields is legal TS
      // within the class body -- this is how the static factory seeds state
      // without re-running record()'s EWMA update logic over stored values.
      model.states.set(armId, {
        totalCount,
        ewmaUsdRate,
        ewmaLatency,
        lastAt,
        usdRateWindow: usdRateWindow.slice(-model.window),
        latencyWindow: latencyWindow.slice(-model.window),
      });
    }

    return model;
  }
}
