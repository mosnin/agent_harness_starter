/**
 * The cost meter — real token accounting read off REAL provider responses,
 * aggregated in a way that refuses to hide what it does not know.
 *
 * ## The two lies this module is built to make impossible
 *
 * **Lie 1: "the response had no usage block, so 0 tokens."** Every provider
 * dialect this repo speaks (`../models/client.ts`'s OpenAI `usage` and
 * Anthropic `usage`) *may* omit usage — on an error-shaped 200, a proxy that
 * strips fields, a local server that never implements it. The pre-existing
 * client coalesced those to `0`, which is indistinguishable from a call that
 * genuinely consumed nothing. Here, an absent usage block produces
 * `tokensIn: null` and lands in {@link CostReport.usageMissingCalls}: the
 * call is COUNTED, its tokens are not, and the report stops calling itself
 * complete.
 *
 * **Lie 2: "no published price, so $0."** See `./prices.ts`. An unpriced call
 * is counted in {@link CostReport.unpricedCalls}, its model id is named in
 * {@link CostReport.unpricedModels}, and its spend is excluded from
 * {@link CostReport.usd} rather than folded in as zero. Because
 * {@link CostReport.complete} is false whenever either kind of gap exists,
 * every renderer can tell the difference between "$0.0134 is the bill" and
 * "$0.0134 is *part* of the bill".
 *
 * ## What "measured" means here
 *
 * A figure is measured iff it was read off a real provider response or a real
 * clock in this process:
 *
 *   - tokens: the provider's own `usage` counts. Never an estimate, never a
 *     tokenizer approximation, never `text.length / 4`.
 *   - dollars: those measured tokens multiplied by a published list price.
 *     The MULTIPLICATION is exact; the PRICE is a transcription (see
 *     `./prices.ts`), which is why {@link formatCostReport} prints the price
 *     table caveat alongside the dollar figure rather than presenting it as a
 *     receipt.
 *   - latency: `now()` sampled either side of the round trip, injected by the
 *     caller. Nothing in this module reads a clock on its own.
 *
 * Nothing else is emitted. There is no modeled lane in this file: if a run
 * produced no measured calls, the report says zero calls and
 * {@link formatCostReport} says so, rather than substituting a plausible
 * figure.
 *
 * @module hades/cost/meter
 */

import { MODEL_PRICES, PRICE_TABLE_CAVEAT, priceCall, type ModelPrice } from "./prices";

// ---------------------------------------------------------------------------
// One measured call
// ---------------------------------------------------------------------------

/**
 * One model round trip, as actually observed. Every field is something that
 * was read off the wire or off a clock — there is no field here a caller is
 * expected to estimate.
 */
export interface MeteredCall {
  /** Model id REQUESTED. Pricing keys on this (it is what the caller chose). */
  model: string;
  /**
   * Model id the provider REPORTED serving, when the response carried one.
   * Recorded separately because a mismatch means the dollar figure was priced
   * against an id the provider did not confirm — surfaced as a caveat rather
   * than quietly re-keyed (silently re-pricing on a response field would let
   * a provider move the bill).
   */
  servedModel?: string;
  /** Logical provider name (never a key, never an endpoint with credentials). */
  provider: string;
  /**
   * Prompt tokens AS REPORTED BY THE PROVIDER, or `null` when the response
   * carried no usage block. `null`, never 0 — see the module header.
   */
  tokensIn: number | null;
  /** Completion tokens as reported by the provider, or `null` when absent. */
  tokensOut: number | null;
  /** Measured wall clock for this one round trip, in ms. */
  latencyMs: number;
  /** Epoch ms when the call completed (from the caller's injected clock). */
  at: number;
}

// ---------------------------------------------------------------------------
// The aggregate
// ---------------------------------------------------------------------------

/** Per-model rollup inside a {@link CostReport}. */
export interface ModelCostBreakdown {
  model: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  /** Summed spend, or `null` when this model has no published price. */
  usd: number | null;
  /** Calls on this model whose response carried no usage block. */
  usageMissingCalls: number;
}

/**
 * What a set of measured calls adds up to — and, explicitly, what it does not.
 *
 * Read {@link complete} FIRST. When it is `false`, {@link usd} is a LOWER
 * BOUND on spend and {@link tokensIn}/{@link tokensOut} are a lower bound on
 * usage, because some calls contributed nothing measurable.
 */
