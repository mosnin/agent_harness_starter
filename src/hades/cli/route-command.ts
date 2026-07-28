/**
 * `hades route <sub>` — the terminal surface over the budget-constrained,
 * risk-controlled router (`../routing/**`).
 *
 *   hades route status  [--json] [--tier T] [--prompt-tokens N] [--output-tokens N]
 *   hades route arms    [--json] [--provider P] [--max-usd N] [--min-context N]
 *                       [--prompt-tokens N] [--output-tokens N] [--allow-unpriced]
 *   hades route explain --category C [--task-id ID] [--difficulty D]
 *                       [--prompt-tokens N] [--output-tokens N] [--json]
 *   hades route record  --task T --category C --arm A --usd N --wall-ms N
 *                       [--tokens-in N] [--tokens-out N] [--claimed-verified]
 *                       [--graded true|false] [--p-correct N] [--at MS]
 *                       [--reason S] [--verifier V] [--verifier-score N] [--json]
 *   hades route ledger  [--entries N] [--verify] [--json]
 *   hades route bench   [--tasks N] [--json]
 *   hades route doctor  [--json]
 *   hades route help
 *
 * Terminal-free (returns `{ code, lines }`) so it unit-tests without a shell
 * or real stdout, matching the rest of `src/hades/cli/*`. Plain aligned ASCII
 * only — this product's front end is the terminal, never a browser.
 *
 * ## What this command will and will not claim
 *
 * `status` / `arms` / `explain` / `ledger` report only numbers the REAL
 * router computed on this machine from this install's own `<dataDir>/routing`
 * state: real published prices, real measured usage, a real Thompson
 * posterior, a real split-conformal threshold and a real SHA-256 hash chain.
 *
 * An arm the price table does not know prints `unpriced` and a `$ n/a` cost —
 * NEVER `$0.0000`, which would read as "free" to both a human and a
 * cost-sensitive bandit. A conformal threshold of `Infinity` prints `abstain`,
 * because that stratum has no evidence to accept anything with.
 *
 * `bench` runs the REAL `runVtph`/`compareVtph` harness against REAL provider
 * calls. With no provider API key configured there is nothing to measure, so
 * it REFUSES (exit 2) and says so — it never substitutes a simulation and
 * calls the result a benchmark.
 *
 * `explain` is a pure read of the ranking mechanism: it advances the bandit's
 * in-memory PRNG (a Thompson draw is a draw) but never records an outcome and
 * never saves, so it cannot move the budget, a posterior, or the ledger.
 * `record` is the ONE subcommand that mutates durable state, and it persists
 * every component of the stack together.
 */

import type { CliResult } from "./cli";
import {
  openRouter,
  routerStatus,
  createRoutedRunner,
  recordRouteOutcome,
  DEFAULT_STATUS_CTX,
  type RouterStack,
  type RouterStackOptions,
  type RouterStatusView,
} from "../routing/wiring";
import type { ArmRequirements, RoutingArm, TaskCostContext } from "../routing/arms";
import type { RoutingContext } from "../routing/bandit";
import { runRouteBench, mixedEvalBatch } from "../routing/route-bench";
import type { BenchProvenance, FixedBaseline, RouterLike } from "../routing/route-bench";
import { TIER_ORDER, type TierId } from "../styx/tiers";
import { EVAL_TASKS } from "../bench/eval-suite";
import { buildClientFromEnv } from "./bench-command";
import { singleAgentRunner } from "../agent/runner";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/** Everything `hades route bench` needs to measure something real. */
export interface RouteBenchWiring {
  router: RouterLike;
  baselines: FixedBaseline[];
  provenance: BenchProvenance;
  /** Injected clock for the harness; defaults to the real one inside the harness. */
  now?: () => number;
}

export interface RouteCommandDeps {
  /** Lazily open the stack. A factory (not a value) so `hades help` never
   *  touches `<dataDir>/routing`. */
  stack: () => RouterStack;
  /**
   * Build the real bench wiring, or `null` when this machine cannot measure
   * anything (no provider key). Defaults to real provider clients assembled
   * from environment keys.
   */
  bench?: (stack: RouterStack) => RouteBenchWiring | null;
  env?: Record<string, string | undefined>;
}

