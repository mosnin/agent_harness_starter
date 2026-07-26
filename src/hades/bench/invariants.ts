/**
 * Performance-invariant PRIMITIVES for the Hades swarm.
 *
 * These are reusable measurement + assertion building blocks that ENCODE the
 * architectural performance claims as executable, failing-when-broken checks:
 *
 *   - Direct A2A routing is O(1): scans-per-send is a constant, independent of
 *     roster size ({@link measureRouteScans}, {@link assertO1Routing}).
 *   - A depth-bounded critical path grows SUB-LINEARLY in the fan-out width
 *     ({@link assertSubLinearGrowth}).
 *   - Aggregation is CORRECT: computed results match the reference elementwise
 *     ({@link assertResultsMatch}).
 *
 * Everything here is pure and deterministic — it reasons about COUNTS and RATIOS
 * (from the transport's `routeScans` instrumentation), never wall-clock time.
 * There is no `Math.random` and no clock read, so these primitives are safe to
 * assert on in CI: a regression that turns the indexed router back into a
 * roster-scanning one, or that makes the critical path linear, makes the
 * relevant assertion THROW.
 *
 * The transport measurement reuses the exact pattern of `benchRoutingScaling` in
 * `live-bench.ts` (register a roster on a fresh transport, zero `routeScans`,
 * drive direct sends, read the delta) but drives it against the public
 * production API only.
 */

import { InMemoryA2ATransport } from "../a2a/bus";
import type { A2AMessage, AgentAddress } from "../a2a/types";

/** Result of an ordinary-least-squares fit: `y ≈ slope·x + intercept`. */
export interface LinearFit {
  slope: number;
  intercept: number;
  /** Coefficient of determination in [0, 1]; 1 = perfect linear fit. */
  r2: number;
}

/**
 * Ordinary least-squares fit of `ys` onto `xs`.
 *
 * Edge cases (documented, no throw):
 *  - `xs.length !== ys.length` throws (caller bug — the series must be paired).
 *  - `n < 2`: not enough points to define a line → `{ slope: 0, intercept:
 *    ys[0] ?? 0, r2: 0 }`.
 *  - zero variance in `xs` (all x equal): slope is undefined, so we return
 *    `slope: 0`, `intercept` = mean(ys). r2 is 1 when ys is also constant
 *    (the horizontal line fits perfectly) and 0 otherwise (a vertical cloud
 *    that no line through a single x explains).
 *  - zero variance in `ys` (perfectly flat data): slope 0, r2 1 (total sum of
 *    squares is 0 — the flat line is an exact fit).
 */
export function linearFit(xs: number[], ys: number[]): LinearFit {
  if (xs.length !== ys.length) {
    throw new Error(
      `linearFit: xs and ys must have equal length (got ${xs.length} and ${ys.length})`
    );
  }
  const n = xs.length;
  if (n < 2) {
    return { slope: 0, intercept: n === 1 ? ys[0] : 0, r2: 0 };
  }

  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;

  let sxx = 0; // Σ (x - mx)^2
  let sxy = 0; // Σ (x - mx)(y - my)
  let syy = 0; // Σ (y - my)^2  (== total sum of squares)
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }

  // Zero variance in xs: no line is defined by the data. Fall back to a flat
  // line at mean(ys); it fits perfectly iff ys is itself constant.
  if (sxx === 0) {
    return { slope: 0, intercept: my, r2: syy === 0 ? 1 : 0 };
  }

  const slope = sxy / sxx;
  const intercept = my - slope * mx;

  // r2 = 1 - SSres/SStot. When SStot (syy) is 0 the data is perfectly flat and
  // the fitted line (slope 0) reproduces it exactly → r2 = 1.
  if (syy === 0) {
    return { slope, intercept, r2: 1 };
  }
  const ssRes = syy - slope * sxy; // == Σ (y - ŷ)^2 for the OLS line
  const r2 = 1 - ssRes / syy;
  return { slope, intercept, r2 };
}

/** A no-op inbox handler — we only care about routing counts, not delivery. */
const NOOP = (_msg: A2AMessage): void => {};

/**
 * Total `transport.routeScans` consumed by sending `sends` DIRECT unicast
 * messages to registered recipients, on a FRESH {@link InMemoryA2ATransport}
 * with `rosterSize` registered agents.
 *
 * Registers `rosterSize` distinct inboxes (`a0`..`a{n-1}`), zeroes the
 * instrumentation counter, then publishes `sends` unicast envelopes addressed
 * round-robin to specific registered members, and returns the `routeScans`
 * delta. For a correct O(1) transport the delta is exactly `sends` (one
 * `Map.get` per send); a roster-scanning router would return ≈ sends·rosterSize.
 */
export function measureRouteScans(rosterSize: number, sends: number): number {
  if (!Number.isInteger(rosterSize) || rosterSize < 1) {
    throw new Error(`measureRouteScans: rosterSize must be a positive integer (got ${rosterSize})`);
  }
  if (!Number.isInteger(sends) || sends < 0) {
    throw new Error(`measureRouteScans: sends must be a non-negative integer (got ${sends})`);
  }

  const transport = new InMemoryA2ATransport();
  const addresses: AgentAddress[] = [];
  for (let i = 0; i < rosterSize; i++) {
    const address: AgentAddress = { agentId: `a${i}`, team: "bench" };
    addresses.push(address);
    transport.register(address, NOOP);
  }

  // A dedicated sender that is NOT a member of the roster, so a send to any
  // member is always a genuine cross-agent unicast delivery.
  const sender: AgentAddress = { agentId: "sender", team: "bench" };

  const before = transport.routeScans;
  for (let i = 0; i < sends; i++) {
    const to = addresses[i % rosterSize];
    const msg: A2AMessage = {
      id: `m${i}`,
      from: sender,
      to,
      kind: "event",
      payload: i,
      ts: 0,
    };
    transport.publish(msg);
  }
  return transport.routeScans - before;
}

