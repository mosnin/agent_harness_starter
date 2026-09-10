/** Evaluation adapters for a tool-using worker and an optional model judge.
 * A judge pass is an evaluation claim, not proof; the single-agent surrogate
 * does not claim verification. Preserve incurred usage even if judging fails.
 */

import type { AgentRunner, EvalTask, AgentRunResult } from "../bench/vtph";
import type { ModelClient } from "../models/client";
import { AgentLoop, type AgentLoopResult } from "./loop";
import { builtinRegistry, type ToolRegistry, type ToolCall } from "./tools";

export interface RunnerOptions {
  workerModel: string;
  /** Defaults to workerModel; pass a stronger model for cross-model verification. */
  verifierModel?: string;
  maxSteps?: number;
  /** Defaults to builtinRegistry(). */
  tools?: ToolRegistry;
}

export interface SingleAgentOptions {
  model: string;
  maxSteps?: number;
  tools?: ToolRegistry;
}

/** A fully-declined, zero-cost result carrying only an error breadcrumb. */
function errorResult(message: string): AgentRunResult {
  return {
    output: "",
    claimedVerified: false,
    tokensIn: 0,
    tokensOut: 0,
    usd: 0,
    costMeasured: false,
    provenance: [`error:${message}`],
  };
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Render one loop tool call as a provenance breadcrumb:
 * `tool:<name>(<input>)=<result>`. Inputs/results are collapsed to a
 * single line so the audit trail stays one entry per call.
 */
function toolProvenance(entry: { call: ToolCall; result: string }): string {
  const input = collapse(entry.call.input);
  const result = collapse(entry.result);
  return `tool:${entry.call.tool}(${input})=${result}`;
}

/** Collapse whitespace/newlines to single spaces for compact provenance. */
function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ *
 * Verification gate — a SEPARATE model judgment (fail-closed)
 * ------------------------------------------------------------------ */

interface Verdict {
  pass: boolean;
  reason: string;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  costMeasured: boolean;
}

const VERDICT_RE = /VERDICT:\s*(PASS|FAIL)\b[ \t]*([^\n\r]*)/i;

/**
 * Ask `verifierModel` to independently check `answer` against `task`, then
 * parse `VERDICT: PASS` / `VERDICT: FAIL`. Fail-closed: an unparseable or
 * missing verdict is treated as FAIL, so an unsure gate DECLINES rather
 * than delivers. Tokens/usd from this call are returned so the caller can
 * add them to the worker's cost.
 */
async function verify(
  client: ModelClient,
  verifierModel: string,
  task: EvalTask,
  answer: string,
): Promise<Verdict> {
  const res = await client.chat({
    model: verifierModel,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You are a strict, independent verifier. Judge whether the ANSWER " +
          "correctly and completely solves the TASK. Do not solve it yourself; " +
          "check the given answer. Reply with EXACTLY one line: " +
          "`VERDICT: PASS <one-line reason>` if the answer is correct, or " +
          "`VERDICT: FAIL <one-line reason>` otherwise. If you are unsure, reply FAIL.",
      },
      {
        role: "user",
        content:
          `TASK: ${task.prompt}\n\n` +
          `ANSWER: ${answer}\n\n` +
          "Reply now with VERDICT: PASS or VERDICT: FAIL and a one-line reason.",
      },
    ],
  });

  const text = res.text ?? "";
  const match = text.match(VERDICT_RE);
  // Fail-closed: no parseable verdict => FAIL.
  const pass = match ? match[1].toUpperCase() === "PASS" : false;
  const reason = match ? collapse(match[2] ?? "") : "unparseable verdict";

  return {
    pass,
    reason,
    tokensIn: res.tokensIn ?? 0,
    tokensOut: res.tokensOut ?? 0,
    usd: res.usd ?? 0,
    costMeasured: res.costMeasured !== false,
  };
}

/* ------------------------------------------------------------------ *
 * verifiedSwarmRunner — worker loop + verification gate
 * ------------------------------------------------------------------ */

/**
 * Worker answers via the tool loop; a verifier model then judges the
 * answer. `claimedVerified` = the verifier's PASS. The verdict is a
 * SEPARATE `client.chat` call (optionally a stronger model), so a
 * confidently-wrong worker can be caught. Tokens/usd accumulate from BOTH
 * the worker loop and the verifier call.
 */
export function verifiedSwarmRunner(
  client: ModelClient,
  opts: RunnerOptions,
): AgentRunner {
  const tools = opts.tools ?? builtinRegistry();
  const verifierModel = opts.verifierModel ?? opts.workerModel;

  return async (task: EvalTask): Promise<AgentRunResult> => {
    let loop: AgentLoopResult | undefined;
    try {
      const worker = new AgentLoop(client, tools, {
        model: opts.workerModel,
        maxSteps: opts.maxSteps,
        temperature: 0,
      });

      loop = await worker.run(task.prompt);
      if (loop.error || loop.hitStepLimit) return { ...errorResult(loop.error ?? "step limit reached"), tokensIn: loop.tokensIn, tokensOut: loop.tokensOut, usd: loop.usd };
      const answer = loop.answer;

      const verdict = await verify(client, verifierModel, task, answer);

      const provenance: string[] = [
        ...loop.toolCalls.map(toolProvenance),
        `verifier:${verdict.pass ? "PASS" : "FAIL"} ${verdict.reason}`.trim(),
      ];

      return {
        output: answer,
        claimedVerified: verdict.pass,
        tokensIn: loop.tokensIn + verdict.tokensIn,
        tokensOut: loop.tokensOut + verdict.tokensOut,
        usd: loop.usd + verdict.usd,
        costMeasured: loop.costMeasured !== false && verdict.costMeasured,
        provenance,
      };
    } catch (err) {
      return { ...errorResult(messageOf(err)), tokensIn: loop?.tokensIn ?? 0, tokensOut: loop?.tokensOut ?? 0, usd: loop?.usd ?? 0 };
    }
  };
}

/* ------------------------------------------------------------------ *
 * singleAgentRunner — one model that trusts itself
 * ------------------------------------------------------------------ */

/** Local single-agent evaluation surrogate; no independent verification claim. */
export function singleAgentRunner(
  client: ModelClient,
  opts: SingleAgentOptions,
): AgentRunner {
  const tools = opts.tools ?? builtinRegistry();

  return async (task: EvalTask): Promise<AgentRunResult> => {
    try {
      const worker = new AgentLoop(client, tools, {
        model: opts.model,
        maxSteps: opts.maxSteps,
        temperature: 0,
      });

      const loop: AgentLoopResult = await worker.run(task.prompt);

      return {
        output: loop.answer,
        claimedVerified: false, // A local agent loop has no independent correctness checker.
        tokensIn: loop.tokensIn,
        tokensOut: loop.tokensOut,
        usd: loop.usd,
        costMeasured: loop.costMeasured,
        provenance: loop.toolCalls.map(toolProvenance),
      };
    } catch (err) {
      return errorResult(messageOf(err));
    }
  };
}