export interface CostReport {
  /** Every call handed to the meter. */
  calls: number;
  /** Calls whose response carried a real usage block. */
  meteredCalls: number;
  /** Calls whose response carried NO usage block — tokens unknown, not zero. */
  usageMissingCalls: number;
  /** Sum of reported prompt tokens over metered calls only. */
  tokensIn: number;
  /** Sum of reported completion tokens over metered calls only. */
  tokensOut: number;
  /** Sum of USD over calls that were BOTH metered AND priced. */
  usd: number;
  /** Metered calls whose model has no published price — excluded from `usd`. */
  unpricedCalls: number;
  /** Distinct model ids behind `unpricedCalls`, sorted, for an honest message. */
  unpricedModels: string[];
  /** Distinct `requested -> served` pairs where the provider reported a different id. */
  modelMismatches: string[];
  /** Summed measured round-trip time. Not wall clock — calls may overlap. */
  modelLatencyMs: number;
  /** Longest single measured round trip, in ms (0 with no calls). */
  slowestCallMs: number;
  /** Per-model rollup, sorted by model id. */
  byModel: ModelCostBreakdown[];
  /**
   * `true` iff EVERY call was metered and priced — i.e. `usd` is the whole
   * bill, not part of it. A report with zero calls is complete but empty;
   * renderers must check `calls > 0` before claiming a run cost anything.
   */
  complete: boolean;
}

/** An empty report — the honest state of a run that made no model calls. */
export function emptyCostReport(): CostReport {
  return {
    calls: 0,
    meteredCalls: 0,
    usageMissingCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    usd: 0,
    unpricedCalls: 0,
    unpricedModels: [],
    modelMismatches: [],
    modelLatencyMs: 0,
    slowestCallMs: 0,
    byModel: [],
    complete: true,
  };
}

// ---------------------------------------------------------------------------
// CostMeter
// ---------------------------------------------------------------------------

/**
 * Accumulates {@link MeteredCall}s and rolls them into a {@link CostReport}.
 *
 * Deliberately dumb: it holds observations and adds them up. It never invents
 * a call, never fills in a missing token count, and never reads a clock — the
 * caller supplies `latencyMs` and `at` from whatever clock it already
 * injected, so a test can drive the whole thing deterministically.
 *
 * The price table is fixed at construction so a report cannot be re-priced
 * after the fact by a caller that lost track of which table produced it.
 */
export class CostMeter {
  private readonly recorded: MeteredCall[] = [];
  private readonly table: readonly ModelPrice[];

  constructor(opts: { prices?: readonly ModelPrice[] } = {}) {
    this.table = opts.prices ?? MODEL_PRICES;
  }

  /** Record one observed call. Returns the meter for chaining. */
  record(call: MeteredCall): this {
    this.recorded.push(call);
    return this;
  }

  /** Defensive copy of every recorded call, in observation order. */
  calls(): MeteredCall[] {
    return this.recorded.map((c) => ({ ...c }));
  }

  /** Number of calls recorded so far. */
  get size(): number {
    return this.recorded.length;
  }

  /** Roll the recorded calls up. Pure with respect to the meter's state. */
  report(): CostReport {
    return summarizeCalls(this.recorded, this.table);
  }
}

/**
 * Aggregate a list of measured calls. Exported separately from
 * {@link CostMeter} so a persisted run's calls (read back out of the journal)
 * can be re-summarized by exactly the same code that summarized them live —
 * a stored total is never trusted over a recomputation of the stored calls.
 */