/**
 * Assert direct routing is O(1): scans-per-send is a constant independent of
 * roster size.
 *
 * For each size, `scansPerSend = measureRouteScans(size, sendsPerSize) /
 * sendsPerSize` must be `<= opts.maxScansPerSend` (default `1.000001`, a hair
 * above the ideal 1 to absorb any float noise — in practice the measurement is
 * an exact integer ratio). Throws an {@link Error} naming the offending size and
 * its measured value the moment routing starts to grow with the roster; this is
 * the guardrail that makes a regression to a scanning router fail CI.
 *
 * Returns the per-size measurements (in input order) on success.
 */
export function assertO1Routing(
  rosterSizes: number[],
  sendsPerSize: number,
  opts: { maxScansPerSend?: number } = {}
): Array<{ size: number; scansPerSend: number }> {
  const maxScansPerSend = opts.maxScansPerSend ?? 1.000001;
  if (rosterSizes.length === 0) {
    throw new Error("assertO1Routing: rosterSizes must be non-empty");
  }
  if (!Number.isInteger(sendsPerSize) || sendsPerSize < 1) {
    throw new Error(
      `assertO1Routing: sendsPerSize must be a positive integer (got ${sendsPerSize})`
    );
  }

  const measurements: Array<{ size: number; scansPerSend: number }> = [];
  for (const size of rosterSizes) {
    const scans = measureRouteScans(size, sendsPerSize);
    const scansPerSend = scans / sendsPerSize;
    measurements.push({ size, scansPerSend });
    if (scansPerSend > maxScansPerSend) {
      throw new Error(
        `assertO1Routing: routing is NOT O(1) — roster size ${size} used ` +
          `${scansPerSend} scans/send (limit ${maxScansPerSend}). Direct unicast ` +
          `routing must be a constant-cost Map lookup independent of roster size.`
      );
    }
  }
  return measurements;
}

/**
 * Assert `values` grow SUB-LINEARLY in `ns` — e.g. a depth-bounded /
 * logarithmic critical path against an exponentially widening fan-out.
 *
 * Let `nRatio = last/first of ns` and `valueRatio = last/first of values`.
 * Requires `valueRatio <= opts.fraction * nRatio` (default fraction `0.25` —
 * the measured quantity may grow at most a quarter as fast as `n`). Throws an
 * {@link Error} carrying both ratios when the quantity grows too fast (i.e.
 * linearly), which is what an adversarial linear-growth series triggers.
 *
 * Requires `ns` strictly increasing with length ≥ 2, and `ns[0] > 0`,
 * `values[0] > 0` so the ratios are well-defined.
 */
export function assertSubLinearGrowth(
  ns: number[],
  values: number[],
  opts: { fraction?: number } = {}
): void {
  const fraction = opts.fraction ?? 0.25;
  if (ns.length < 2) {
    throw new Error(`assertSubLinearGrowth: ns must have length >= 2 (got ${ns.length})`);
  }
  if (ns.length !== values.length) {
    throw new Error(
      `assertSubLinearGrowth: ns and values must have equal length (got ${ns.length} and ${values.length})`
    );
  }
  for (let i = 1; i < ns.length; i++) {
    if (ns[i] <= ns[i - 1]) {
      throw new Error(
        `assertSubLinearGrowth: ns must be strictly increasing (ns[${i}]=${ns[i]} <= ns[${i - 1}]=${ns[i - 1]})`
      );
    }
  }
  const nFirst = ns[0];
  const vFirst = values[0];
  if (nFirst <= 0) {
    throw new Error(`assertSubLinearGrowth: ns[0] must be > 0 (got ${nFirst})`);
  }
  if (vFirst <= 0) {
    throw new Error(`assertSubLinearGrowth: values[0] must be > 0 (got ${vFirst})`);
  }

  const nRatio = ns[ns.length - 1] / nFirst;
  const valueRatio = values[values.length - 1] / vFirst;
  const budget = fraction * nRatio;
  if (valueRatio > budget) {
    throw new Error(
      `assertSubLinearGrowth: growth is NOT sub-linear — values grew ${valueRatio}x ` +
        `while n grew ${nRatio}x (allowed at most ${fraction} * ${nRatio} = ${budget}x). ` +
        `The critical path must stay depth-bounded as fan-out widens.`
    );
  }
}

/**
 * Assert two numeric arrays are equal elementwise within `eps` (aggregation
 * correctness). Throws an {@link Error} naming the first mismatching index (with
 * both values and the delta) when the arrays differ in length or in any element;
 * this is what catches an aggregator that drops, double-counts, or mis-sums a
 * subtree.
 */
export function assertResultsMatch(actual: number[], expected: number[], eps = 1e-9): void {
  if (actual.length !== expected.length) {
    throw new Error(
      `assertResultsMatch: length mismatch — actual has ${actual.length} elements, ` +
        `expected has ${expected.length}`
    );
  }
  for (let i = 0; i < actual.length; i++) {
    const delta = Math.abs(actual[i] - expected[i]);
    if (!(delta <= eps)) {
      throw new Error(
        `assertResultsMatch: mismatch at index ${i} — actual ${actual[i]}, ` +
          `expected ${expected[i]} (delta ${delta} > eps ${eps})`
      );
    }
  }
}
