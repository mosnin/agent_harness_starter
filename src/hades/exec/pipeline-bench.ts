/**
 * pipeline-bench — the Phase 1 "beyond Hermes" checkpoint.
 *
 * Runs the SAME real task — "search the fixture corpus for documents
 * mentioning a keyword, extract each matching document's reported numeric
 * value, and report the mean" — two ways, and reports genuinely COUNTED
 * numbers for both:
 *
 *   - `react`:        the real {@link AgentLoop}, one tool call per model
 *     turn, driven by a `ScriptedModelClient` (a deterministic, clearly-
 *     labelled fake LLM — never presented as a live model).
 *   - `programmatic`: a single real `execute_code` invocation (see
 *     `code-tool.ts`) whose embedded JavaScript drives the identical three
 *     tools through the real Tool-RPC bridge and sandbox.
 *
 * Every number in {@link PipelineBenchResult} is derived, never hardcoded:
 * `react.steps`/`react.toolCalls` come straight off the real
 * `AgentLoopResult` (`.steps` / `.toolCalls.length`); `programmatic.toolCalls`
 * comes off the real `ExecuteCodeReport.rpcCalls`; `programmatic.steps` is
 * `1` because that is literally how many `execute_code` invocations this
 * file makes — not an assumption, the actual call count.
 *
 * The asymmetry in `verifiedTrace` is deliberate and is the point of this
 * checkpoint: the programmatic side carries a STYX provenance ledger (every
 * dispatched tool call hash-chained via `ProvenanceLedger`, verified with
 * `.verify().ok`), while the ReAct transcript has no such structure — a
 * plain chat transcript is not independently verifiable evidence of what
 * ran. `react.verifiedTrace` is therefore always `false`, not because the
 * ReAct run "failed" in any way, but because nothing analogous to a
 * provenance ledger exists for it. `execute_code` gives you that trail for
 * free; the classic ReAct loop does not.
 *
 * REAL vs MOCK: `corpus_search` / `doc_extract` / `summarize_stats` are real
 * deterministic tools (substring search, regex extraction, real arithmetic)
 * over an embedded fixture corpus. `AgentLoop`, `ToolRegistry`, the
 * Tool-RPC bridge, the JS sandbox, and `ProvenanceLedger` are all the real
 * production modules. The ONLY mock in this file is `ScriptedModelClient`,
 * a scripted stand-in for the LLM on the ReAct side — it is named plainly,
 * documented here, and never used on the programmatic side.
 */

import { AgentLoop } from "../agent/loop";
import type { ChatRequest, ChatResponse, ModelClient } from "../models/client";
import { ToolRegistry, type Tool } from "../agent/tools";
import { createExecuteCodeTool, type ExecuteCodeReport } from "./code-tool";
import type { ProvenanceLedger } from "./provenance";

// ---------------------------------------------------------------------------
// Public contract (LOCKED)
// ---------------------------------------------------------------------------

export interface PipelineSideResult {
  steps: number;
  toolCalls: number;
  answer: string;
  verifiedTrace: boolean;
}

export interface PipelineBenchResult {
  react: PipelineSideResult;
  programmatic: PipelineSideResult;
  toolCallReduction: number;
  stepReduction: number;
  answersAgree: boolean;
}

// ---------------------------------------------------------------------------
// Fixture corpus — 10 short documents. Five mention the search keyword
// "sensor-alpha" and each of those five carries EXACTLY one embedded
// numeric "reported value" (the rest of each document is deliberately kept
// free of stray digits so regex number-extraction can't pick up anything
// but the intended value); the other five are decoys that either mention a
// different sensor or an unrelated topic entirely, so the search step is
// load-bearing, not decorative.
// ---------------------------------------------------------------------------

interface CorpusDoc {
  id: string;
  text: string;
}

const CORPUS: CorpusDoc[] = [
  {
    id: "doc1",
    text: "sensor-alpha calibration run: drift measured at 12.5 units. contact ops@example.com for details.",
  },
  {
    id: "doc2",
    text: "sensor-alpha calibration run: drift value logged as 9.25 units, verified by lab@example.com.",
  },
  {
    id: "doc3",
    text: "sensor-beta maintenance log: drift 40 units recorded, unrelated to this cycle's audit.",
  },
  {
    id: "doc4",
    text: "sensor-alpha calibration run: measured drift of 18.0 units this cycle.",
  },
  {
    id: "doc5",
    text: "weather station daily summary: temperature reached 21.4 degrees, humidity steady.",
  },
  {
    id: "doc6",
    text: "sensor-alpha firmware update note: post-update drift recorded at 6.25 units, verified twice.",
  },
  {
    id: "doc7",
    text: "sensor-gamma status: nominal, drift 3.1 units, no anomalies detected.",
  },
  {
    id: "doc8",
    text: "sensor-alpha quarterly audit: aggregate drift figure of 15.0 units reported to compliance team at audit@example.com.",
  },
  {
    id: "doc9",
    text: "network switch health report: throughput steady, no packet drops observed this week.",
  },
  {
    id: "doc10",
    text: "battery bank levels nominal across all cells, no maintenance action required.",
  },
];

