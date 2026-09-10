/* ------------------------------------------------------------------ *
 * route-bench.ts — the phase checkpoint: does the router actually beat
 * every fixed single-provider baseline?
 *
 * Drives a mixed eval batch through an injected {@link RouterLike} AND
 * through each {@link FixedBaseline} runner, over the IDENTICAL task
 * suite, using ONLY the REAL, shipped `../bench/vtph` harness
 * (`runVtph` via `compareVtph` — this module computes NO V-TPH$
 * arithmetic of its own: no hand-rolled `vtph`/`vtphPerDollar`, no
 * hand-rolled hours-from-wall-clock division). Every number in the
 * returned `routerReport`/`baselineReports` traces straight back to a
 * `VtphReport` `compareVtph` produced this run.
 *
 * Alongside the V-TPH$ comparison, every routing decision the router
 * makes is appended to a {@link RoutingLedger} (`./ledger` — the REAL
 * hash-chained ledger, never reimplemented here), producing
 * tamper-evident per-arm attribution and a chain-verification result
 * that ship in the same {@link RouteBenchResult}.
 *
 * `RouterLike` does not expose a `candidates`/`reason`/`estimatedUsd`
 * the way a full `RoutingDecision` requires — those three fields are
 * synthesized HONESTLY from what IS available, never fabricated:
 *   - `candidates` = the deduplicated, sorted set of `armId`s across
 *     `opts.baselines` — the known fixed-provider arm universe this
 *     bench run actually offered as a comparison set.
 *   - `reason` = the router's own `AgentRunResult.provenance` trail
 *     joined with `" | "` (or an explicit "(no rationale...)" string
 *     when the router supplied none) — a real signal read off the
 *     router's own output, never invented text.
 *   - `estimatedUsd` mirrors `actualUsd`: `RouterLike` is an opaque
 *     interface with no pre-execution cost estimator, so there is no
 *     honest DIFFERENT number to report as "estimated" here. This is
 *     documented, not silently fabricated.
 *
 * PROVENANCE (honesty-critical, hard rule): `provenance` is a REQUIRED
 * caller-supplied field, and the FIRST line of the returned `markdown`
 * states it verbatim, so a `"model"` (simulated) run can never be
 * misread as `"measured-live"`/`"measured-local"`.
 *
 * Adversarial robustness (a router that throws; returns an `armId`
 * never offered as a candidate; returns `claimedVerified: true` on
 * garbage; non-finite numerics; duplicate task ids; an empty task
 * list; zero/one baselines; baselines that all score 0) never crashes
 * this module and never produces a silently-flattering number — each
 * case either yields a correctly-bucketed real result (a garbage
 * `claimedVerified: true` output is graded for real by
 * `task.grade` inside `runVtph` and lands in `silentWrong`, never
 * `verifiedCorrect`) or is recorded in `anomalies`.
 * ------------------------------------------------------------------ */

// `runVtph` is imported per the locked contract (this module must route
// every throughput number through the REAL harness, never reimplement
// it); the batches below are actually driven through `compareVtph`,
// which calls `runVtph` once per runner internally.
import { runVtph, compareVtph } from "../bench/vtph";
import type { AgentRunner, AgentRunResult, EvalTask, VtphReport } from "../bench/vtph";
import { EVAL_TASKS, tasksByCategory } from "../bench/eval-suite";
import { RoutingLedger } from "./ledger";
import type { ArmAttribution, ChainCheck, RoutingDecision } from "./ledger";

// ===========================================================================
// Public shapes (locked)
// ===========================================================================

export interface RoutedRun extends AgentRunResult {
  armId: string;
  fannedOut: readonly string[];
  escalations: number;
  pCorrect: number;
}

export interface RouterLike {
  route(task: EvalTask): Promise<RoutedRun>;
}

export type BenchProvenance = "measured-live" | "measured-local" | "model";

export interface FixedBaseline {
  label: string;
  armId: string;
  runner: AgentRunner;
}

export interface RouteBenchOptions {
  router: RouterLike;
  baselines: readonly FixedBaseline[];
  tasks: readonly EvalTask[];
  provenance: BenchProvenance;
  ledger?: RoutingLedger;
  concurrency?: number;
  now?: () => number;
}

export interface RouteBenchResult {
  provenance: BenchProvenance;
  routerReport: VtphReport;
  baselineReports: readonly VtphReport[];
  bestBaseline: VtphReport | null;
  beatsAllBaselines: boolean;
  marginVsBestBaseline: number;
  armAttribution: readonly ArmAttribution[];
  ledgerChain: ChainCheck;
  anomalies: readonly string[];
  markdown: string;
}

// ===========================================================================
// Small, pure helpers
// ===========================================================================

