/**
 * chain-bench — the Phase 2 checkpoint: proves that an `execute_code`
 * program can chain catalog tools (`web_search` -> `fetch_extract` -> the
 * builtin `word_count`) through a registry in a SINGLE program turn, with
 * every step's captured output independently STYX-verified via
 * `toolVerifiers()` and fed through the real `WeakVerifierEnsemble`.
 *
 * Every number in {@link ToolchainBenchResult} is measured from the actual
 * run: `toolCallCount` comes from `ExecuteCodeReport.rpcCalls`, which is
 * itself derived from the Tool-RPC bridge's real provenance ledger (see
 * `tool-rpc.ts` — `bridge.callCount()` counts genuinely dispatched,
 * `onEvent`-emitted calls, not a static guess); `outputBytes` per step is
 * `Buffer.byteLength` of the exact captured output string; `ensembleScore`
 * comes from actually running `WeakVerifierEnsemble.fitPredict` over the
 * real per-step `ToolVerdict`s. Nothing here is a hardcoded constant.
 *
 * REAL vs MOCK: this file supplies no tool implementations of its own — the
 * caller's `registry` (assembled elsewhere, e.g. by a central catalog
 * integration wrapped in `execEnabledRegistry`) must already contain a real
 * `execute_code` tool plus `web_search`/`fetch_extract`/`word_count`
 * (built-in). Whether those tools run in "real" or "mock" mode is entirely
 * up to how the caller built the registry; `runToolchainBench` and the
 * verifiers it drives behave identically either way — mode-honesty is one of
 * the very checks being exercised.
 */

import type { ToolRegistry } from "../agent/tools";
import { WeakVerifierEnsemble, type VerifierVote } from "../styx/tiers";
import { toolVerifiers, type ToolVerdict } from "./verifiers";

// ---------------------------------------------------------------------------
// Public contract (LOCKED)
// ---------------------------------------------------------------------------

export interface ToolchainBenchResult {
  steps: Array<{ tool: string; ok: boolean; outputBytes: number }>;
  toolCallCount: number;
  programTurns: 1;
  verdicts: ToolVerdict[];
  allVerified: boolean;
  ensembleScore: number;
}

export interface ToolchainBenchOptions {
  requiredTools?: string[];
}

const DEFAULT_REQUIRED_TOOLS: readonly string[] = ["web_search", "fetch_extract"];
const EXECUTE_CODE_TOOL_NAME = "execute_code";

// ---------------------------------------------------------------------------
// The single execute_code program: web_search -> fetch_extract -> word_count
// ---------------------------------------------------------------------------
//
// The program never throws on a chain step's own tool-level failure (a
// `{ok:false,...}` ToolResult) — it captures that outcome faithfully into the
// returned `steps` array instead, so a sabotaged/failing fixture still
// produces a well-formed bench result rather than an opaque sandbox error.
// It only short-circuits (via `return`) once it can no longer derive the
// next step's input (e.g. no search results to extract a URL from).

const CHAIN_SEARCH_QUERY = "hades styx toolchain bench";

const CHAIN_PROGRAM_JS = `
const steps = [];

const searchRes = await tools.call("web_search", ${JSON.stringify(CHAIN_SEARCH_QUERY)});
steps.push({ tool: "web_search", ok: searchRes.ok, output: searchRes.output });

let firstUrl = "";
if (searchRes.ok) {
  try {
    const searchParsed = JSON.parse(searchRes.output);
    if (searchParsed && Array.isArray(searchParsed.results) && searchParsed.results[0]) {
      firstUrl = String(searchParsed.results[0].url || "");
    }
  } catch (e) {
    // fetch_extract below will fail cleanly on an empty/invalid URL.
  }
}

const extractRes = await tools.call(
  "fetch_extract",
  JSON.stringify({ url: firstUrl, extract: "text" })
);
steps.push({ tool: "fetch_extract", ok: extractRes.ok, output: extractRes.output });

let content = "";
if (extractRes.ok) {
  try {
    const extractParsed = JSON.parse(extractRes.output);
    if (extractParsed && typeof extractParsed.content === "string") {
      content = extractParsed.content;
    }
  } catch (e) {
    // word_count below just counts whatever content string we have (possibly empty).
  }
}

const wcRes = await tools.call("word_count", content);
steps.push({ tool: "word_count", ok: wcRes.ok, output: wcRes.output });

return JSON.stringify({ steps: steps });
`.trim();

// ---------------------------------------------------------------------------
// Shapes captured off the real execute_code report / program result
// ---------------------------------------------------------------------------

interface ExecuteCodeReportShape {
  ok: boolean;
  result: string;
  rpcCalls: number;
  error?: string;
  stderr?: string;
}

