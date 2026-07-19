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

import { runRecallBench } from "../memory/recall-bench";
import { runVtph, compareVtph } from "../bench/vtph";
import type { AgentRunner, VtphReport } from "../bench/vtph";
import { EVAL_TASKS, decomposableTasks } from "../bench/eval-suite";
import { HttpModelClient, MultiProviderClient } from "../models/client";
import type { ModelClient, ProviderConfig } from "../models/client";
import { verifiedSwarmRunner, singleAgentRunner } from "../agent/runner";
import { styxRunner } from "../styx/runner";

/**
 * Assemble a MultiProviderClient from environment keys (multi-provider fan-out).
 * Returns null when no provider key is set — so the scoreboard falls back to the
 * honest declining baseline instead of pretending. Reads ANTHROPIC_API_KEY and
 * OPENAI_API_KEY (and OPENAI_BASE_URL / an OpenAI-dialect OPENROUTER_API_KEY).
 */
export function buildClientFromEnv(env: Record<string, string | undefined> = process.env): {
  client: ModelClient;
  workerModel: string;
  verifierModel: string;
} | null {
  const providers: Array<{ client: ModelClient; models: string[] }> = [];
  let workerModel = "";
  let verifierModel = "";

  if (env.ANTHROPIC_API_KEY) {
    const cfg: ProviderConfig = {
      name: "anthropic",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: env.ANTHROPIC_API_KEY,
      models: ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-4-1"],
    };
    providers.push({ client: new HttpModelClient(cfg), models: cfg.models });
    workerModel = workerModel || "claude-haiku-4-5-20251001"; // cheap worker
    verifierModel = "claude-sonnet-5"; // stronger verifier — cross-model gate
  }
  if (env.OPENAI_API_KEY) {
    const cfg: ProviderConfig = {
      name: "openai",
      kind: "openai",
      baseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      apiKey: env.OPENAI_API_KEY,
      models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1"],
    };
    providers.push({ client: new HttpModelClient(cfg), models: cfg.models });
    workerModel = workerModel || "gpt-4o-mini";
    verifierModel = verifierModel || "gpt-4o";
  }

  if (!providers.length) return null;
  return {
    client: new MultiProviderClient(providers, { maxConcurrency: 8 }),
    workerModel,
    verifierModel: verifierModel || workerModel,
  };
}

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
  "  vtph [--swarm|--single] [--decomposable]  Run the eval suite, print the V-TPH$ scoreboard",
  "  headtohead [--decomposable]               Verified swarm vs single-agent baseline (go/no-go)",
  "  styx [--decomposable]                     STYX (speculate/race/verify/gate/certify) vs both baselines",
  "  recall [--sessions N] [--seed N]          Session-recall: FTS index vs legacy scanner (seeded synthetic corpus, real runs)",
  "  help                                      Show this help",
  "",
  "V-TPH$ = Verified Tasks per Hour per Dollar (see .plans/HADES_BEYOND_HERMES.md).",
  "--swarm/--single and headtohead need provider keys (ANTHROPIC_API_KEY / OPENAI_API_KEY);",
  "without keys the scoreboard runs the honest declining baseline (verified ≈ 0).",
];

/**
 * Terminal-free `hades bench <sub>` handler. `opts.runner` injects a real
 * agent runner (Phase 1+); absent it, the honest declining baseline is used.
 */
export interface BenchCommandOptions {
  runner?: AgentRunner;
  concurrency?: number;
  /** Injected client for tests; otherwise built from env keys. */
  env?: { client: ModelClient; workerModel: string; verifierModel: string } | null;
}

