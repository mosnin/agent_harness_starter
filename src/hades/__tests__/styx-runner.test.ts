import { describe, it, expect } from "vitest";
import {
  styxRunner,
  prepareStyxTask,
  parseStrategyList,
  signalsForTask,
  defaultCalibration,
  FALLBACK_STRATEGIES,
  type StyxRunnerOptions,
} from "../styx/runner";
import { runVtph, type EvalTask } from "../bench/vtph";
import type { ModelClient, ChatRequest, ChatResponse } from "../models/client";

/**
 * S4 real-inference-binding tests. Every ModelClient here is a SCRIPTED FAKE
 * (no keys, no network). It classifies each call by sentinels the runner plants
 * in its prompts:
 *   - the SPECULATOR system prompt contains "strategy speculator",
 *   - the VERIFIER prompts contain "VERDICT:",
 *   - anything else is a WORKER (AgentLoop) turn.
 * The fake returns a numbered strategy list for speculation, a scripted answer
 * for the worker, and a scripted PASS/FAIL vote for each verifier. All token/usd
 * numbers are fixed so the summed cost is hand-computable from the call counts.
 */

// Per-call fixed usage so totals are exactly predictable.
const SPEC = { tokensIn: 10, tokensOut: 5, usd: 0.001 };
const WORK = { tokensIn: 20, tokensOut: 8, usd: 0.002 };
const VERIF = { tokensIn: 6, tokensOut: 2, usd: 0.0005 };

function resp(u: { tokensIn: number; tokensOut: number; usd: number }, text: string, model: string): ChatResponse {
  return { text, tokensIn: u.tokensIn, tokensOut: u.tokensOut, usd: u.usd, model, provider: "fake" };
}

function isSpeculator(req: ChatRequest): boolean {
  return req.messages.some((m) => m.content.includes("strategy speculator"));
}
function isVerifier(req: ChatRequest): boolean {
  return req.messages.some((m) => m.content.includes("VERDICT:"));
}
function workerStrategy(req: ChatRequest): string {
  for (const m of req.messages) {
    const match = m.content.match(/solution strategy:\s*"([^"]+)"/);
    if (match) return match[1];
  }
  return "";
}
function candidateOutput(req: ChatRequest): string {
  for (const m of req.messages) {
    const match = m.content.match(/ANSWER:\s*([\s\S]*?)\n\n/);
    if (match) return match[1].trim();
  }
  return "";
}

/**
 * A fully stateless, content-dispatched fake. Statelessness is what makes the
 * whole runner deterministic and re-runnable.
 */
class ScriptedClient implements ModelClient {
  constructor(
    private readonly cfg: {
      strategies: string[];
      /** worker answer for a strategy (defaults to a constant). */
      answerFor: (strategy: string) => string;
      /** verifier vote as a function of (model, candidate answer). */
      pass: (model: string, output: string) => boolean;
    },
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (isSpeculator(req)) {
      const list = this.cfg.strategies.map((s, i) => `${i + 1}. ${s}`).join("\n");
      return resp(SPEC, list, req.model);
    }
    if (isVerifier(req)) {
      const output = candidateOutput(req);
      const verdict = this.cfg.pass(req.model, output) ? "VERDICT: PASS" : "VERDICT: FAIL";
      return resp(VERIF, verdict, req.model);
    }
    const answer = this.cfg.answerFor(workerStrategy(req));
    return resp(WORK, `ANSWER: ${answer}`, req.model);
  }
}

class ThrowingClient implements ModelClient {
  async chat(): Promise<ChatResponse> {
    throw new Error("boom: no keys");
  }
}

function task(id: string, prompt: string, correct: string, category = "math"): EvalTask {
  return {
    id,
    prompt,
    category,
    decomposable: true,
    grade: (output: string) => output.trim() === correct,
  };
}

