/* ------------------------------------------------------------------ *
 * AgentRunners — the adapters that turn the tool-calling agent loop into
 * V-TPH$ {@link AgentRunner}s that plug straight into `hades bench vtph`.
 *
 * Two strategies, one interface:
 *
 *   1. {@link verifiedSwarmRunner} — the Hades bet. A worker answers via
 *      the tool loop, then a SEPARATE verifier model call independently
 *      judges the answer and decides `claimedVerified`. Because the gate
 *      is a distinct call (and can be a stronger model), a worker that
 *      confidently hallucinates gets CAUGHT: the gate replies FAIL, the
 *      result is declined, and `silentWrong` stays 0. The gate costs
 *      money, and that money is counted in the V-TPH$ math.
 *
 *   2. {@link singleAgentRunner} — the Hermes-style baseline. One model
 *      answers and TRUSTS ITSELF: `claimedVerified` is always `true`. No
 *      second opinion, so a confident wrong answer is delivered wearing a
 *      "verified" badge — exactly the trust failure V-TPH$ measures.
 *
 * Everything here is deterministic given a deterministic client: no
 * Math.random, no clock, no network, no fs. Both runners are TOTAL — they
 * never throw. Any internal failure is turned into a zero-cost declined
 * result so `runVtph` never crashes on a bad task.
 * ------------------------------------------------------------------ */

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
    try {
      const worker = new AgentLoop(client, tools, {
        model: opts.workerModel,
        maxSteps: opts.maxSteps,
        temperature: 0,
      });

      const loop: AgentLoopResult = await worker.run(task.prompt);
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
        provenance,
      };
    } catch (err) {
      return errorResult(messageOf(err));
    }
  };
}

/* ------------------------------------------------------------------ *
 * singleAgentRunner — one model that trusts itself
 * ------------------------------------------------------------------ */

/**
 * One model answers and trusts itself: `claimedVerified` is ALWAYS `true`.
 * Provenance is the worker's tool calls (may be empty). Tokens/usd come
 * from the loop only — there is no verification gate to pay for. This is
 * the single-agent baseline whose `silentWrong` V-TPH$ exposes.
 */
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
        claimedVerified: true, // self-trust: always claimed
        tokensIn: loop.tokensIn,
        tokensOut: loop.tokensOut,
        usd: loop.usd,
        provenance: loop.toolCalls.map(toolProvenance),
      };
    } catch (err) {
      return errorResult(messageOf(err));
    }
  };
}