export async function runBenchCommand(
  args: string[],
  opts?: BenchCommandOptions
): Promise<BenchCommandResult> {
  const [sub, ...rest] = args;

  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    return { code: 0, lines: USAGE };
  }

  if (sub === "recall") {
    const readIntFlag = (flag: string, fallback: number): number | { error: string } => {
      const idx = rest.indexOf(flag);
      if (idx === -1) return fallback;
      const raw = rest[idx + 1];
      const n = Number(raw);
      if (raw === undefined || !Number.isInteger(n) || n <= 0) {
        return { error: `Invalid ${flag} value: ${raw ?? "(missing)"} — expected a positive integer.` };
      }
      return n;
    };
    const sessions = readIntFlag("--sessions", 60);
    if (typeof sessions === "object") return { code: 1, lines: [sessions.error] };
    const seed = readIntFlag("--seed", 42);
    if (typeof seed === "object") return { code: 1, lines: [seed.error] };

    let report;
    try {
      report = runRecallBench({ sessions, seed });
    } catch (err) {
      return { code: 1, lines: [err instanceof Error ? err.message : String(err)] };
    }
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    return {
      code: 0,
      lines: [
        `Session-recall benchmark — seeded synthetic corpus (seed ${seed}), really indexed + really queried`,
        "",
        `  corpus:   ${report.corpusSessions} sessions, ${report.corpusMessages} messages, ${report.queries} probe queries`,
        `  index:    built in ${report.indexMs.toFixed(1)}ms, all queries searched in ${report.searchMs.toFixed(1)}ms (measured this run)`,
        "",
        "                 recall@1   recall@5   MRR",
        `  FTS (BM25F)    ${pct(report.fts.recallAt1).padEnd(10)} ${pct(report.fts.recallAt5).padEnd(10)} ${report.fts.mrr.toFixed(4)}`,
        `  legacy scan    ${pct(report.baseline.recallAt1).padEnd(10)} ${pct(report.baseline.recallAt5).padEnd(10)} ${report.baseline.mrr.toFixed(4)}`,
        "",
        "Corpus is synthetic (deterministic seed, labeled as such); every metric above is measured by",
        "actually running both engines over it in this process — nothing is precomputed or fabricated.",
      ],
    };
  }

  const env = opts?.env !== undefined ? opts.env : buildClientFromEnv();
  const concurrency = opts?.concurrency ?? 8;

  if (sub === "vtph") {
    const onlyDecomposable = rest.includes("--decomposable");
    const tasks = onlyDecomposable ? decomposableTasks() : EVAL_TASKS;

    let runner = opts?.runner;
    let label = "injected";
    if (!runner) {
      if ((rest.includes("--swarm") || rest.includes("--single")) && env) {
        if (rest.includes("--single")) {
          runner = singleAgentRunner(env.client, { model: env.workerModel });
          label = `single-agent (${env.workerModel})`;
        } else {
          runner = verifiedSwarmRunner(env.client, {
            workerModel: env.workerModel,
            verifierModel: env.verifierModel,
          });
          label = `verified-swarm (${env.workerModel} + verifier ${env.verifierModel})`;
        }
      } else {
        runner = decliningRunner;
        label = "declining-baseline (no keys — set ANTHROPIC_API_KEY/OPENAI_API_KEY)";
      }
    }

    const report = await runVtph(runner, tasks, { label, concurrency });
    return {
      code: 0,
      lines: [
        `V-TPH$ scoreboard — ${tasks.length} tasks${onlyDecomposable ? " (decomposable only)" : ""}`,
        "",
        ...formatReport(report),
        "",
        runner === decliningRunner
          ? "Honest baseline: no brain wired (no keys), so nothing is verified. Set a provider key and pass --swarm."
          : "Real run. Compare against --single with `hades bench headtohead`.",
      ],
    };
  }

  if (sub === "headtohead") {
    const onlyDecomposable = rest.includes("--decomposable");
    const tasks = onlyDecomposable ? decomposableTasks() : EVAL_TASKS;
    if (!env) {
      return {
        code: 1,
        lines: [
          "headtohead needs provider keys (ANTHROPIC_API_KEY and/or OPENAI_API_KEY) to run real inference.",
          "Without keys there is no brain to measure. This is intentional — no simulated numbers.",
        ],
      };
    }
    const single = singleAgentRunner(env.client, { model: env.workerModel });
    const swarm = verifiedSwarmRunner(env.client, {
      workerModel: env.workerModel,
      verifierModel: env.verifierModel,
    });
    const { reports, markdownTable, vtphPerDollarSpeedup } = await compareVtph(
      [
        { label: "single-agent (self-trust)", runner: single },
        { label: "verified-swarm", runner: swarm },
      ],
      tasks,
      { concurrency }
    );
    const swarmReport = reports.find((r) => r.label === "verified-swarm");
    const singleReport = reports.find((r) => r.label === "single-agent (self-trust)");
    const gate = vtphPerDollarSpeedup >= 3
      ? `GO — verified swarm is ${vtphPerDollarSpeedup.toFixed(2)}x the single agent on V-TPH$ (≥3x gate cleared).`
      : `NO-GO (yet) — ${vtphPerDollarSpeedup.toFixed(2)}x, below the 3x go/no-go gate. Re-plan or tune (cheaper workers / stronger gate).`;
    return {
      code: 0,
      lines: [
        `Head-to-head — ${tasks.length} tasks`,
        "",
        ...markdownTable.split("\n"),
        "",
        `Trust: single-agent silent-wrong = ${singleReport?.silentWrong ?? "?"}, verified-swarm silent-wrong = ${swarmReport?.silentWrong ?? "?"}.`,
        gate,
      ],
    };
  }

  if (sub === "styx") {
    const onlyDecomposable = rest.includes("--decomposable");
    const tasks = onlyDecomposable ? decomposableTasks() : EVAL_TASKS;
    if (!env) {
      return {
        code: 1,
        lines: [
          "styx needs provider keys (ANTHROPIC_API_KEY and/or OPENAI_API_KEY) to run real inference.",
          "Without keys there is no brain to measure. This is intentional — no simulated numbers.",
        ],
      };
    }
    const single = singleAgentRunner(env.client, { model: env.workerModel });
    const swarm = verifiedSwarmRunner(env.client, {
      workerModel: env.workerModel,
      verifierModel: env.verifierModel,
    });
    const styx = styxRunner(env.client, {
      workerModel: env.workerModel,
      verifierModels: [env.verifierModel, env.workerModel],
      issuedAt: Date.now(),
    });
    const { reports, markdownTable, vtphPerDollarSpeedup } = await compareVtph(
      [
        { label: "single-agent (self-trust)", runner: single },
        { label: "verified-swarm", runner: swarm },
        { label: "STYX", runner: styx },
      ],
      tasks,
      { concurrency }
    );
    const styxReport = reports.find((r) => r.label === "STYX");
    return {
      code: 0,
      lines: [
        `STYX head-to-head — ${tasks.length} tasks`,
        "",
        ...markdownTable.split("\n"),
        "",
        `STYX silent-wrong: ${styxReport?.silentWrong ?? "?"} (the bound the conformal gate enforces).`,
        `Best-vs-worst V-TPH$ spread: ${vtphPerDollarSpeedup.toFixed(2)}x.`,
      ],
    };
  }

  return {
    code: 1,
    lines: [`Unknown bench command: ${sub}`, "Run `hades bench help` for usage."],
  };
}