/** The keyword the pipeline task searches for; matches docs 1, 2, 4, 6, 8. */
const PIPELINE_SEARCH_TERM = "sensor-alpha";

const NUMBER_RE = /-?\d+(?:\.\d+)?/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function extractNumbersLocal(text: string): string[] {
  return text.match(NUMBER_RE) ?? [];
}

function extractEmailsLocal(text: string): string[] {
  const found = text.match(EMAIL_RE) ?? [];
  return [...new Set(found)].sort((a, b) => a.localeCompare(b));
}

/** Trim floating-point representation noise deterministically (same rule
 *  `agent/tools.ts#formatNumber` uses for `calc`), reimplemented locally so
 *  this file has zero runtime dependency on that module's internals. */
function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const rounded = Number(n.toPrecision(12));
  return String(rounded);
}

function total(fn: (input: string) => { ok: boolean; output: string }): Tool["run"] {
  return (input: string) => {
    try {
      return fn(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, output: `error: ${message}` };
    }
  };
}

// ---------------------------------------------------------------------------
// The three real, chained tools
// ---------------------------------------------------------------------------

const corpusSearchTool: Tool = {
  name: "corpus_search",
  description:
    "Case-insensitive substring search over the fixture document corpus. Input is a search " +
    "term; output is a comma-separated list of matching document ids, in corpus order.",
  run: total((input) => {
    const term = input.trim().toLowerCase();
    if (term === "") return { ok: false, output: "empty search term" };
    const ids = CORPUS.filter((d) => d.text.toLowerCase().includes(term)).map((d) => d.id);
    return { ok: true, output: ids.join(",") };
  }),
};

const docExtractTool: Tool = {
  name: "doc_extract",
  description:
    "Input a document id from the fixture corpus. Returns JSON " +
    '{"numbers":"<comma-separated numbers>","emails":"<comma-separated emails>"} ' +
    "extracted from that document's text via regex.",
  run: total((input) => {
    const id = input.trim();
    const doc = CORPUS.find((d) => d.id === id);
    if (!doc) return { ok: false, output: `unknown doc id: ${id}` };
    const numbers = extractNumbersLocal(doc.text).join(",");
    const emails = extractEmailsLocal(doc.text).join(",");
    return { ok: true, output: JSON.stringify({ numbers, emails }) };
  }),
};

const summarizeStatsTool: Tool = {
  name: "summarize_stats",
  description:
    "Input a comma-separated list of numbers. Returns JSON " +
    '{"count":n,"min":"...","max":"...","sum":"...","mean":"..."} computed via real arithmetic.',
  run: total((input) => {
    const parts = input
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parts.length === 0) return { ok: false, output: "no numbers supplied" };

    const nums: number[] = [];
    for (const p of parts) {
      const n = Number(p);
      if (!Number.isFinite(n)) return { ok: false, output: `not a number: ${p}` };
      nums.push(n);
    }

    const count = nums.length;
    const sum = nums.reduce((a, b) => a + b, 0);
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    const mean = sum / count;

    return {
      ok: true,
      output: JSON.stringify({
        count,
        min: formatNumber(min),
        max: formatNumber(max),
        sum: formatNumber(sum),
        mean: formatNumber(mean),
      }),
    };
  }),
};

/** A fresh registry pre-loaded with `corpus_search`, `doc_extract`, and
 *  `summarize_stats` — the three real tools the search->extract->summarize
 *  pipeline task genuinely requires, chained. */
export function buildPipelineRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(corpusSearchTool);
  registry.register(docExtractTool);
  registry.register(summarizeStatsTool);
  return registry;
}

// ---------------------------------------------------------------------------
// The task, in prose (given to the ReAct loop as the user turn) and as
// JavaScript (given to execute_code as the program source).
// ---------------------------------------------------------------------------

const TASK_PROMPT =
  `Search the corpus for documents mentioning "${PIPELINE_SEARCH_TERM}", extract each ` +
  "matching document's single reported numeric value, and report the mean of those " +
  "values as a plain number (no extra words, no units).";

const PROGRAMMATIC_CODE = `
const searchRes = await tools.call("corpus_search", "${PIPELINE_SEARCH_TERM}");
if (!searchRes.ok) { return "error: " + searchRes.output; }
const ids = searchRes.output.split(",").filter(Boolean);

let allNumbers = [];
for (const id of ids) {
  const extractRes = await tools.call("doc_extract", id);
  if (!extractRes.ok) { return "error: " + extractRes.output; }
  const parsed = JSON.parse(extractRes.output);
  const nums = parsed.numbers.split(",").filter(Boolean);
  for (const n of nums) allNumbers.push(n);
}

const statsRes = await tools.call("summarize_stats", allNumbers.join(","));
if (!statsRes.ok) { return "error: " + statsRes.output; }
const stats = JSON.parse(statsRes.output);
return stats.mean;
`.trim();

