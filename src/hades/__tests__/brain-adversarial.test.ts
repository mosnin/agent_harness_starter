/**
 * ADVERSARIAL VERIFICATION of the agent "brain": the safe tool layer
 * (`agent/tools.ts`), the terminating ReAct loop (`agent/loop.ts`), and the
 * verification-gated / single-agent runners (`agent/runner.ts`) as they plug
 * into the V-TPH$ scoreboard (`bench/vtph.ts`, `bench/eval-suite.ts`).
 *
 * These tests do NOT try to make the brain look good. They try to BREAK it and,
 * above all, to decide whether the verification gate is a REAL discriminator or
 * theater. The headline external-validity question: does routing a lying worker
 * through the gate actually drive `silentWrong` to 0 versus a self-trusting
 * single agent that ships the same wrong answer wearing a "verified" badge?
 *
 * Where the brain is honest, the attack fails and the test passes. Where it is
 * broken, the assertion encodes the CORRECT behaviour and is left to FAIL so the
 * bug is reported rather than hidden. Nothing here is weakened to go green.
 *
 * Fully deterministic: scripted fake ModelClients (worker-vs-verifier detected by
 * the presence of a `VERDICT:` instruction in the request messages), injected
 * clocks, no real network, no keys, no Math.random, no wall-clock Date.now.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { builtinRegistry, type ToolRegistry } from "../agent/tools";
import { AgentLoop } from "../agent/loop";
import { verifiedSwarmRunner, singleAgentRunner } from "../agent/runner";
import { runVtph, type EvalTask } from "../bench/vtph";
import { EVAL_TASKS } from "../bench/eval-suite";
import type {
  ModelClient,
  ChatRequest,
  ChatResponse,
} from "../models/client";

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

const MS_PER_HOUR = 3_600_000;
const WORKER_MODEL = "claude-haiku-4-5-20251001";
const VERIFIER_MODEL = "claude-sonnet-5"; // a distinct, stronger gate

/**
 * runVtph samples now() exactly twice (start,end). Return 0 on start and one
 * MS_PER_HOUR on end so every runVtph measures exactly one non-zero wall-clock
 * hour — makes vtph meaningful and identical across runners.
 */
function hourClock(): () => number {
  let n = 0;
  return () => (n++ % 2 === 0 ? 0 : MS_PER_HOUR);
}

function byId(id: string): EvalTask {
  const t = EVAL_TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`test setup: unknown task id ${id}`);
  return t;
}

// A real task with a genuine numeric ground-truth grader: 15% of 200 = 30.
const PERCENT_TASK = byId("arith-02-percent");
const CORRECT_ANSWER = "30";
const WRONG_ANSWER = "31"; // grade(31) === false

// Sanity: the grader we lean on actually discriminates. If this flips, every
// downstream external-validity claim is vacuous.
it("sanity: the ground-truth grader really discriminates 30 vs 31", () => {
  expect(PERCENT_TASK.grade(CORRECT_ANSWER)).toBe(true);
  expect(PERCENT_TASK.grade(WRONG_ANSWER)).toBe(false);
});

// ---------------------------------------------------------------------------
// Scripted fake ModelClients
// ---------------------------------------------------------------------------

interface FakeConfig {
  /** The worker's final ANSWER text. */
  answer: string;
  /** What the verifier call emits. GARBAGE = no parseable VERDICT line. */
  verdict: "PASS" | "FAIL" | "GARBAGE";
  /** If set, the worker makes exactly this one real tool call before answering. */
  toolCall?: { tool: string; input: string };
  /** Per-call usd; strictly positive so cost accounting is testable. */
  usdPerCall?: number;
}

/**
 * Detect a verifier turn purely from the request: the verifier system prompt
 * instructs the model to reply `VERDICT: PASS`/`VERDICT: FAIL`. Worker turns
 * (ReAct protocol) never contain that token.
 */
function isVerifierRequest(req: ChatRequest): boolean {
  return req.messages.some((m) => /VERDICT:/i.test(m.content));
}

class FakeClient implements ModelClient {
  readonly requests: ChatRequest[] = [];
  workerCalls = 0;
  verifierCalls = 0;
  constructor(private readonly cfg: FakeConfig) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(req);
    const usd = this.cfg.usdPerCall ?? 0.002;
    let text: string;

    if (isVerifierRequest(req)) {
      this.verifierCalls += 1;
      text =
        this.cfg.verdict === "PASS"
          ? "VERDICT: PASS the answer matches the task"
          : this.cfg.verdict === "FAIL"
            ? "VERDICT: FAIL the answer is incorrect"
            : "I am not certain and cannot render a clean judgment here."; // GARBAGE: no VERDICT
    } else {
      this.workerCalls += 1;
      const hasObservation = req.messages.some(
        (m) => m.role === "user" && /^TOOL_(RESULT|ERROR):/.test(m.content.trim()),
      );
      text =
        this.cfg.toolCall && !hasObservation
          ? `TOOL: ${this.cfg.toolCall.tool}\nINPUT: ${this.cfg.toolCall.input}`
          : `ANSWER: ${this.cfg.answer}`;
    }