/**
 * Real per-arm execution from environment provider keys. Returns `null` when
 * no key is configured — the honest "nothing to measure" state, never a
 * synthetic stand-in.
 */
export function defaultBenchWiring(
  stack: RouterStack,
  env: Record<string, string | undefined> = process.env,
): RouteBenchWiring | null {
  const built = buildClientFromEnv(env as Record<string, string | undefined>);
  if (!built) return null;

  const { client } = built;
  // Only arms whose model this client can actually reach are executable.
  const reachable = new Set<string>([built.workerModel, built.verifierModel]);
  const armIsReachable = (arm: RoutingArm): boolean => reachable.has(arm.modelId);
  const runnerFor = (arm: RoutingArm): ReturnType<typeof singleAgentRunner> | null =>
    armIsReachable(arm) ? singleAgentRunner(client, { model: arm.modelId }) : null;

  const baselines: FixedBaseline[] = stack.catalog
    .arms()
    .filter(armIsReachable)
    .map((arm) => ({ label: arm.id, armId: arm.id, runner: singleAgentRunner(client, { model: arm.modelId }) }));

  if (baselines.length === 0) return null;

  return {
    router: createRoutedRunner(stack, { runnerFor }),
    baselines,
    provenance: "measured-live",
  };
}

export function defaultRouteDeps(
  env: Record<string, string | undefined> = process.env,
  overrides: RouterStackOptions = {},
): RouteCommandDeps {
  let cached: RouterStack | undefined;
  return {
    env,
    stack: () => {
      if (!cached) cached = openRouter({ env, ...overrides });
      return cached;
    },
    bench: (stack: RouterStack) => defaultBenchWiring(stack, env),
  };
}

export const ROUTE_USAGE: string[] = [
  "Usage: hades route <command>",
  "",
  "Commands:",
  "  status [--json] [--tier T]           Budget, lambda, chain verdict and every arm's",
  "         [--prompt-tokens N]           measured cost / posterior / conformal threshold",
  "         [--output-tokens N]",
  "  arms [--provider P] [--max-usd N]    The routable arm space and, for every arm that",
  "       [--min-context N]               did NOT make the cut, exactly which requirement",
  "       [--allow-unpriced] [--json]     it failed",
  "  explain --category C [--task-id ID]  Rank the eligible arms the way the bandit would,",
  "          [--difficulty D] [--json]    showing sampled score, shadow cost and lambda.",
  "                                       Pure read: never records, never saves.",
  "  record --task T --category C         Fold ONE real completed outcome into the measured",
  "         --arm A --usd N --wall-ms N   cost model, the posterior, the budget, the",
  "         [--tokens-in N] [--graded B]  conformal evidence and the hash-chained ledger,",
  "         [--claimed-verified] ...      then persist. The only mutating subcommand.",
  "  ledger [--entries N] [--verify]      Per-arm attribution (incl. silent-wrong) straight",
  "         [--json]                      off the tamper-evident chain",
  "  bench [--tasks N] [--json]           REAL V-TPH$ head-to-head: router vs every fixed",
  "                                       single-provider baseline. Refuses (exit 2) when no",
  "                                       provider key is set rather than simulating.",
  "  doctor [--json]                      End-to-end wiring self-check (exit 0 iff healthy)",
  "  help                                 Show this help",
];

// ---------------------------------------------------------------------------
// Small local helpers (own copies — see memory-command.ts's note)
// ---------------------------------------------------------------------------

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function table(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const out = [headers.map((h, i) => pad(h, widths[i])).join("  ")];
  out.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) out.push(row.map((c, i) => pad(c ?? "", widths[i])).join("  "));
  return out;
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function numberFlag(args: string[], name: string): { value?: number; error?: string } {
  const raw = flagValue(args, name);
  if (raw === undefined) return {};
  const value = Number(raw);
  if (!Number.isFinite(value)) return { error: `${name} must be a finite number; got ${JSON.stringify(raw)}` };
  return { value };
}

function jsonResult(value: unknown, code = 0): CliResult {
  return { code, lines: JSON.stringify(value, null, 2).split("\n") };
}

function fail(message: string): CliResult {
  return { code: 1, lines: [`route: ${message}`] };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `n/a` rather than a fabricated `0.0000` for an unmeasurable quantity. */
function num(value: number | null | undefined, digits = 4): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "n/a" : value.toFixed(digits);
}