const BASE_OPTS: StyxRunnerOptions = {
  workerModel: "worker-model",
  verifierModels: ["verifier-a", "verifier-b"],
  issuedAt: 1_700_000_000_000,
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("styx runner — pure helpers", () => {
  it("parses numbered / bulleted strategy lists and dedupes", () => {
    expect(parseStrategyList("1. alpha\n2. beta\n3) gamma", 3)).toEqual(["alpha", "beta", "gamma"]);
    expect(parseStrategyList("- one\n* two\n- one", 5)).toEqual(["one", "two"]);
    expect(parseStrategyList("- `quoted`\n2. plain", 3)).toEqual(["quoted", "plain"]);
  });

  it("falls back when nothing parses", () => {
    expect(parseStrategyList("no list here at all", 3)).toEqual(FALLBACK_STRATEGIES);
    expect(parseStrategyList("", 3)).toEqual(FALLBACK_STRATEGIES);
  });

  it("routes executable categories to an oracle-checkable signal", () => {
    expect(signalsForTask(task("t", "p", "x", "math")).executable).toBe(true);
    expect(signalsForTask(task("t", "p", "x", "code")).executable).toBe(true);
    expect(signalsForTask(task("t", "p", "x", "prose")).executable).toBe(false);
  });

  it("default calibration has more than the gate minimum", () => {
    expect(defaultCalibration().length).toBeGreaterThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------
// styxRunner end-to-end (fake client)
// ---------------------------------------------------------------------------

function easyClient(): ScriptedClient {
  // Every strategy solves it; both verifiers pass the correct answer.
  return new ScriptedClient({
    strategies: ["alpha", "beta", "gamma"],
    answerFor: () => "42",
    pass: (_m, output) => output === "42",
  });
}

describe("styxRunner — emit path", () => {
  it("emits a correct, certified answer on an easy task", async () => {
    const runner = styxRunner(easyClient(), BASE_OPTS);
    const result = await runner(task("easy", "What is 6 * 7?", "42"));

    expect(result.claimedVerified).toBe(true);
    expect(result.output).toBe("42");

    // A certificate id is present in the provenance.
    expect(result.provenance.some((p) => p.startsWith("certificate:"))).toBe(true);

    // usd = every prepare call: 1 speculate + 3 workers + 2 verifiers (one
    // deduped output). tokens likewise.
    const expectedUsd = SPEC.usd + 3 * WORK.usd + 2 * VERIF.usd;
    expect(result.usd).toBeCloseTo(expectedUsd, 12);
    expect(result.usd).toBeGreaterThan(0);
    expect(result.tokensIn).toBe(SPEC.tokensIn + 3 * WORK.tokensIn + 2 * VERIF.tokensIn);
    expect(result.tokensOut).toBe(SPEC.tokensOut + 3 * WORK.tokensOut + 2 * VERIF.tokensOut);
  });

  it("is deterministic across runs (incl. certificate signature)", async () => {
    const runner = styxRunner(easyClient(), BASE_OPTS);
    const t = task("det", "What is 6 * 7?", "42");
    const a = await runner(t);
    const b = await runner(t);
    expect(a).toEqual(b);
    // The determinism includes the signed certificate breadcrumb.
    expect(a.provenance.some((p) => p.startsWith("certificate:"))).toBe(true);
  });
});

describe("styxRunner — abstention path", () => {
  it("abstains (declines) when the panel fails the answer", async () => {
    const client = new ScriptedClient({
      strategies: ["alpha", "beta", "gamma"],
      answerFor: () => "42",
      pass: () => false, // panel rejects everything
    });
    const result = await styxRunner(client, BASE_OPTS)(task("hard", "What is 6 * 7?", "42"));

    expect(result.claimedVerified).toBe(false);
    expect(result.output).toBe("");
    expect(result.provenance.some((p) => p.startsWith("certificate:"))).toBe(false);
    // Still paid for the attempt.
    expect(result.usd).toBeGreaterThan(0);
  });

  it("never throws on a throwing client — returns a zero-cost decline", async () => {
    const result = await styxRunner(new ThrowingClient(), BASE_OPTS)(task("boom", "anything", "x"));
    expect(result.claimedVerified).toBe(false);
    expect(result.output).toBe("");
    expect(result.usd).toBe(0);
    expect(result.tokensIn).toBe(0);
    expect(result.provenance[0]).toMatch(/^error:/);
  });
});

// ---------------------------------------------------------------------------
// prepareStyxTask — the sync/async bridge in isolation
// ---------------------------------------------------------------------------

describe("prepareStyxTask — sync closures replay cached async work", () => {
  it("resolves bandit-expanded child strategies back to a cached root", async () => {
    const prep = await prepareStyxTask(easyClient(), task("p", "6*7", "42"), {
      workerModel: "worker-model",
      verifierModels: ["verifier-a"],
    });
    // A never-pre-run "+refine/+alt" child replays its root's cached answer
    // without any new model call.
    const usdBefore = prep.usage.usd;
    const child = prep.worker.run(prep.styxTask, "alpha+refine+alt");
    expect(child.output).toBe("42");
    expect(prep.usage.usd).toBe(usdBefore); // no extra spend on replay
    // The panel always has votes for a produced (cached) output.
    expect(prep.panel.vote(prep.styxTask, "42").length).toBe(1);
    // A defensive miss is fail-closed, not a fabricated pass.
    expect(prep.panel.vote(prep.styxTask, "never-produced").every((v) => !v.passed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Through runVtph — the honest scoreboard
// ---------------------------------------------------------------------------

const NOW = () => {
  let t = 0;
  return () => (t += 1000);
};

describe("styxRunner through runVtph", () => {
  it("all-correct + passing panel: verifiedCorrect > 0, silentWrong 0", async () => {
    const runner = styxRunner(easyClient(), BASE_OPTS);
    const tasks = [task("q1", "6*7", "42"), task("q2", "6*7", "42")];
    const report = await runVtph(runner, tasks, { label: "styx", now: NOW() });

    expect(report.verifiedCorrect).toBeGreaterThan(0);
    expect(report.verifiedCorrect).toBe(2);
    expect(report.silentWrong).toBe(0);
    expect(report.totalUsd).toBeGreaterThan(0);
    expect(report.provenanceCompleteRate).toBe(1);
  });

  it("hallucinating worker + honest panel: abstains, silentWrong 0 (not a wrong emit)", async () => {
    // Worker always answers "99" (wrong); an honest panel only passes "42".
    const client = new ScriptedClient({
      strategies: ["alpha", "beta", "gamma"],
      answerFor: () => "99",
      pass: (_m, output) => output === "42",
    });
    const runner = styxRunner(client, BASE_OPTS);
    const tasks = [task("q1", "6*7", "42"), task("q2", "6*7", "42")];
    const report = await runVtph(runner, tasks, { label: "styx-halluc", now: NOW() });

    expect(report.silentWrong).toBe(0); // the whole point: decline, don't lie
    expect(report.verifiedCorrect).toBe(0);
    expect(report.declined).toBe(2);
  });
});
