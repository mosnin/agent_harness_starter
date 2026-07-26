/**
 * Terminal-free `hades hierarchy <sub>` handler.
 *
 * This is the CLI surface over the swarm-hierarchy benchmarks and harnesses. Like
 * the rest of {@link ./cli.ts}'s subcommands it is a pure(-ish) function returning
 * `{ code, lines }` — no `console.log`, no `process.exit`, no shell — so it is
 * fully unit-testable. The main router wires `case "hierarchy": return
 * runHierarchyCommand(rest)`.
 *
 * Every subcommand calls the REAL underlying function and turns its computed
 * output into an array of individual `lines` (multi-line strings such as a
 * markdown table are split so no single `lines` entry contains a newline). An
 * optional `opts` bag lets tests inject small, fast, deterministic sizes.
 */

import { runHeadToHead } from "../bench/head-to-head";
import { compareMakespan } from "../bench/latency-makespan";
import { runChaosSuite } from "../bench/chaos-suite";
import { fuzzMany } from "../hierarchy/fuzz";
import { buildBalancedHierarchy, hierarchyStats } from "../hierarchy/tree";

export interface HierarchyCommandResult {
  code: number;
  lines: string[];
}

/** Options for the underlying benchmark functions, so tests can pass tiny sizes. */
export interface HierarchyCommandOpts {
  headToHead?: Parameters<typeof runHeadToHead>[0];
  makespan?: Parameters<typeof compareMakespan>[0];
  chaos?: Parameters<typeof runChaosSuite>[0];
}

const SUBCOMMANDS = ["head-to-head", "makespan", "chaos", "fuzz", "stats", "help"] as const;

/** Split any string that may contain newlines into individual line entries. */
function toLines(block: string): string[] {
  return block.split("\n");
}

function usage(): HierarchyCommandResult {
  return {
    code: 0,
    lines: [
      "hades hierarchy — run the swarm-hierarchy benchmarks and harnesses",
      "",
      "Usage: hades hierarchy <command> [args]",
      "",
      "Commands:",
      "  head-to-head        Hierarchy vs. flat baseline (routing + makespan)",
      "  makespan            Latency-model makespan: flat vs. balanced tree",
      "  chaos               Chaos suite: verified XOR clean, never silent-wrong",
      "  fuzz [count]        Property-fuzz the tree vs. a flat reference reducer",
      "  stats [b] [levels]  Build a balanced hierarchy and print its shape",
      "  help                Show this help",
    ],
  };
}

async function headToHead(opts?: HierarchyCommandOpts): Promise<HierarchyCommandResult> {
  const report = await runHeadToHead(opts?.headToHead);
  // Peak routing speedup across the measured worker counts (the load-bearing win).
  const routingSpeedup = report.rows.reduce((m, r) => Math.max(m, r.routingSpeedup), 0);
  // Makespan under the honest latency model (the in-memory clock favors the flat side).
  const makespanReport = compareMakespan(opts?.makespan);
  const makespanSpeedup = makespanReport.rows.reduce((m, r) => Math.max(m, r.makespanSpeedup), 0);

  const lines = [
    ...toLines(report.markdownTable),
    "",
    `Routing speedup: up to ${routingSpeedup.toFixed(2)}x | Makespan (latency model): up to ${makespanSpeedup.toFixed(2)}x`,
  ];
  return { code: 0, lines };
}

function makespan(opts?: HierarchyCommandOpts): HierarchyCommandResult {
  const report = compareMakespan(opts?.makespan);
  return { code: 0, lines: toLines(report.markdownTable) };
}

async function chaos(opts?: HierarchyCommandOpts): Promise<HierarchyCommandResult> {
  const report = await runChaosSuite(opts?.chaos);
  const verified = report.scenarios.reduce((n, s) => n + s.verifiedCorrect, 0);
  const clean = report.scenarios.reduce((n, s) => n + s.cleanFailures, 0);
  const ok = report.allInvariantsHeld && report.totalSilentWrong === 0;
  const lines = [
    `Chaos suite: ${report.scenarios.length} scenarios, ${report.totalRuns} runs`,
    `  verified-correct: ${verified}`,
    `  clean-failures:   ${clean}`,
    `  silent-wrong:     ${report.totalSilentWrong}`,
    `  allInvariantsHeld: ${report.allInvariantsHeld}`,
    ok ? "Invariant held: correct-verified XOR clean-audited, never silent-wrong." : "INVARIANT VIOLATED — see counts above.",
  ];
  return { code: ok ? 0 : 1, lines };
}

async function fuzz(args: string[]): Promise<HierarchyCommandResult> {
  const raw = args[0];
  let count = 200;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return { code: 1, lines: [`Invalid count: ${raw}`, "Usage: hades hierarchy fuzz [count]"] };
    }
    count = parsed;
  }
  const report = await fuzzMany(count);
  if (report.firstFailure === null) {
    return {
      code: 0,
      lines: [`Fuzz: checked ${report.checked} cases — all matched the flat reference reducer.`],
    };
  }
  return {
    code: 1,
    lines: [
      `Fuzz: checked ${report.checked} cases — ${report.failures.length} FAILED.`,
      `First failure: ${JSON.stringify(report.firstFailure)}`,
    ],
  };
}

function stats(args: string[]): HierarchyCommandResult {
  const branching = args[0] !== undefined ? Number(args[0]) : 4;
  const levels = args[1] !== undefined ? Number(args[1]) : 3;
  if (!Number.isInteger(branching) || branching < 1) {
    return { code: 1, lines: [`Invalid branching: ${args[0]}`, "Usage: hades hierarchy stats [b] [levels]"] };
  }
  if (!Number.isInteger(levels) || levels < 0) {
    return { code: 1, lines: [`Invalid levels: ${args[1]}`, "Usage: hades hierarchy stats [b] [levels]"] };
  }
  const root = buildBalancedHierarchy(branching, levels);
  const s = hierarchyStats(root);
  return {
    code: 0,
    lines: [
      `Balanced hierarchy: branching=${branching}, coordinatorLevels=${levels}`,
      `  workers:  ${s.workers}`,
      `  depth:    ${s.maxDepth}`,
      `  nodes:    ${s.nodes}`,
      `  coordinators: ${s.coordinators}`,
      `  maxWidth: ${s.maxWidth}`,
    ],
  };
}

/**
 * Dispatch `hades hierarchy <sub> [args]`. Returns `{ code: 0 }` on success and
 * `{ code: 1 }` on bad usage or a failed invariant/fuzz. See the module doc and
 * each subcommand for behavior.
 */
export async function runHierarchyCommand(
  args: string[],
  opts?: HierarchyCommandOpts
): Promise<HierarchyCommandResult> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return usage();
    case "head-to-head":
      return headToHead(opts);
    case "makespan":
      return makespan(opts);
    case "chaos":
      return chaos(opts);
    case "fuzz":
      return fuzz(rest);
    case "stats":
      return stats(rest);
    default:
      return {
        code: 1,
        lines: [`Unknown hierarchy command: ${sub}`, "run `hades hierarchy help`"],
      };
  }
}

export const HIERARCHY_SUBCOMMANDS = SUBCOMMANDS;