interface CapturedStep {
  tool: string;
  ok: boolean;
  output: string;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// runToolchainBench
// ---------------------------------------------------------------------------

/**
 * Assert `registry` contains `execute_code` plus every one of
 * `opts.requiredTools` (default `["web_search","fetch_extract"]`), run the
 * fixed web_search -> fetch_extract -> word_count `execute_code` program
 * exactly once, verify each captured step whose tool has a registered
 * `ToolOutputVerifier` (currently `web_search` and `fetch_extract` — the
 * builtin `word_count` has no locked-format verifier and is recorded in
 * `steps` but does not contribute a verdict), and fold the resulting
 * verdicts through a real `WeakVerifierEnsemble` for `ensembleScore`.
 *
 * Throws a precise error listing every missing tool name if the registry is
 * incomplete. Throws if the `execute_code` invocation itself fails outright
 * (sandbox crash/timeout) or its result is not the expected JSON shape —
 * that is a bench-infrastructure failure, distinct from a chained tool
 * reporting `ok:false`, which is captured into `steps`/`verdicts` instead.
 */
export async function runToolchainBench(
  registry: ToolRegistry,
  opts?: ToolchainBenchOptions
): Promise<ToolchainBenchResult> {
  const requiredTools = opts?.requiredTools ?? DEFAULT_REQUIRED_TOOLS;
  const required = [EXECUTE_CODE_TOOL_NAME, ...requiredTools];
  const missing = required.filter((name) => registry.get(name) === undefined);
  if (missing.length > 0) {
    throw new Error(
      `runToolchainBench: registry is missing required tool(s): ${missing.join(", ")}`
    );
  }

  const runResult = await registry.run({ tool: EXECUTE_CODE_TOOL_NAME, input: CHAIN_PROGRAM_JS });
  if (!runResult.ok) {
    throw new Error(`runToolchainBench: execute_code invocation failed: ${runResult.output}`);
  }

  let report: ExecuteCodeReportShape;
  try {
    report = JSON.parse(runResult.output) as ExecuteCodeReportShape;
  } catch (err) {
    throw new Error(`runToolchainBench: execute_code output was not valid JSON: ${messageOf(err)}`);
  }
  if (!report.ok) {
    throw new Error(
      `runToolchainBench: execute_code program did not complete successfully: ${
        report.error ?? report.stderr ?? "unknown error"
      }`
    );
  }

  let parsedResult: { steps?: unknown };
  try {
    parsedResult = JSON.parse(report.result) as { steps?: unknown };
  } catch (err) {
    throw new Error(
      `runToolchainBench: execute_code program result was not valid JSON: ${messageOf(err)}`
    );
  }
  if (!Array.isArray(parsedResult.steps)) {
    throw new Error(
      "runToolchainBench: execute_code program result did not contain a 'steps' array"
    );
  }

  const capturedSteps: CapturedStep[] = parsedResult.steps.map((raw, idx) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    if (typeof item.tool !== "string" || typeof item.ok !== "boolean" || typeof item.output !== "string") {
      throw new Error(`runToolchainBench: malformed captured step at index ${idx}`);
    }
    return { tool: item.tool, ok: item.ok, output: item.output };
  });

  const verifiers = toolVerifiers();
  const steps: ToolchainBenchResult["steps"] = [];
  const verdicts: ToolVerdict[] = [];

  for (const step of capturedSteps) {
    steps.push({
      tool: step.tool,
      ok: step.ok,
      outputBytes: Buffer.byteLength(step.output, "utf8"),
    });

    const verifier = verifiers.get(`verify.${step.tool}`);
    if (verifier === undefined) continue; // e.g. word_count — no locked-format verifier
    const verdict = verifier.verify(CHAIN_PROGRAM_JS, { ok: step.ok, output: step.output });
    verdicts.push(verdict);
  }

  // Each verdict is fed to the ensemble as its OWN item (a single-vote
  // item per step), not pooled into one multi-vote item: the verdicts come
  // from DIFFERENT verifiers judging DIFFERENT tool calls' outputs, not
  // several opinions about the same claim, so they are not exchangeable
  // votes on one item in the Dawid-Skene sense the ensemble models (see
  // `../styx/tiers.ts`'s own agreement-implies-reliability docs). The real
  // `WeakVerifierEnsemble.fitPredict` still does genuine, deterministic work
  // per item; `ensembleScore` is the mean of the per-item calibrated scores
  // it returns — a real, measured aggregate, not a constant.
  const items: VerifierVote[][] = verdicts.map((v) => [{ verifierId: v.verifierId, passed: v.passed }]);
  const ensemble = new WeakVerifierEnsemble();
  const itemResults = ensemble.fitPredict(items);
  const ensembleScore =
    itemResults.length === 0 ? 0.5 : itemResults.reduce((sum, r) => sum + r.score, 0) / itemResults.length;

  const allVerified = steps.every((s) => s.ok) && verdicts.length > 0 && verdicts.every((v) => v.passed);

  return {
    steps,
    toolCallCount: report.rpcCalls,
    programTurns: 1,
    verdicts,
    allVerified,
    ensembleScore,
  };
}