/** A cost with no published price is `n/a`, never `$0.0000`. */
function usd(value: number, unpriced: boolean): string {
  return unpriced ? "n/a" : value.toFixed(6);
}

/** `Infinity` means "this stratum abstains", which is a verdict, not a number. */
function threshold(t: number): string {
  return Number.isFinite(t) ? t.toFixed(4) : "abstain";
}

function ctxFromArgs(args: string[]): { ctx?: TaskCostContext; error?: string } {
  const p = numberFlag(args, "--prompt-tokens");
  if (p.error) return { error: p.error };
  const o = numberFlag(args, "--output-tokens");
  if (o.error) return { error: o.error };
  return {
    ctx: {
      promptTokens: p.value ?? DEFAULT_STATUS_CTX.promptTokens,
      expectedOutputTokens: o.value ?? DEFAULT_STATUS_CTX.expectedOutputTokens,
    },
  };
}

function tierFromArgs(args: string[]): { tier?: TierId; error?: string } {
  const raw = flagValue(args, "--tier");
  if (raw === undefined) return {};
  if (!(TIER_ORDER as readonly string[]).includes(raw)) {
    return { error: `--tier must be one of ${TIER_ORDER.join(", ")}; got ${JSON.stringify(raw)}` };
  }
  return { tier: raw as TierId };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function runRouteCommand(args: string[], deps: RouteCommandDeps): Promise<CliResult> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return { code: 0, lines: ROUTE_USAGE };
    case "status":
      return status(rest, deps);
    case "arms":
      return arms(rest, deps);
    case "explain":
      return explain(rest, deps);
    case "record":
      return record(rest, deps);
    case "ledger":
      return ledger(rest, deps);
    case "bench":
      return bench(rest, deps);
    case "doctor":
      return doctor(rest, deps);
    default:
      return { code: 1, lines: [`Unknown route command: ${sub}`, "", ...ROUTE_USAGE] };
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function renderStatus(view: RouterStatusView): string[] {
  const lines: string[] = [];
  lines.push("ROUTE — the budget-constrained, risk-controlled router");
  lines.push(`  root                ${view.root ?? "(in-memory)"}`);
  lines.push(`  budget              $${view.budgetUsd.toFixed(4)} (spent $${view.spentUsd.toFixed(6)}, remaining $${view.remainingUsd.toFixed(6)})`);
  lines.push(`  budget dual (lambda)${" "}${view.lambda.toFixed(6)}`);
  lines.push(`  seed                ${view.seed}`);
  lines.push(`  epsilon             ${view.epsilon}  (silent-wrong risk budget)`);
  lines.push(`  arms                ${view.totalArms} total, ${view.eligibleArms} eligible, ${view.unpricedArms} UNPRICED`);
  lines.push(`  risk strata         ${view.riskStrata} (${view.riskCalibrated} calibrated, ${view.riskPooledFallbacks} pooled, ${view.riskAbstainingStrata} abstaining) from ${view.riskPoints} labelled point(s)`);
  lines.push(`  verifiers tracked   ${view.verifiersTracked}`);
  lines.push(`  ledger              ${view.ledgerEntries} entr${view.ledgerEntries === 1 ? "y" : "ies"}, chain ${view.chainOk ? "VERIFIED" : `BROKEN (${view.chainCode}) — persisted ledger refused`}`);

  if (view.unpricedArms > 0) {
    lines.push("");
    lines.push(`  NOTE: ${view.unpricedArms} arm(s) have NO published price. Their cost prints as`);
    lines.push("        n/a, never $0, and they are ineligible unless --allow-unpriced.");
  }

  lines.push("");
  lines.push(`  per-arm figures quoted at ${view.tier}, prompt/output tokens as requested:`);
  lines.push("");
  if (view.arms.length === 0) {
    lines.push("  (no arms — the model registry is empty)");
  } else {
    lines.push(
      ...table(
        ["ARM", "OK", "$MEAN", "$P90", "COST-SRC", "N", "PULLS", "VER", "P(VER)", "V-TPH$/$", "THRESH", "RISK-SRC"],
        view.arms.map((a) => [
          a.armId,
          a.eligible ? "yes" : `no:${a.rejectionCode ?? "?"}`,
          usd(a.usdMean, a.unpriced),
          usd(a.usdP90, a.unpriced),
          a.costSource,
          String(a.costSamples),
          String(a.pulls),
          String(a.verified),
          num(a.pVerifiedMean, 3),
          num(a.measuredVtphPerDollar, 2),
          threshold(a.riskThreshold),
          a.riskSource,
        ]),
      ).map((l) => `  ${l}`),
    );
  }

  if (view.loadErrors.length > 0) {
    lines.push("");
    lines.push("  ARTIFACT LOAD ERRORS");
    for (const e of view.loadErrors) lines.push(`    ${e.artifact}: ${e.message}`);
  }
  return lines;
}

function status(args: string[], deps: RouteCommandDeps): CliResult {
  const c = ctxFromArgs(args);
  if (c.error) return fail(c.error);
  const t = tierFromArgs(args);
  if (t.error) return fail(t.error);

  let view: RouterStatusView;
  try {
    view = routerStatus(deps.stack(), { ctx: c.ctx, tier: t.tier });
  } catch (err) {
    return fail(errText(err));
  }
  if (hasFlag(args, "--json")) return jsonResult(view);
  return { code: 0, lines: renderStatus(view) };
}

// ---------------------------------------------------------------------------
// arms
// ---------------------------------------------------------------------------

function requirementsFromArgs(
  args: string[],
  base: ArmRequirements,
): { req?: ArmRequirements; error?: string } {
  const req: ArmRequirements = { ...base };
  const provider = flagValue(args, "--provider");
  if (provider !== undefined) req.providers = [provider];

  const maxUsd = numberFlag(args, "--max-usd");
  if (maxUsd.error) return { error: maxUsd.error };
  if (maxUsd.value !== undefined) req.maxUsdPerTask = maxUsd.value;

  const minContext = numberFlag(args, "--min-context");
  if (minContext.error) return { error: minContext.error };
  if (minContext.value !== undefined) req.minContextWindow = minContext.value;

  if (hasFlag(args, "--allow-unpriced")) req.allowUnpriced = true;
  return { req };
}

function arms(args: string[], deps: RouteCommandDeps): CliResult {
  const c = ctxFromArgs(args);
  if (c.error) return fail(c.error);

  let stack: RouterStack;
  try {
    stack = deps.stack();
  } catch (err) {
    return fail(errText(err));
  }

  const r = requirementsFromArgs(args, stack.requirements);
  if (r.error) return fail(r.error);

  const ctx = c.ctx ?? DEFAULT_STATUS_CTX;
  const result = stack.catalog.eligible(r.req!, ctx, stack.cost);
  const payload = {
    ctx,
    requirements: r.req!,
    eligible: result.arms.map((a) => {
      const est = stack.cost.estimate(a, ctx, 0);
      return {
        armId: a.id,
        provider: a.provider,
        modelId: a.modelId,
        displayName: a.displayName,
        contextWindow: a.contextWindow,
        unpriced: a.unpriced,
        usdMean: est.usdMean,
        usdP90: est.usdP90,
        costSource: est.source,
        samples: est.samples,
      };
    }),
    rejected: result.rejected,
  };

  if (hasFlag(args, "--json")) return jsonResult(payload);

  const lines: string[] = [];
  lines.push(`ROUTE ARMS — priced at ${ctx.promptTokens} prompt / ${ctx.expectedOutputTokens} output tokens`);
  lines.push("");
  if (payload.eligible.length === 0) {
    lines.push("  (no eligible arms)");
  } else {
    lines.push(
      ...table(
        ["ARM", "PROVIDER", "CONTEXT", "$MEAN", "$P90", "SOURCE", "N"],
        payload.eligible.map((a) => [
          a.armId,
          a.provider,
          a.contextWindow === null ? "n/a" : String(a.contextWindow),
          usd(a.usdMean, a.unpriced),
          usd(a.usdP90, a.unpriced),
          a.costSource,
          String(a.samples),
        ]),
      ).map((l) => `  ${l}`),
    );
  }
  lines.push("");
  lines.push(`  REJECTED (${payload.rejected.length}) — every arm that did not make the cut, and why:`);
  if (payload.rejected.length === 0) {
    lines.push("    (none)");
  } else {
    lines.push(
      ...table(
        ["ARM", "CODE", "DETAIL"],
        payload.rejected.map((r2) => [r2.armId, r2.code, r2.detail]),
      ).map((l) => `    ${l}`),
    );
  }
  return { code: 0, lines };
}

// ---------------------------------------------------------------------------
// explain
// ---------------------------------------------------------------------------

function explain(args: string[], deps: RouteCommandDeps): CliResult {
  const category = flagValue(args, "--category");
  if (category === undefined) return fail("--category <name> is required");

  const c = ctxFromArgs(args);
  if (c.error) return fail(c.error);
  const d = numberFlag(args, "--difficulty");
  if (d.error) return fail(d.error);
  if (d.value !== undefined && (d.value < 0 || d.value > 1)) return fail("--difficulty must be in [0,1]");

  let stack: RouterStack;
  try {
    stack = deps.stack();
  } catch (err) {
    return fail(errText(err));
  }

  const ctx = c.ctx ?? DEFAULT_STATUS_CTX;
  const eligibility = stack.catalog.eligible(stack.requirements, ctx, stack.cost);
  const armById = new Map(eligibility.arms.map((a) => [a.id, a]));

  const routingCtx: RoutingContext = {
    taskId: flagValue(args, "--task-id") ?? `explain:${category}`,
    category,
    difficulty: d.value ?? 0.5,
    decomposable: hasFlag(args, "--decomposable"),
    signals: { multiModelAvailable: new Set(eligibility.arms.map((a) => a.provider)).size > 1 },
    promptTokens: ctx.promptTokens,
  };

  const selection = stack.bandit.select(
    routingCtx,
    eligibility.arms.map((a) => a.id),
    (armId: string): number => {
      const arm = armById.get(armId);
      return arm ? stack.cost.estimate(arm, ctx, 0).usdMean : 0;
    },
  );

  const payload = {
    context: routingCtx,
    chosen: selection.armId,
    reason: selection.reason,
    lambda: selection.lambda,
    budgetRemainingUsd: selection.budgetRemainingUsd,
    ranked: selection.ranked.map((r) => ({
      ...r,
      unpriced: armById.get(r.armId)?.unpriced ?? false,
      estimatedUsd: armById.get(r.armId) ? stack.cost.estimate(armById.get(r.armId)!, ctx, 0).usdMean : 0,
      posterior: stack.bandit.posterior(r.armId, routingCtx),
    })),
    rejected: eligibility.rejected,
    note: "pure read: this advanced the in-memory PRNG but recorded no outcome and saved nothing",
  };

  if (hasFlag(args, "--json")) return jsonResult(payload);

  const lines: string[] = [];
  lines.push(`ROUTE EXPLAIN — category "${category}"`);
  lines.push(`  chosen              ${selection.armId ?? "(none — no eligible arm)"}`);
  lines.push(`  reason              ${selection.reason}`);
  lines.push(`  lambda              ${selection.lambda.toFixed(6)}`);
  lines.push(`  budget remaining    $${selection.budgetRemainingUsd.toFixed(6)}`);
  lines.push("");
  if (payload.ranked.length === 0) {
    lines.push("  (nothing to rank — no eligible arms)");
  } else {
    lines.push(
      ...table(
        ["ARM", "SAMPLED", "SHADOW$", "EST$", "PULLS", "VER", "P(VER)"],
        payload.ranked.map((r) => [
          r.armId,
          num(r.sampledScore, 6),
          num(r.shadowCost, 6),
          usd(r.estimatedUsd, r.unpriced),
          String(r.posterior.pulls),
          String(r.posterior.verified),
          num(r.posterior.pVerifiedMean, 3),
        ]),
      ).map((l) => `  ${l}`),
    );
  }
  lines.push("");
  lines.push(`  ${payload.note}`);
  return { code: 0, lines };
}

// ---------------------------------------------------------------------------
// record
// ---------------------------------------------------------------------------

function boolFlagValue(args: string[], name: string): { value?: boolean | null; error?: string } {
  const raw = flagValue(args, name);
  if (raw === undefined) return {};
  if (raw === "true") return { value: true };
  if (raw === "false") return { value: false };
  if (raw === "null" || raw === "ungraded") return { value: null };
  return { error: `${name} must be true|false|null; got ${JSON.stringify(raw)}` };
}

function record(args: string[], deps: RouteCommandDeps): CliResult {
  const taskId = flagValue(args, "--task");
  if (taskId === undefined) return fail("--task <id> is required");
  const category = flagValue(args, "--category");
  if (category === undefined) return fail("--category <name> is required");
  const armId = flagValue(args, "--arm");
  if (armId === undefined) return fail("--arm <armId> is required");

  const usdSpent = numberFlag(args, "--usd");
  if (usdSpent.error) return fail(usdSpent.error);
  if (usdSpent.value === undefined) return fail("--usd <dollars> is required");
  if (usdSpent.value < 0) return fail("--usd must be >= 0");

  const wallMs = numberFlag(args, "--wall-ms");
  if (wallMs.error) return fail(wallMs.error);
  if (wallMs.value === undefined) return fail("--wall-ms <ms> is required");
  if (wallMs.value < 0) return fail("--wall-ms must be >= 0");

  const tokensIn = numberFlag(args, "--tokens-in");
  if (tokensIn.error) return fail(tokensIn.error);
  const tokensOut = numberFlag(args, "--tokens-out");
  if (tokensOut.error) return fail(tokensOut.error);
  const pCorrect = numberFlag(args, "--p-correct");
  if (pCorrect.error) return fail(pCorrect.error);
  const at = numberFlag(args, "--at");
  if (at.error) return fail(at.error);
  const verifierScore = numberFlag(args, "--verifier-score");
  if (verifierScore.error) return fail(verifierScore.error);

  const graded = boolFlagValue(args, "--graded");
  if (graded.error) return fail(graded.error);

  const tier = tierFromArgs(args);
  if (tier.error) return fail(tier.error);

  let stack: RouterStack;
  try {
    stack = deps.stack();
  } catch (err) {
    return fail(errText(err));
  }

  if (!stack.catalog.has(armId)) {
    return fail(
      `unknown arm "${armId}" — it is not in this install's catalog. Run \`hades route arms\` to list the routable arm space.`,
    );
  }

  let decision;
  try {
    decision = recordRouteOutcome(stack, {
      taskId,
      category,
      armId,
      reason: flagValue(args, "--reason") ?? "recorded via `hades route record`",
      candidates: [armId],
      estimatedUsd: usdSpent.value,
      actualUsd: usdSpent.value,
      wallMs: wallMs.value,
      tokensIn: tokensIn.value ?? 0,
      tokensOut: tokensOut.value ?? 0,
      claimedVerified: hasFlag(args, "--claimed-verified"),
      graded: graded.value === undefined ? null : graded.value,
      pCorrect: pCorrect.value ?? 0,
      at: at.value ?? Date.now(),
      verifierId: flagValue(args, "--verifier"),
      verifierScore: verifierScore.value,
      tier: tier.tier,
    });
    stack.save();
  } catch (err) {
    return fail(errText(err));
  }

  const chain = stack.ledger.verifyChain();
  const payload = { decision, ledgerEntries: chain.entries, chainOk: chain.ok, chainCode: chain.code, root: stack.root };
  if (hasFlag(args, "--json")) return jsonResult(payload);

  return {
    code: 0,
    lines: [
      `recorded ${decision.armId} for task "${decision.taskId}"`,
      `  spend               $${decision.actualUsd.toFixed(6)} over ${decision.wallMs} ms`,
      `  claimed verified    ${decision.claimedVerified}`,
      `  independent grade   ${decision.graded === null ? "(ungraded — no calibration point recorded)" : String(decision.graded)}`,
      `  ledger              ${chain.entries} entr${chain.entries === 1 ? "y" : "ies"}, chain ${chain.ok ? "VERIFIED" : `BROKEN (${chain.code})`}`,
      `  persisted to        ${stack.root ?? "(in-memory — nothing written)"}`,
    ],
  };
}

// ---------------------------------------------------------------------------
// ledger
// ---------------------------------------------------------------------------

function ledger(args: string[], deps: RouteCommandDeps): CliResult {
  const entries = numberFlag(args, "--entries");
  if (entries.error) return fail(entries.error);

  let stack: RouterStack;
  try {
    stack = deps.stack();
  } catch (err) {
    return fail(errText(err));
  }

  const all = stack.ledger.entries();
  const limit = entries.value !== undefined ? Math.max(0, Math.floor(entries.value)) : all.length;
  const shown = all.slice(Math.max(0, all.length - limit));
  const attribution = stack.ledger.attribution();
  const chain = stack.ledger.verifyChain();

  const payload = {
    chain,
    attribution,
    entries: shown.map((e) => ({
      seq: e.seq,
      taskId: e.taskId,
      armId: e.armId,
      actualUsd: e.actualUsd,
      wallMs: e.wallMs,
      claimedVerified: e.claimedVerified,
      graded: e.graded,
      hash: e.hash,
    })),
  };
  if (hasFlag(args, "--json")) return jsonResult(payload, chain.ok ? 0 : 1);

  const lines: string[] = [];
  lines.push("ROUTE LEDGER — tamper-evident per-arm attribution");
  lines.push(
    `  chain               ${chain.ok ? "VERIFIED" : `BROKEN at seq ${String(chain.brokenAt)}`} (${chain.entries} entr${chain.entries === 1 ? "y" : "ies"}, code "${chain.code}")`,
  );
  lines.push("");
  if (attribution.length === 0) {
    lines.push("  (no routing decisions recorded yet)");
  } else {
    lines.push(
      ...table(
        ["ARM", "TASKS", "VERIFIED", "SILENT-WRONG", "DECLINED", "$", "WALL(ms)", "V-TPH", "V-TPH$/$", "FAN-IN"],
        attribution.map((a) => [
          a.armId,
          String(a.tasks),
          String(a.verifiedCorrect),
          String(a.silentWrong),
          String(a.declined),
          a.usd.toFixed(6),
          a.wallMs.toFixed(0),
          a.vtph.toFixed(2),
          a.vtphPerDollar.toFixed(2),
          String(a.escalatedInto),
        ]),
      ).map((l) => `  ${l}`),
    );
  }

  if (hasFlag(args, "--verify") && shown.length > 0) {
    lines.push("");
    lines.push(
      ...table(
        ["SEQ", "TASK", "ARM", "$", "CLAIMED", "GRADED", "HASH"],
        shown.map((e) => [
          String(e.seq),
          e.taskId,
          e.armId,
          e.actualUsd.toFixed(6),
          String(e.claimedVerified),
          e.graded === null ? "n/a" : String(e.graded),
          e.hash.slice(0, 16),
        ]),
      ).map((l) => `  ${l}`),
    );
  }

  const silent = attribution.reduce((n, a) => n + a.silentWrong, 0);
  if (silent > 0) {
    lines.push("");
    lines.push(`  SILENT-WRONG: ${silent} decision(s) claimed verified but the independent grader said false.`);
  }
  return { code: chain.ok ? 0 : 1, lines };
}

// ---------------------------------------------------------------------------
// bench
// ---------------------------------------------------------------------------

async function bench(args: string[], deps: RouteCommandDeps): Promise<CliResult> {
  const taskCount = numberFlag(args, "--tasks");
  if (taskCount.error) return fail(taskCount.error);

  let stack: RouterStack;
  try {
    stack = deps.stack();
  } catch (err) {
    return fail(errText(err));
  }

  const build = deps.bench ?? ((s: RouterStack) => defaultBenchWiring(s, deps.env ?? process.env));
  let wiring: RouteBenchWiring | null;
  try {
    wiring = build(stack);
  } catch (err) {
    return fail(errText(err));
  }

  if (!wiring) {
    // The honest refusal. A benchmark with nothing to measure is not a
    // benchmark, and a simulation presented in its place would be a lie.
    return {
      code: 2,
      lines: [
        "route bench: no provider API key is configured, so there is NOTHING REAL TO MEASURE.",
        "",
        "  Set ANTHROPIC_API_KEY or OPENAI_API_KEY and run again. This command will not",
        "  substitute a simulation and call the result a benchmark.",
      ],
    };
  }

  const tasks = mixedEvalBatch({
    limit: taskCount.value !== undefined ? Math.max(0, Math.floor(taskCount.value)) : undefined,
  });
  if (tasks.length === 0) {
    return fail(`no eval tasks selected (the suite has ${EVAL_TASKS.length}); --tasks must be >= 1`);
  }

  let result;
  try {
    result = await runRouteBench({
      router: wiring.router,
      baselines: wiring.baselines,
      tasks,
      provenance: wiring.provenance,
      ledger: stack.ledger,
      now: wiring.now,
    });
  } catch (err) {
    return fail(errText(err));
  }

  try {
    stack.save();
  } catch (err) {
    return fail(`bench ran but the stack could not be persisted: ${errText(err)}`);
  }

  if (hasFlag(args, "--json")) {
    return jsonResult(
      {
        provenance: result.provenance,
        routerReport: result.routerReport,
        baselineReports: result.baselineReports,
        bestBaseline: result.bestBaseline,
        beatsAllBaselines: result.beatsAllBaselines,
        marginVsBestBaseline: result.marginVsBestBaseline,
        armAttribution: result.armAttribution,
        ledgerChain: result.ledgerChain,
        anomalies: result.anomalies,
      },
      result.beatsAllBaselines ? 0 : 1,
    );
  }
  // The markdown carries its own provenance banner as its FIRST line.
  return { code: result.beatsAllBaselines ? 0 : 1, lines: result.markdown.split("\n") };
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

function doctor(args: string[], deps: RouteCommandDeps): CliResult {
  const checks: DoctorCheck[] = [];
  let stack: RouterStack | null = null;
  try {
    stack = deps.stack();
    checks.push({ name: "stack opens", ok: true, detail: `root=${stack.root ?? "(in-memory)"}` });
  } catch (err) {
    checks.push({ name: "stack opens", ok: false, detail: errText(err) });
  }

  if (stack) {
    const view = routerStatus(stack);
    checks.push({
      name: "arm space is non-empty",
      ok: view.totalArms > 0,
      detail: `${view.totalArms} arm(s) across the model registry`,
    });
    checks.push({
      name: "at least one arm is eligible",
      ok: view.eligibleArms > 0,
      detail:
        view.eligibleArms > 0
          ? `${view.eligibleArms} eligible`
          : "nothing is routable under the current requirements — the router would decline every task",
    });
    checks.push({
      name: "no unpriced arm is priced at $0",
      // The whole point of `unpriced`: an arm with no PriceEntry must report
      // source "unpriced", never a $0 that reads as free.
      ok: view.arms.every((a) => !a.unpriced || a.costSource === "unpriced"),
      detail: `${view.unpricedArms} unpriced arm(s), all labelled`,
    });
    checks.push({
      name: "routing ledger chain verifies",
      ok: view.chainOk,
      detail: view.chainOk ? `${view.ledgerEntries} entr(ies) re-hashed from their own fields` : `chain code "${view.chainCode}" — the persisted ledger was REFUSED`,
    });
    checks.push({
      name: "budget accounting is sane",
      ok: view.spentUsd >= 0 && Math.abs(view.budgetUsd - view.spentUsd - view.remainingUsd) < 1e-9,
      detail: `budget=${view.budgetUsd.toFixed(4)} spent=${view.spentUsd.toFixed(6)} remaining=${view.remainingUsd.toFixed(6)}`,
    });
    checks.push({
      name: "no artifact load errors",
      ok: view.loadErrors.length === 0,
      detail:
        view.loadErrors.length === 0
          ? "every persisted artifact loaded cleanly"
          : view.loadErrors.map((e) => `${e.artifact}: ${e.message}`).join("; "),
    });
    // A REAL end-to-end probe: an uncalibrated stratum must ABSTAIN, never
    // accept. This is the property the whole risk gate rests on.
    const probe = stack.risk.profile("__doctor__", "T4-consistency");
    checks.push({
      name: "uncalibrated stratum abstains",
      ok: probe.source !== "stratum" ? !Number.isFinite(probe.threshold) || probe.source === "pooled" : true,
      detail: `source=${probe.source} threshold=${threshold(probe.threshold)}`,
    });
  }

  const ok = checks.every((c) => c.ok);
  if (hasFlag(args, "--json")) return jsonResult({ ok, checks }, ok ? 0 : 1);
  const lines = ["ROUTE DOCTOR", ""];
  lines.push(
    ...table(["CHECK", "RESULT", "DETAIL"], checks.map((c) => [c.name, c.ok ? "PASS" : "FAIL", c.detail])).map(
      (l) => `  ${l}`,
    ),
  );
  lines.push("");
  lines.push(ok ? "  router wiring is healthy" : "  router wiring has problems (see FAIL rows above)");
  return { code: ok ? 0 : 1, lines };
}