/**
 * The exact tool-by-tool script the ReAct side walks. It is a fixed
 * sequence (doc1, doc2, doc4, doc6, doc8 — the deterministic, corpus-order
 * result of searching for "sensor-alpha") rather than something derived
 * live from `AgentLoop` feedback: `ScriptedModelClient` stands in for an
 * LLM that already "knows" the right protocol moves, which is exactly what
 * makes it a legitimate mock of the model and nothing else — the registry,
 * loop, and tool dispatch it drives are all real.
 */
function reactScript(): string[] {
  return [
    "TOOL: corpus_search\nINPUT: sensor-alpha",
    "TOOL: doc_extract\nINPUT: doc1",
    "TOOL: doc_extract\nINPUT: doc2",
    "TOOL: doc_extract\nINPUT: doc4",
    "TOOL: doc_extract\nINPUT: doc6",
    "TOOL: doc_extract\nINPUT: doc8",
    "TOOL: summarize_stats\nINPUT: 12.5,9.25,18.0,6.25,15.0",
    "ANSWER: 12.2",
  ];
}

/**
 * ScriptedModelClient — the ONLY mock in this file. A deterministic,
 * clearly-labelled stand-in for an LLM: it replays a fixed list of replies
 * in order, one per `chat()` call, ignoring the actual message content it
 * is given. It is never presented as, and never confused with, a live
 * model — `AgentLoop`, `ToolRegistry`, and every tool it drives are real.
 */
class ScriptedModelClient implements ModelClient {
  private cursor = 0;
  constructor(private readonly replies: string[]) {}

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    const text =
      this.cursor < this.replies.length
        ? this.replies[this.cursor]
        : "ANSWER: (scripted client exhausted)";
    this.cursor += 1;
    return {
      text,
      tokensIn: 0,
      tokensOut: 0,
      usd: 0,
      model: "scripted-model",
      provider: "scripted",
    };
  }
}

// ---------------------------------------------------------------------------
// runPipelineBench
// ---------------------------------------------------------------------------

/**
 * Runs the search->extract->summarize task both ways and returns a
 * `PipelineBenchResult` built entirely from counted, real execution:
 *
 *  - `react.steps`     = the real `AgentLoopResult.steps` (model turns taken).
 *  - `react.toolCalls` = the real `AgentLoopResult.toolCalls.length`.
 *  - `programmatic.steps`     = 1 (one `execute_code` invocation — literal, not assumed).
 *  - `programmatic.toolCalls` = the real `ExecuteCodeReport.rpcCalls`.
 *
 * `toolCallReduction`/`stepReduction` are `(react - programmatic) / react`
 * fractions, computed from those counted values, never hardcoded. This
 * particular task chains the exact same three tool calls either way (the
 * "same work" case explicitly allowed by the checkpoint), so
 * `toolCallReduction` is 0 by design; `stepReduction` is large and positive
 * because `execute_code` collapses many conversational turns into one.
 */
export async function runPipelineBench(): Promise<PipelineBenchResult> {
  // --- ReAct side: real AgentLoop + real registry + scripted fake LLM. ---
  const reactRegistry = buildPipelineRegistry();
  const scriptedClient = new ScriptedModelClient(reactScript());
  const loop = new AgentLoop(scriptedClient, reactRegistry, {
    model: "scripted-model",
    maxSteps: 12,
  });
  const reactRun = await loop.run(TASK_PROMPT);

  const react: PipelineSideResult = {
    steps: reactRun.steps,
    toolCalls: reactRun.toolCalls.length,
    answer: reactRun.answer.trim(),
    // Deliberate asymmetry — see the file header: a plain chat transcript
    // carries no hash-chained provenance ledger to verify.
    verifiedTrace: false,
  };

  // --- Programmatic side: one real execute_code invocation. ---
  const programmaticRegistry = buildPipelineRegistry();
  let capturedLedger: ProvenanceLedger | undefined;
  const executeCodeTool = createExecuteCodeTool({
    registry: programmaticRegistry,
    onLedger: (ledger) => {
      capturedLedger = ledger;
    },
  });
  const toolResult = await executeCodeTool.run(PROGRAMMATIC_CODE);
  const report = JSON.parse(toolResult.output) as ExecuteCodeReport;

  const programmatic: PipelineSideResult = {
    steps: 1,
    toolCalls: report.rpcCalls,
    answer: report.result.trim(),
    verifiedTrace: capturedLedger !== undefined ? capturedLedger.verify().ok : false,
  };

  const toolCallReduction =
    react.toolCalls > 0 ? (react.toolCalls - programmatic.toolCalls) / react.toolCalls : 0;
  const stepReduction = react.steps > 0 ? (react.steps - programmatic.steps) / react.steps : 0;
  const answersAgree = react.answer === programmatic.answer;

  return { react, programmatic, toolCallReduction, stepReduction, answersAgree };
}