export function summarizeCalls(
  calls: readonly MeteredCall[],
  table: readonly ModelPrice[] = MODEL_PRICES,
): CostReport {
  const report = emptyCostReport();
  const perModel = new Map<string, ModelCostBreakdown>();
  const unpriced = new Set<string>();
  const mismatches = new Set<string>();

  for (const call of calls) {
    report.calls += 1;
    report.modelLatencyMs += call.latencyMs;
    if (call.latencyMs > report.slowestCallMs) report.slowestCallMs = call.latencyMs;
    if (call.servedModel && call.servedModel !== call.model) {
      mismatches.add(`${call.model} -> ${call.servedModel}`);
    }

    let bucket = perModel.get(call.model);
    if (!bucket) {
      bucket = { model: call.model, calls: 0, tokensIn: 0, tokensOut: 0, usd: 0, usageMissingCalls: 0 };
      perModel.set(call.model, bucket);
    }
    bucket.calls += 1;

    // Usage present iff BOTH counts were reported AND both are usable numbers.
    //
    // A half-reported usage block is treated as absent: adding a real prompt
    // count to an assumed-0 completion count is the same understatement, one
    // field smaller. A NEGATIVE count is treated as absent for the same reason,
    // one step further — a provider reporting `prompt_tokens: -1000000` has not
    // measured anything, and folding it into the sum would silently offset real
    // tokens from other calls in the same run. `priceCall` already clamps
    // negatives to 0 before pricing, so leaving them unclamped here made the
    // two halves of the same report disagree about what a negative count means:
    // dollars stayed sane while the token total went nonsense-shaped. Now
    // neither number is derived from it and the call is COUNTED as one whose
    // usage is unknown, which is exactly what it is.
    const metered =
      call.tokensIn !== null &&
      call.tokensOut !== null &&
      Number.isFinite(call.tokensIn) &&
      Number.isFinite(call.tokensOut) &&
      call.tokensIn >= 0 &&
      call.tokensOut >= 0;
    if (!metered) {
      report.usageMissingCalls += 1;
      bucket.usageMissingCalls += 1;
      continue;
    }

    const tokensIn = call.tokensIn as number;
    const tokensOut = call.tokensOut as number;
    report.meteredCalls += 1;
    report.tokensIn += tokensIn;
    report.tokensOut += tokensOut;
    bucket.tokensIn += tokensIn;
    bucket.tokensOut += tokensOut;

    const priced = priceCall(call.model, tokensIn, tokensOut, table);
    if (priced.priced) {
      report.usd += priced.usd;
      // `null` is sticky: once a model is known unpriced, later priced calls
      // on the same id cannot resurrect a partial total for it.
      if (bucket.usd !== null) bucket.usd += priced.usd;
    } else {
      report.unpricedCalls += 1;
      unpriced.add(call.model);
      bucket.usd = null;
    }
  }

  report.unpricedModels = [...unpriced].sort();
  report.modelMismatches = [...mismatches].sort();
  report.byModel = [...perModel.values()].sort((a, b) => a.model.localeCompare(b.model));
  report.complete = report.usageMissingCalls === 0 && report.unpricedCalls === 0;
  return report;
}

// ---------------------------------------------------------------------------
// Rendering — every figure carries its provenance label
// ---------------------------------------------------------------------------

/**
 * Format USD without rounding a real charge away.
 *
 * A fixed 2- or 4-decimal format renders a genuine $0.0000135 call as
 * "$0.00" — a fabricated zero produced by the RENDERER rather than the
 * accounting, which is the same lie one layer up. So sub-cent amounts are
 * printed to 4 significant figures instead: small, real, and visibly nonzero.
 */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return String(usd);
  if (usd === 0) return "$0.00";
  if (Math.abs(usd) >= 0.01) return `$${usd.toFixed(4)}`;
  return `$${Number(usd.toPrecision(4))}`;
}

/** Format a duration in ms as a compact, honest string. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return String(ms);
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * The measured token counts, or an explicit UNKNOWN — **with its provenance
 * label already attached**.
 *
 * The label belongs to the value, not to the caller: `(measured)` on a figure
 * that is really UNKNOWN would be worse than no label at all, so these two
 * functions are the only place a cost figure gets rendered, and they decide
 * the label from the report. `0 / 0` is printed only when a call really did
 * report zero tokens; when no call reported usage the answer is UNKNOWN,
 * because "0 in / 0 out" for a call that definitely consumed tokens is the
 * renderer telling exactly the lie the accounting refused to.
 */
export function describeTokens(report: CostReport): string {
  if (report.calls > 0 && report.meteredCalls === 0) {
    return `UNKNOWN (no call reported usage; ${report.calls} call(s) made)`;
  }
  return `${report.tokensIn} / ${report.tokensOut} ${report.complete ? "(measured)" : "(measured, lower bound)"}`;
}

/**
 * The measured spend, or an explicit UNKNOWN / partial — with its label, per
 * the rule in {@link describeTokens}.
 *
 * `$0.00` is reserved for a measurement that really was zero. Anything with
 * an unknown component says so IN THE STRING, so the figure cannot be quoted
 * out of context and read as a complete bill.
 */
export function describeSpend(report: CostReport): string {
  if (report.calls > 0 && report.meteredCalls === 0) {
    return "UNKNOWN — no call reported usage, so nothing can be priced";
  }
  if (report.unpricedCalls > 0) {
    const models = report.unpricedModels.join(", ");
    return report.usd > 0
      ? `${formatUsd(report.usd)} (measured) + UNKNOWN for ${report.unpricedCalls} call(s) on ` +
          `unpriced model(s): ${models}`
      : `UNKNOWN — ${report.unpricedCalls} call(s) on unpriced model(s): ${models}`;
  }
  return `${formatUsd(report.usd)} ${report.complete ? "(measured)" : "(measured, lower bound)"}`;
}

