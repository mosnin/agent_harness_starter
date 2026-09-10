/**
 * `hades exec <sub>` — programmatic tool calling from the terminal.
 *
 * The CLI surface for Phase 1 (`.plans/HADES_PAST_HERMES_20.md`): run one
 * model-written (or operator-written) program that chains real tools through
 * the Tool-RPC bridge inside a real sandbox, and print the full report —
 * including the STYX provenance trace hash and an actual ledger verification
 * verdict, re-walked from genesis on every run, never assumed.
 *
 *   hades exec run <code>              Run JS (default) against the builtin tools
 *   hades exec run --lang python ...   Run Python via the real python3 sandbox
 *   hades exec run --file <path>       Load the program from a file
 *   hades exec bench                   The Phase 1 checkpoint: ReAct loop vs one
 *                                      execute_code call, all numbers counted
 *                                      from real execution (the only mock is the
 *                                      clearly-labelled scripted LLM on the
 *                                      ReAct side — see pipeline-bench.ts)
 *
 * Terminal-free (`{ code, lines }`) like every other CLI command, so it
 * unit-tests without a shell.
 */

import { readFileSync } from "node:fs";
import type { ToolRegistry } from "../agent/tools";
import { execEnabledRegistry } from "../exec/index";
import { createExecuteCodeTool, type ExecuteCodeReport } from "../exec/code-tool";
import type { ProvenanceLedger } from "../exec/provenance";
import { runPipelineBench } from "../exec/pipeline-bench";

export interface ExecCommandResult {
  code: number;
  lines: string[];
}

export interface ExecCommandOptions {
  /** Tool registry the sandboxed program may call. Default: builtin tools + execute_code. */
  registry?: ToolRegistry;
  /** Whole-program wall-clock budget in ms (forwarded to the sandbox). */
  timeoutMs?: number;
}

const USAGE = [
  "Usage: hades exec <command>",
  "",
  "Commands:",
  "  run [--lang js|python] [--file <path>] [code]   Run one program that chains",
  "                                                  tools via tools.call(name, input)",
  "                                                  (JS) / tools_call(name, input)",
  "                                                  (Python); prints the report and",
  "                                                  the verified STYX provenance trace",
  "  bench                                           Phase 1 checkpoint: ReAct loop vs",
  "                                                  one execute_code call (counted, real)",
  "  help                                            Show this help",
  "",
  "Every tool call inside the program lands in a hash-chained provenance ledger;",
  "`run` re-verifies the chain from genesis and prints the verdict.",
];

/** Parse `run` flags. Returns an error line list on misuse. */
function parseRunArgs(args: string[]): { lang: "js" | "python"; source: string } | { errorLines: string[] } {
  let lang: "js" | "python" = "js";
  let file: string | undefined;
  const codeParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--lang") {
      const v = args[++i];
      if (v === "js" || v === "javascript") lang = "js";
      else if (v === "python" || v === "py") lang = "python";
      else return { errorLines: [`Unknown --lang: ${v ?? "(missing)"} (expected js|python)`] };
    } else if (a === "--file") {
      const v = args[++i];
      if (!v) return { errorLines: ["--file needs a path"] };
      file = v;
    } else {
      codeParts.push(a);
    }
  }

  let source: string;
  if (file !== undefined) {
    if (codeParts.length > 0) {
      return { errorLines: ["Pass either --file <path> or inline code, not both."] };
    }
    try {
      source = readFileSync(file, "utf8");
    } catch (err) {
      return { errorLines: [`Cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`] };
    }
  } else {
    source = codeParts.join(" ");
  }

  if (source.trim() === "") {
    return { errorLines: ["No code given.", "", ...USAGE] };
  }
  return { lang, source };
}

function formatReport(report: ExecuteCodeReport, ledger: ProvenanceLedger | undefined): string[] {
  const verdict = ledger?.verify();
  const lines = [
    `ok:          ${report.ok}`,
    `language:    ${report.language}`,
    `result:      ${report.result}`,
    `rpc calls:   ${report.rpcCalls}`,
    `timed out:   ${report.timedOut}`,
    `trace:       sha256:${report.traceSha256}`,
    `trace chain: ${
      verdict === undefined
        ? "unavailable (no ledger captured)"
        : verdict.ok
          ? `VERIFIED (${verdict.length} record${verdict.length === 1 ? "" : "s"}, re-walked from genesis)`
          : `TAMPERED (${verdict.reason ?? "unknown"} at seq ${verdict.firstBadSeq ?? "?"})`
    }`,
  ];
  if (report.error !== undefined) lines.push(`error:       ${report.error}`);
  if (report.stdout !== "") lines.push("--- stdout ---", ...report.stdout.replace(/\n$/, "").split("\n"));
  if (report.stderr !== "") lines.push("--- stderr ---", ...report.stderr.replace(/\n$/, "").split("\n"));
  return lines;
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

export async function runExecCommand(
  args: string[],
  opts?: ExecCommandOptions,
): Promise<ExecCommandResult> {
  const [sub, ...rest] = args;

  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    return { code: 0, lines: USAGE };
  }

  if (sub === "run") {
    const parsed = parseRunArgs(rest);
    if ("errorLines" in parsed) return { code: 1, lines: parsed.errorLines };

    const registry = opts?.registry ?? execEnabledRegistry();
    let capturedLedger: ProvenanceLedger | undefined;
    const tool = createExecuteCodeTool({
      registry,
      timeoutMs: opts?.timeoutMs,
      onLedger: (ledger) => {
        capturedLedger = ledger;
      },
    });

    const input = parsed.lang === "python" ? `#lang: python\n${parsed.source}` : parsed.source;
    const result = await tool.run(input);
    const report = JSON.parse(result.output) as ExecuteCodeReport;
    return { code: report.ok ? 0 : 1, lines: formatReport(report, capturedLedger) };
  }

  if (sub === "bench") {
    const bench = await runPipelineBench();
    const { react, programmatic } = bench;
    return {
      code: bench.answersAgree && programmatic.verifiedTrace ? 0 : 1,
      lines: [
        "Phase 1 checkpoint — search -> extract -> summarize, run two ways (all numbers counted):",
        "",
        "                    ReAct loop    execute_code",
        `  model turns:      ${String(react.steps).padEnd(14)}${programmatic.steps}`,
        `  tool calls:       ${String(react.toolCalls).padEnd(14)}${programmatic.toolCalls}`,
        `  answer:           ${react.answer.padEnd(14)}${programmatic.answer}`,
        `  verified trace:   ${String(react.verifiedTrace).padEnd(14)}${programmatic.verifiedTrace}`,
        "",
        `  step reduction:      ${pct(bench.stepReduction)} (${react.steps} conversational turns collapsed into ${programmatic.steps})`,
        `  tool-call reduction: ${pct(bench.toolCallReduction)} (identical underlying work either way — by design)`,
        `  answers agree:       ${bench.answersAgree}`,
        "",
        "The ReAct side's LLM is a deterministic scripted stand-in (clearly labelled in",
        "pipeline-bench.ts); the loop, registry, tools, sandbox, RPC bridge, and provenance",
        "ledger on both sides are the real production modules. The programmatic trace is",
        "hash-chain verified; a plain ReAct transcript has no such structure to verify.",
      ],
    };
  }

  return { code: 1, lines: [`Unknown exec command: ${sub}`, "Run `hades exec help` for usage."] };
}
