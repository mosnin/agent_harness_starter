/**
 * `hades bench <sub>` — the honest scoreboard CLI.
 *
 * Today the headline subcommand is `vtph`: it runs the decomposable eval suite
 * through an {@link AgentRunner} and prints the **V-TPH$** table (Verified Tasks
 * per Hour per Dollar) — the North-Star metric defined in
 * `.plans/HADES_BEYOND_HERMES.md`.
 *
 * Honest Phase-0 default: with no LLM brain wired yet, the built-in runner
 * *declines every task* (claims nothing verified), so the scoreboard prints the
 * true starting line — verified-correct ≈ 0. That is the baseline Phase 1 has to
 * move. Callers (and Phase 1) inject a real runner via `opts.runner`; the same
 * command then prints real numbers. Terminal-free (`{ code, lines }`) like the
 * rest of the CLI, so it unit-tests without a shell.
 */

import { runVtph } from "../bench/vtph";
import type { AgentRunner, VtphReport } from "../bench/vtph";
import { EVAL_TASKS, decomposableTasks } from "../bench/eval-suite";

export interface BenchCommandResult {
  code: number;
  lines: string[];
}

/**
 * The Phase-0 baseline runner: no brain, so it verifies nothing. Every task is
 * declined (never a silent-wrong claim), zero cost. This is intentionally honest —
 * it makes the empty scoreboard the visible starting point, not a hidden one.
 */
export const decliningRunner: AgentRunner = async () => ({
  output: "",
  claimedVerified: false,
  tokensIn: 0,
  tokensOut: 0,
  usd: 0,
  provenance: [],
});

function formatReport(r: VtphReport): string[] {
  return [
    `Runner: ${r.label}`,
    `  tasks:            ${r.tasks}`,
    `  verified-correct: ${r.verifiedCorrect}`,
    `  silent-wrong:     ${r.silentWrong}`,
    `  declined:         ${r.declined}`,
    `  wall-clock:       ${(r.wallClockMs / 1000).toFixed(2)}s`,
    `  tokens:           ${r.totalTokens}`,
    `  spend:            $${r.totalUsd.toFixed(4)}`,
    `  V-TPH (verified tasks/hour):        ${r.vtph.toFixed(2)}`,
    `  V-TPH$ (verified tasks/hour/$):     ${Number.isFinite(r.vtphPerDollar) ? r.vtphPerDollar.toFixed(2) : "n/a (zero spend)"}`,
    `  provenance-complete:                ${(r.provenanceCompleteRate * 100).toFixed(0)}%`,
  ];
}

const USAGE = [
  "Usage: hades bench <command>",
  "",
  "Commands:",
  "  vtph [--decomposable]   Run the eval suite and print the V-TPH$ scoreboard",
  "  help                    Show this help",
  "",
  "V-TPH$ = Verified Tasks per Hour per Dollar (see .plans/HADES_BEYOND_HERMES.md).",
  "Note: with no LLM brain wired (Phase 0), the default runner declines every task,",
  "so verified-correct is ~0 by design — the honest baseline Phase 1 must move.",
];

/**
 * Terminal-free `hades bench <sub>` handler. `opts.runner` injects a real
 * agent runner (Phase 1+); absent it, the honest declining baseline is used.
 */
export async function runBenchCommand(
  args: string[],
  opts?: { runner?: AgentRunner; concurrency?: number }
): Promise<BenchCommandResult> {
  const [sub, ...rest] = args;

  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    return { code: 0, lines: USAGE };
  }

  if (sub === "vtph") {
    const onlyDecomposable = rest.includes("--decomposable");
    const tasks = onlyDecomposable ? decomposableTasks() : EVAL_TASKS;
    const runner = opts?.runner ?? decliningRunner;
    const label = opts?.runner ? "injected" : "declining-baseline (no brain — Phase 0)";
    const report = await runVtph(runner, tasks, {
      label,
      concurrency: opts?.concurrency ?? 8,
    });
    return {
      code: 0,
      lines: [
        `V-TPH$ scoreboard — ${tasks.length} tasks${onlyDecomposable ? " (decomposable only)" : ""}`,
        "",
        ...formatReport(report),
        "",
        report.verifiedCorrect === 0 && !opts?.runner
          ? "This is the honest Phase-0 baseline: no brain wired yet, so nothing is verified."
          : "Inject a real runner (Phase 1) to measure the swarm vs a single agent.",
      ],
    };
  }

  return {
    code: 1,
    lines: [`Unknown bench command: ${sub}`, "Run `hades bench help` for usage."],
  };
}