/** Per-model tokens, with the same UNKNOWN rule as {@link describeTokens}. */
export function describeModelTokens(m: ModelCostBreakdown): string {
  if (m.calls > 0 && m.calls === m.usageMissingCalls) return "UNKNOWN in/out";
  return `${m.tokensIn} in / ${m.tokensOut} out`;
}

/** Per-model spend, with the same UNKNOWN rules as {@link describeSpend}. */
export function describeModelSpend(m: ModelCostBreakdown): string {
  if (m.usd === null) return "UNKNOWN (unpriced model)";
  if (m.calls > 0 && m.calls === m.usageMissingCalls) return "UNKNOWN (no usage reported)";
  return formatUsd(m.usd);
}

/**
 * Render a {@link CostReport} as display lines.
 *
 * The labelling contract, matching the `(modeled)` convention already used by
 * `../bench/showdown.ts` and its CLI: every figure here is suffixed
 * `(measured)` because every figure here came off a real response or a real
 * clock. Where a figure is INCOMPLETE, the label says so — `(measured, lower
 * bound)` — and a following line names exactly which calls are missing and
 * why. A caller must never mix these lines with modeled figures under one
 * heading without labelling each.
 *
 * `wallClockMs`, when supplied, is the run's real end-to-end duration; it is
 * reported alongside summed model latency precisely because the two differ
 * when calls overlap, and quoting only one of them is how a parallel system
 * flatters itself.
 */
export function formatCostReport(
  report: CostReport,
  opts: { wallClockMs?: number; indent?: string } = {},
): string[] {
  const pad = opts.indent ?? "  ";
  const lines: string[] = [];

  if (report.calls === 0) {
    lines.push(`${pad}model calls        0 (measured) — nothing was billed, and nothing is estimated here`);
    if (opts.wallClockMs !== undefined) {
      lines.push(`${pad}wall clock         ${formatMs(opts.wallClockMs)} (measured)`);
    }
    return lines;
  }

  lines.push(
    `${pad}model calls        ${report.calls} (measured)` +
      (report.usageMissingCalls > 0
        ? ` — ${report.meteredCalls} reported usage, ${report.usageMissingCalls} did NOT`
        : ""),
  );
  lines.push(`${pad}tokens in/out      ${describeTokens(report)}`);
  lines.push(`${pad}spend              ${describeSpend(report)}`);
  lines.push(`${pad}                   ${PRICE_TABLE_CAVEAT}`);

  if (opts.wallClockMs !== undefined) {
    lines.push(`${pad}wall clock         ${formatMs(opts.wallClockMs)} (measured, end to end)`);
  }
  lines.push(
    `${pad}model latency      ${formatMs(report.modelLatencyMs)} summed, ` +
      `${formatMs(report.slowestCallMs)} slowest (measured)`,
  );

  if (report.usageMissingCalls > 0) {
    lines.push(
      `${pad}! ${report.usageMissingCalls} call(s) returned no usage block — their tokens and spend are ` +
        `UNKNOWN and are excluded above, not counted as zero`,
    );
  }
  if (report.modelMismatches.length > 0) {
    lines.push(
      `${pad}! provider served a different model id than requested (${report.modelMismatches.join(", ")}); ` +
        `spend above is priced against the REQUESTED id`,
    );
  }
  return lines;
}

/**
 * The single-line form, for a run summary that has room for one line.
 * Same rules: never claims completeness it does not have.
 */
export function formatCostLine(report: CostReport, opts: { wallClockMs?: number } = {}): string {
  const wall = opts.wallClockMs !== undefined ? ` wall=${formatMs(opts.wallClockMs)}` : "";
  if (report.calls === 0) {
    return `cost: 0 model calls — nothing measured${wall} (measured)`;
  }
  // The unreported-usage caveat has to ride on THIS line too. The multi-line
  // renderer gets a whole `!` row for it; a one-liner that dropped it could
  // be quoted as a complete figure when it is not.
  const unreported =
    report.usageMissingCalls > 0 && report.meteredCalls > 0
      ? ` [${report.usageMissingCalls} call(s) reported no usage and are excluded]`
      : "";
  return (
    `cost: ${describeSpend(report)} for ${describeTokens(report)} tokens over ` +
    `${report.calls} call(s)${wall}${unreported}`
  );
}