const ROUTER_ERROR_ARM = "<router-error>";
const ROUTER_LABEL = "router";

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Coerce to a finite number, falling back when not finite. Never NaN/Infinity out. */
function cleanFinite(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function cleanStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// ===========================================================================
// mixedEvalBatch — drawn from the REAL EVAL_TASKS, never synthesized
// ===========================================================================

/**
 * A deterministic, mixed batch of REAL tasks drawn from `EVAL_TASKS`
 * (via `tasksByCategory`) across multiple real categories. For each
 * selected category this includes, when available:
 *   - a non-decomposable ("easy", single-shot, cheapest-that-verifies)
 *     task, exercising the direct-route path, and
 *   - a decomposable ("hard", fan-out) task, exercising the fan-out /
 *     escalation path,
 * plus a second non-decomposable task when the category has one, for
 * broader per-category coverage.
 *
 * Default `categories` is every distinct category present in
 * `EVAL_TASKS`, in sorted order — so the default batch always spans
 * every real task family. Never fabricates a task: every element of
 * the returned array is a direct reference to an object already
 * present in `EVAL_TASKS`. Deterministic: no randomness, no clock.
 */
export function mixedEvalBatch(opts: { categories?: readonly string[]; limit?: number } = {}): EvalTask[] {
  const categories =
    opts.categories && opts.categories.length > 0
      ? Array.from(new Set(opts.categories))
      : Array.from(new Set(EVAL_TASKS.map((t) => t.category))).sort((a, b) => a.localeCompare(b));

  const picked: EvalTask[] = [];
  for (const category of categories) {
    const inCategory = tasksByCategory(category);
    const easy = inCategory.filter((t) => !t.decomposable);
    const hard = inCategory.filter((t) => t.decomposable);
    if (easy.length > 0) picked.push(easy[0]!);
    if (hard.length > 0) picked.push(hard[0]!);
    if (easy.length > 1) picked.push(easy[1]!);
  }

  if (opts.limit != null && Number.isFinite(opts.limit) && opts.limit >= 0) {
    return picked.slice(0, Math.floor(opts.limit));
  }
  return picked;
}

// ===========================================================================
// runRouteBench
// ===========================================================================

/**
 * Run `opts.tasks` through the injected `opts.router` AND through every
 * `opts.baselines[*].runner`, over the IDENTICAL task suite, via a
 * SINGLE `compareVtph` call (so the returned `markdown`'s comparison
 * table is exactly `compareVtph`'s own rendered table — never a
 * re-derived one). Every routing decision the router makes is appended
 * to `opts.ledger` (or a fresh, call-scoped `RoutingLedger` when none
 * is supplied).
 */
export async function runRouteBench(opts: RouteBenchOptions): Promise<RouteBenchResult> {
  if (typeof opts?.router?.route !== "function") {
    throw new TypeError("runRouteBench: opts.router must implement route(task)");
  }

  const tasks = [...opts.tasks];
  const baselines = [...opts.baselines];
  const ledger = opts.ledger ?? new RoutingLedger();
  const anomalies: string[] = [];

  if (tasks.length === 0) {
    anomalies.push("empty task list: nothing was benchmarked");
  }

  const seenIds = new Set<string>();
  const dupIds = new Set<string>();
  for (const t of tasks) {
    if (seenIds.has(t.id)) dupIds.add(t.id);
    seenIds.add(t.id);
  }
  if (dupIds.size > 0) {
    anomalies.push(`duplicate task id(s) in batch: ${[...dupIds].sort().join(", ")}`);
  }

  if (baselines.length === 0) {
    anomalies.push("no baselines supplied: beatsAllBaselines cannot be meaningfully asserted");
  }

  // The known fixed-provider arm universe this bench run offered as a
  // comparison set. RouterLike does not expose its own candidate list,
  // so this is the honest substitute (see file header).
  const candidates = Array.from(new Set(baselines.map((b) => b.armId))).sort((a, b) => a.localeCompare(b));
  const candidateSet = new Set(candidates);

  const clock = opts.now ?? (() => Date.now());

  const wrappedRouterRunner: AgentRunner = async (task: EvalTask): Promise<AgentRunResult> => {
    const startedAt = clock();
    let routed: RoutedRun;
    try {
      routed = await opts.router.route(task);
    } catch (err) {
      const finishedAt = clock();
      const decision: RoutingDecision = {
        taskId: task.id,
        category: task.category,
        armId: ROUTER_ERROR_ARM,
        reason: `router threw: ${errMessage(err)}`,
        candidates,
        fannedOut: [],
        escalations: 0,
        estimatedUsd: 0,
        actualUsd: 0,
        wallMs: Math.max(0, finishedAt - startedAt),
        claimedVerified: false,
        graded: null,
        pCorrect: 0,
        certificateId: null,
        at: startedAt,
      };
      safeAppend(ledger, decision, anomalies, task.id);
      anomalies.push(`router threw for task "${task.id}": ${errMessage(err)}`);
      throw err; // runVtph's own guard counts this task as declined
    }

    const armId = typeof routed.armId === "string" && routed.armId.length > 0 ? routed.armId : ROUTER_ERROR_ARM;
    if (armId === ROUTER_ERROR_ARM && armId !== routed.armId) {
      anomalies.push(`router returned a non-string/empty armId for task "${task.id}"`);
    } else if (candidateSet.size > 0 && !candidateSet.has(armId)) {
      anomalies.push(
        `router returned armId "${armId}" for task "${task.id}" which was never offered as a candidate (${candidates.join(", ")})`,
      );
    }

    const usdRaw = routed.usd;
    if (typeof usdRaw !== "number" || !Number.isFinite(usdRaw)) {
      anomalies.push(`router returned non-finite usd for task "${task.id}"; coerced to 0`);
    }
    const usd = cleanFinite(usdRaw, 0);
    const tokensIn = cleanFinite(routed.tokensIn, 0);
    const tokensOut = cleanFinite(routed.tokensOut, 0);
    const escalations = cleanFinite(routed.escalations, 0);
    const pCorrect = cleanFinite(routed.pCorrect, 0);
    const fannedOut = cleanStringArray(routed.fannedOut);
    const provenanceTrail = cleanStringArray(routed.provenance);
    const output = typeof routed.output === "string" ? routed.output : String(routed.output ?? "");
    const claimedVerified = routed.claimedVerified === true;

    const finishedAt = clock();
    const decision: RoutingDecision = {
      taskId: task.id,
      category: task.category,
      armId,
      reason: provenanceTrail.length > 0 ? provenanceTrail.join(" | ") : "(no rationale provided by router)",
      candidates,
      fannedOut,
      escalations,
      estimatedUsd: usd,
      actualUsd: usd,
      wallMs: Math.max(0, finishedAt - startedAt),
      claimedVerified,
      // The independent ground-truth check is `task.grade`, the SAME
      // pure function `runVtph`'s batch aggregation calls -- read
      // directly here (never re-implemented) purely to attribute this
      // ONE decision in the ledger; the aggregate V-TPH$ numbers
      // themselves still come exclusively from `compareVtph` below.
      graded: task.grade(output),
      pCorrect,
      certificateId: null,
      at: startedAt,
    };
    safeAppend(ledger, decision, anomalies, task.id);

    return { output, claimedVerified, tokensIn, tokensOut, usd, provenance: provenanceTrail };
  };

  const runners = [
    { label: ROUTER_LABEL, runner: wrappedRouterRunner },
    ...baselines.map((b) => ({ label: b.label, runner: b.runner })),
  ];

  const comparison = await compareVtph(runners, tasks, { concurrency: opts.concurrency, now: opts.now });
  const routerReport = comparison.reports[0]!;
  const baselineReports = comparison.reports.slice(1);

  for (const r of baselineReports) {
    if (r.vtphPerDollar === 0) {
      anomalies.push(`baseline "${r.label}" scored 0 V-TPH$/$ (verifiedCorrect=${r.verifiedCorrect})`);
    }
  }

  let bestBaseline: VtphReport | null = null;
  for (const r of baselineReports) {
    if (bestBaseline === null || r.vtphPerDollar > bestBaseline.vtphPerDollar) bestBaseline = r;
  }

  const beatsAllBaselines =
    baselineReports.length > 0 && baselineReports.every((r) => routerReport.vtphPerDollar > r.vtphPerDollar);
  const marginVsBestBaseline = bestBaseline ? routerReport.vtphPerDollar - bestBaseline.vtphPerDollar : 0;

  const armAttribution = ledger.attribution();
  const ledgerChain = ledger.verifyChain();

  const sortedAnomalies = Array.from(new Set(anomalies)).sort((a, b) => a.localeCompare(b));

  const markdown = renderMarkdown({
    provenance: opts.provenance,
    comparisonTable: comparison.markdownTable,
    routerReport,
    bestBaseline,
    beatsAllBaselines,
    marginVsBestBaseline,
    armAttribution,
    ledgerChain,
    anomalies: sortedAnomalies,
  });

  return {
    provenance: opts.provenance,
    routerReport,
    baselineReports,
    bestBaseline,
    beatsAllBaselines,
    marginVsBestBaseline,
    armAttribution,
    ledgerChain,
    anomalies: sortedAnomalies,
    markdown,
  };
}

function safeAppend(ledger: RoutingLedger, decision: RoutingDecision, anomalies: string[], taskId: string): void {
  try {
    ledger.append(decision);
  } catch (err) {
    anomalies.push(`failed to append ledger entry for task "${taskId}": ${errMessage(err)}`);
  }
}

// ===========================================================================
// Markdown report
// ===========================================================================

function provenanceBanner(p: BenchProvenance): string {
  switch (p) {
    case "measured-live":
      return "> provenance: measured-live (real live provider calls — actual dollars spent, actual wall-clock measured this run)";
    case "measured-local":
      return "> provenance: measured-local (real local model execution measured this run — not a paid live provider)";
    case "model":
      return "> provenance: model (deterministic simulated runners — not a live provider run)";
    default:
      return `> provenance: ${p as string}`;
  }
}

/**
 * Escape a value that is about to be laid into a markdown TABLE CELL. An arm
 * id is caller-supplied (it comes from whatever the injected router returned),
 * so an unescaped `|` would split one row into several and let a hostile or
 * merely sloppy arm id forge extra columns — including a fake "Verified" count
 * — in a report a human reads as authoritative. Newlines are stripped for the
 * same reason: a cell containing one would end the row entirely.
 */
function cell(value: string): string {
  return String(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

function renderAttributionTable(attribution: readonly ArmAttribution[]): string {
  const header =
    "| Arm | Tasks | Verified✓ | Silent✗ | Declined | $ | Wall(ms) | V-TPH | V-TPH$/$ | EscalatedInto |\n" +
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";
  if (attribution.length === 0) {
    return header + "\n| (none) | 0 | 0 | 0 | 0 | 0.0000 | 0 | 0.00 | 0.00 | 0 |";
  }
  const body = attribution
    .map(
      (a) =>
        `| ${cell(a.armId)} | ${a.tasks} | ${a.verifiedCorrect} | ${a.silentWrong} | ${a.declined} | ` +
        `${a.usd.toFixed(4)} | ${a.wallMs.toFixed(0)} | ${a.vtph.toFixed(2)} | ${a.vtphPerDollar.toFixed(2)} | ${a.escalatedInto} |`,
    )
    .join("\n");
  return `${header}\n${body}`;
}

function renderMarkdown(params: {
  provenance: BenchProvenance;
  comparisonTable: string;
  routerReport: VtphReport;
  bestBaseline: VtphReport | null;
  beatsAllBaselines: boolean;
  marginVsBestBaseline: number;
  armAttribution: readonly ArmAttribution[];
  ledgerChain: ChainCheck;
  anomalies: readonly string[];
}): string {
  const lines: string[] = [];

  lines.push(provenanceBanner(params.provenance));
  lines.push("");
  lines.push("# Route Bench Report");
  lines.push("");

  lines.push("## V-TPH$ comparison (router vs fixed-provider baselines)");
  lines.push("");
  lines.push(params.comparisonTable);
  lines.push("");

  lines.push("## Verdict");
  lines.push("");
  lines.push(`- router V-TPH$/$: ${params.routerReport.vtphPerDollar.toFixed(4)}`);
  lines.push(
    params.bestBaseline
      ? `- best baseline: "${cell(params.bestBaseline.label)}" at ${params.bestBaseline.vtphPerDollar.toFixed(4)} V-TPH$/$`
      : "- best baseline: none (no baselines supplied)",
  );
  lines.push(`- margin vs best baseline: ${params.marginVsBestBaseline.toFixed(4)}`);
  lines.push(`- beats ALL baselines (strict >, ties do not count): ${params.beatsAllBaselines ? "YES" : "NO"}`);
  lines.push("");

  lines.push("## Per-arm attribution");
  lines.push("");
  lines.push(renderAttributionTable(params.armAttribution));
  lines.push("");

  lines.push("## Ledger chain verification");
  lines.push("");
  const cc = params.ledgerChain;
  lines.push(
    `- ${cc.ok ? "OK" : "BROKEN"}: ${cc.entries} entr${cc.entries === 1 ? "y" : "ies"}, code "${cc.code}"` +
      (cc.brokenAt != null ? `, broken at seq ${cc.brokenAt}` : ""),
  );
  lines.push("");

  lines.push("## Anomalies");
  lines.push("");
  if (params.anomalies.length === 0) {
    lines.push("- none");
  } else {
    // Anomaly text embeds caller-supplied arm ids and provider error
    // messages; a newline inside one would break out of its bullet and could
    // forge a new markdown section in a report a human reads as authoritative.
    for (const a of params.anomalies) lines.push(`- ${cell(a)}`);
  }

  return lines.join("\n");
}