    return { text, tokensIn: 100, tokensOut: 20, usd, model: req.model, provider: "fake" };
  }
}

/** A worker that NEVER answers — always emits another tool call. */
class NeverAnswerClient implements ModelClient {
  calls = 0;
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls += 1;
    return {
      text: "TOOL: calc\nINPUT: 1+1",
      tokensIn: 1,
      tokensOut: 1,
      usd: 0.0001,
      model: req.model,
      provider: "fake",
    };
  }
}

/** A client whose every call throws — infrastructure failure. */
class ThrowingClient implements ModelClient {
  calls = 0;
  async chat(): Promise<ChatResponse> {
    this.calls += 1;
    throw new Error("simulated infra failure");
  }
}

// Read the tool source once for the grep-style safety audit.
const TOOLS_SRC = readFileSync(
  fileURLToPath(new URL("../agent/tools.ts", import.meta.url)),
  "utf8",
);

// ===========================================================================
// 1. calc IS NOT eval  (SAFETY)
// ===========================================================================

describe("1. calc is a real parser, not eval (safety)", () => {
  const calc = builtinRegistry().get("calc");

  it("tools.ts source contains no callable eval / Function constructor / with", () => {
    expect(calc).toBeDefined();
    // The doc comment mentions the bare words `eval` / `new Function` / `with`;
    // what must be absent is any CALLABLE form. `evalArithmetic(` is fine.
    expect(TOOLS_SRC).not.toContain("eval(");
    expect(TOOLS_SRC).not.toContain("new Function(");
    expect(TOOLS_SRC).not.toMatch(/\bFunction\s*\(/); // capital-F constructor call
    expect(TOOLS_SRC).not.toMatch(/\bwith\s*\(/); // `with` statement
  });

  it("rejects hostile JS payloads (ok:false, NOT executed)", async () => {
    for (const payload of [
      "process.exit(1)",
      "require('fs')",
      "1;console.log(1)",
      "globalThis.x = 1",
      "() => 1",
    ]) {
      const r = await calc!.run(payload);
      expect(r.ok).toBe(false); // rejected as a syntax error, never run
    }
    // Positive proof of non-execution: the process is still here and nothing
    // was defined on globalThis by the payloads above.
    expect((globalThis as Record<string, unknown>).x).toBeUndefined();
  });

  it("still does REAL arithmetic with precedence, parens, decimals", async () => {
    expect((await calc!.run("2+3*4")).output).toBe("14");
    expect((await calc!.run("(2+3)*4")).output).toBe("20");
    expect((await calc!.run("2+3*4")).ok).toBe(true);
    const dec = await calc!.run("0.1+0.2");
    expect(dec.ok).toBe(true);
    expect(dec.output).toBe("0.3"); // deterministic float cleanup
    // Division by zero is a rejection, not Infinity/NaN leaking out.
    const dz = await calc!.run("1/0");
    expect(dz.ok).toBe(false);
  });
});

// ===========================================================================
// 2. LOOP TERMINATES  (no infinite spend)
// ===========================================================================

describe("2. the agent loop always terminates", () => {
  function tools(): ToolRegistry {
    return builtinRegistry();
  }

  it("a never-answering worker stops at maxSteps with hitStepLimit", async () => {
    const client = new NeverAnswerClient();
    const loop = new AgentLoop(client, tools(), { model: WORKER_MODEL, maxSteps: 3 });
    const res = await loop.run("loop forever if you can");

    expect(res.hitStepLimit).toBe(true);
    expect(res.steps).toBe(3);
    expect(res.steps).toBeLessThanOrEqual(3);
    // The step cap BINDS: exactly maxSteps model calls, not one more.
    expect(client.calls).toBe(3);
  });

  it("the step cap scales with maxSteps and never exceeds it", async () => {
    for (const cap of [1, 2, 5]) {
      const client = new NeverAnswerClient();
      const loop = new AgentLoop(client, tools(), { model: WORKER_MODEL, maxSteps: cap });
      const res = await loop.run("never done");
      expect(res.steps).toBe(cap);
      expect(client.calls).toBe(cap);
      expect(res.hitStepLimit).toBe(true);
    }
  });

  it("a throwing client makes run() RESOLVE (guarded), never reject", async () => {
    const client = new ThrowingClient();
    const loop = new AgentLoop(client, tools(), { model: WORKER_MODEL, maxSteps: 4 });
    const res = await loop.run("boom");
    // Resolved, not thrown. Best-effort empty answer, no runaway spend.
    expect(res).toBeDefined();
    expect(res.usd).toBe(0);
    expect(client.calls).toBeLessThanOrEqual(4);
  });

  it("a throwing client through a runner yields a declined, zero-cost result", async () => {
    const client = new ThrowingClient();
    const runner = verifiedSwarmRunner(client, {
      workerModel: WORKER_MODEL,
      verifierModel: VERIFIER_MODEL,
      maxSteps: 4,
    });
    // Must resolve, not reject.
    const r = await runner(PERCENT_TASK);
    expect(r.claimedVerified).toBe(false);
  });
});

// ===========================================================================
// 3. THE GATE CATCHES A LYING WORKER  (headline external-validity test)
// ===========================================================================

describe("3. the gate reduces silentWrong vs self-trust (the thesis)", () => {
  it("swarm declines a lying worker; single-agent ships it as verified", async () => {
    // Same wrong worker answer for a real task; only the strategy differs.
    const swarmClient = new FakeClient({ answer: WRONG_ANSWER, verdict: "FAIL" });
    const singleClient = new FakeClient({ answer: WRONG_ANSWER, verdict: "FAIL" });

    const swarm = verifiedSwarmRunner(swarmClient, {
      workerModel: WORKER_MODEL,
      verifierModel: VERIFIER_MODEL,
    });
    const single = singleAgentRunner(singleClient, { model: WORKER_MODEL });

    // The gate must FLIP claimedVerified to false on the wrong answer.
    const swarmResult = await swarm(PERCENT_TASK);
    expect(swarmResult.output).toBe(WRONG_ANSWER);
    expect(swarmResult.claimedVerified).toBe(false);

    const singleResult = await single(PERCENT_TASK);
    expect(singleResult.output).toBe(WRONG_ANSWER);
    expect(singleResult.claimedVerified).toBe(true); // self-trust ships it

    // Now score both through the honest scoreboard over the SAME real task.
    const swarmReport = await runVtph(swarm, [PERCENT_TASK], {
      label: "swarm",
      now: hourClock(),
    });
    const singleReport = await runVtph(single, [PERCENT_TASK], {
      label: "single",
      now: hourClock(),
    });

    // THE WHOLE THESIS, measured:
    expect(swarmReport.silentWrong).toBe(0); // gate declined the lie
    expect(swarmReport.declined).toBe(1);
    expect(swarmReport.verifiedCorrect).toBe(0);

    expect(singleReport.silentWrong).toBe(1); // trusted a wrong answer
    expect(singleReport.verifiedCorrect).toBe(0);

    // The gate strictly reduces silent-wrong relative to self-trust.
    expect(swarmReport.silentWrong).toBeLessThan(singleReport.silentWrong);
  });
});

// ===========================================================================
// 4. THE GATE COSTS MONEY AND IT'S COUNTED
// ===========================================================================

describe("4. the verifier call is real spend and it is counted", () => {
  it("swarm usd/tokens strictly exceed single-agent on the same task", async () => {
    // Correct worker + PASS so both deliver; the ONLY structural difference is
    // the extra verifier call the swarm pays for.
    const cfg: FakeConfig = {
      answer: CORRECT_ANSWER,
      verdict: "PASS",
      toolCall: { tool: "calc", input: "15*200/100" },
    };
    const swarmClient = new FakeClient(cfg);
    const singleClient = new FakeClient(cfg);

    const swarm = verifiedSwarmRunner(swarmClient, {
      workerModel: WORKER_MODEL,
      verifierModel: VERIFIER_MODEL,
    });
    const single = singleAgentRunner(singleClient, { model: WORKER_MODEL });

    const swarmReport = await runVtph(swarm, [PERCENT_TASK], { now: hourClock() });
    const singleReport = await runVtph(single, [PERCENT_TASK], { now: hourClock() });

    expect(singleReport.totalUsd).toBeGreaterThan(0);
    expect(swarmReport.totalUsd).toBeGreaterThan(0);
    // Extra verifier call => strictly more money and tokens. If the verifier
    // were "free", these would be equal — a V-TPH$ lie. Assert it is NOT.
    expect(swarmReport.totalUsd).toBeGreaterThan(singleReport.totalUsd);
    expect(swarmReport.totalTokens).toBeGreaterThan(singleReport.totalTokens);

    // Concretely: the swarm made one more call than the single agent.
    expect(swarmClient.verifierCalls).toBe(1);
    expect(singleClient.verifierCalls).toBe(0);
    expect(swarmClient.requests.length).toBe(singleClient.requests.length + 1);
  });
});

// ===========================================================================
// 5. FAIL-CLOSED
// ===========================================================================

describe("5. the gate fails closed", () => {
  it("a garbage (no-VERDICT) verifier declines a correct answer", async () => {
    const client = new FakeClient({ answer: CORRECT_ANSWER, verdict: "GARBAGE" });
    const swarm = verifiedSwarmRunner(client, {
      workerModel: WORKER_MODEL,
      verifierModel: VERIFIER_MODEL,
    });
    const r = await swarm(PERCENT_TASK);
    // Answer is actually correct, but the gate could not parse a verdict:
    // decline rather than deliver on an unsure gate.
    expect(PERCENT_TASK.grade(r.output)).toBe(true);
    expect(r.claimedVerified).toBe(false);

    const report = await runVtph(swarm, [PERCENT_TASK], { now: hourClock() });
    expect(report.silentWrong).toBe(0);
    expect(report.declined).toBe(1);
    expect(report.correctButUnclaimed).toBe(1); // right, but honestly not claimed
  });

  it("a PASS verifier on a correct answer scores verifiedCorrect", async () => {
    const client = new FakeClient({
      answer: CORRECT_ANSWER,
      verdict: "PASS",
      toolCall: { tool: "calc", input: "15*200/100" },
    });
    const swarm = verifiedSwarmRunner(client, {
      workerModel: WORKER_MODEL,
      verifierModel: VERIFIER_MODEL,
    });
    const report = await runVtph(swarm, [PERCENT_TASK], { now: hourClock() });
    expect(report.verifiedCorrect).toBe(1);
    expect(report.silentWrong).toBe(0);
    expect(report.declined).toBe(0);
  });
});

// ===========================================================================
// 6. THE GATE IS NOT A RUBBER STAMP
// ===========================================================================

describe("6. claimedVerified follows the verdict, not worker confidence", () => {
  async function scoreOne(cfg: FakeConfig) {
    const client = new FakeClient(cfg);
    const swarm = verifiedSwarmRunner(client, {
      workerModel: WORKER_MODEL,
      verifierModel: VERIFIER_MODEL,
    });
    const result = await swarm(PERCENT_TASK);
    const report = await runVtph(swarm, [PERCENT_TASK], { now: hourClock() });
    return { result, report };
  }

  it("correct worker + PASS => verifiedCorrect", async () => {
    const { result, report } = await scoreOne({
      answer: CORRECT_ANSWER,
      verdict: "PASS",
    });
    expect(result.claimedVerified).toBe(true);
    expect(report.verifiedCorrect).toBe(1);
    expect(report.silentWrong).toBe(0);
  });

  it("wrong worker + FAIL => declined, never silentWrong", async () => {
    const { result, report } = await scoreOne({
      answer: WRONG_ANSWER,
      verdict: "FAIL",
    });
    expect(result.claimedVerified).toBe(false);
    expect(report.declined).toBe(1);
    expect(report.silentWrong).toBe(0);
  });

  it("correct worker + FAIL (paranoid gate) => declined & correctButUnclaimed, NOT silentWrong", async () => {
    const { result, report } = await scoreOne({
      answer: CORRECT_ANSWER,
      verdict: "FAIL",
    });
    // The gate said FAIL though the answer was right: it must decline. The gate
    // is not a stamp keyed to the worker's confidence.
    expect(result.claimedVerified).toBe(false);
    expect(report.correctButUnclaimed).toBe(1);
    expect(report.silentWrong).toBe(0);
    expect(report.verifiedCorrect).toBe(0);
  });
});

// ===========================================================================
// 7. PROVENANCE IS REAL
// ===========================================================================

describe("7. provenance reflects real tool calls and the verdict", () => {
  it("a delivered result carries provenance with the actual tool call and verdict", async () => {
    const client = new FakeClient({
      answer: CORRECT_ANSWER,
      verdict: "PASS",
      toolCall: { tool: "calc", input: "15*200/100" },
    });
    const swarm = verifiedSwarmRunner(client, {
      workerModel: WORKER_MODEL,
      verifierModel: VERIFIER_MODEL,
    });
    const r = await swarm(PERCENT_TASK);

    expect(r.claimedVerified).toBe(true);
    expect(r.provenance.length).toBeGreaterThan(0);
    // The tool call the worker actually made appears, with its REAL result (30),
    // not a template — calc actually evaluated 15*200/100.
    expect(r.provenance.some((p) => /tool:calc\(15\*200\/100\)=30/.test(p))).toBe(true);
    // The verifier verdict is recorded too.
    expect(r.provenance.some((p) => /verifier:PASS/.test(p))).toBe(true);

    // The scoreboard sees complete provenance on the claimed result.
    const report = await runVtph(swarm, [PERCENT_TASK], { now: hourClock() });
    expect(report.provenanceCompleteRate).toBe(1);
  });
});
