import { describe, it, expect } from "vitest";
import { verifiedSwarmRunner, singleAgentRunner } from "../agent/runner";
import { runVtph, type EvalTask } from "../bench/vtph";
import type {
  ModelClient,
  ChatRequest,
  ChatResponse,
} from "../models/client";

/**
 * AgentRunner tests. Every ModelClient here is a SCRIPTED FAKE: it returns
 * canned ChatResponses and decides whether a call is a WORKER answer turn or
 * the VERIFIER gate by looking for the `VERDICT:` instruction in the messages
 * (only the verifier prompt contains it). All numbers are hand-computed from
 * the contract; nothing is read off the implementation.
 */

interface ReplySpec {
  text: string;
  tokensIn?: number;
  tokensOut?: number;
  usd?: number;
}

function toResponse(spec: ReplySpec, model: string): ChatResponse {
  return {
    text: spec.text,
    tokensIn: spec.tokensIn ?? 0,
    tokensOut: spec.tokensOut ?? 0,
    usd: spec.usd ?? 0,
    model,
    provider: "fake",
  };
}

function isVerifierCall(req: ChatRequest): boolean {
  return req.messages.some((m) => m.content.includes("VERDICT:"));
}

/**
 * A fake client that plays `workerScript` turns for worker calls (advancing by
 * one each worker turn, clamping on the last) and `verifier` for the gate call.
 * Records the model id of every call so cross-model verification is testable.
 */
class ScriptedClient implements ModelClient {
  workerCalls = 0;
  verifierCalls = 0;
  readonly modelsSeen: Array<{ model: string; kind: "worker" | "verifier" }> = [];

  constructor(
    private readonly cfg: {
      workerScript: ReplySpec[];
      verifier: ReplySpec;
    },
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (isVerifierCall(req)) {
      this.verifierCalls += 1;
      this.modelsSeen.push({ model: req.model, kind: "verifier" });
      return toResponse(this.cfg.verifier, req.model);
    }
    const i = Math.min(this.workerCalls, this.cfg.workerScript.length - 1);
    this.workerCalls += 1;
    this.modelsSeen.push({ model: req.model, kind: "worker" });
    return toResponse(this.cfg.workerScript[i], req.model);
  }
}

/** A client whose verifier call throws; worker calls succeed. */
class VerifierThrowsClient implements ModelClient {
  constructor(private readonly workerText: string) {}
  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (isVerifierCall(req)) throw new Error("verifier boom");
    return toResponse({ text: this.workerText }, req.model);
  }
}

function task(id: string, prompt: string, correct: string): EvalTask {
  return {
    id,
    prompt,
    category: "unit",
    decomposable: false,
    grade: (output: string) => output === correct,
  };
}

describe("verifiedSwarmRunner", () => {
  it("correct worker + honest verifier: output correct, claimedVerified true, provenance non-empty, usd = worker + verifier", async () => {
    const client = new ScriptedClient({
      workerScript: [{ text: "ANSWER: 4", tokensIn: 10, tokensOut: 5, usd: 0.001 }],
      verifier: {
        text: "VERDICT: PASS the answer 4 is correct",
        tokensIn: 8,
        tokensOut: 3,
        usd: 0.0005,
      },
    });
    const runner = verifiedSwarmRunner(client, { workerModel: "claude-fable-5" });

    const res = await runner(task("add", "2+2", "4"));

    expect(res.output).toBe("4");
    expect(res.claimedVerified).toBe(true);
    expect(res.provenance.length).toBeGreaterThan(0);
    expect(res.provenance).toContain("verifier:PASS the answer 4 is correct");
    // usd/tokens accumulate from BOTH worker loop and verifier call.
    expect(res.usd).toBeCloseTo(0.0015, 12);
    expect(res.tokensIn).toBe(18);
    expect(res.tokensOut).toBe(8);
    expect(client.workerCalls).toBe(1);
    expect(client.verifierCalls).toBe(1);
  });

  it("records the worker's tool calls in provenance as tool:name(input)=result", async () => {
    // Worker calls the real `calc` tool, then answers.
    const client = new ScriptedClient({
      workerScript: [
        { text: "TOOL: calc\nINPUT: 2+3" },
        { text: "ANSWER: 5", tokensOut: 2, usd: 0.0002 },
      ],
      verifier: { text: "VERDICT: PASS correct", usd: 0.0001 },
    });
    const runner = verifiedSwarmRunner(client, { workerModel: "claude-fable-5" });

    const res = await runner(task("calc", "compute 2+3", "5"));

    expect(res.output).toBe("5");
    expect(res.claimedVerified).toBe(true);
    expect(res.provenance).toContain("tool:calc(2+3)=5");
    expect(res.provenance).toContain("verifier:PASS correct");
    // verifier entry is last; tool entries precede it.
    expect(res.provenance[res.provenance.length - 1]).toBe("verifier:PASS correct");
  });

  it("HEADLINE: hallucinating worker + competent verifier => claimedVerified FALSE (gate catches it)", async () => {
    const client = new ScriptedClient({
      workerScript: [{ text: "ANSWER: 42", usd: 0.001 }],
      verifier: {
        text: "VERDICT: FAIL expected 4 but got 42",
        usd: 0.0005,
      },
    });
    const runner = verifiedSwarmRunner(client, { workerModel: "claude-fable-5" });

    const res = await runner(task("add", "2+2", "4"));

    expect(res.output).toBe("42"); // the wrong answer is still surfaced...
    expect(res.claimedVerified).toBe(false); // ...but NOT delivered as trustworthy.
    expect(res.provenance).toContain("verifier:FAIL expected 4 but got 42");
    // verifier cost is still counted even on a decline.
    expect(res.usd).toBeCloseTo(0.0015, 12);
  });

  it("HEADLINE via runVtph: the swarm's silentWrong stays 0 on the hallucination", async () => {
    const client = new ScriptedClient({
      workerScript: [{ text: "ANSWER: 42", usd: 0.001 }],
      verifier: { text: "VERDICT: FAIL wrong", usd: 0.0005 },
    });
    const runner = verifiedSwarmRunner(client, { workerModel: "claude-fable-5" });

    const report = await runVtph(runner, [task("add", "2+2", "4")], {
      label: "swarm",
      now: (() => {
        let t = 0;
        return () => (t += 1000);
      })(),
    });

    expect(report.silentWrong).toBe(0); // the whole point.
    expect(report.verifiedCorrect).toBe(0);
    expect(report.declined).toBe(1);
  });

  it("fail-closed: an unparseable verdict is treated as FAIL", async () => {
    const client = new ScriptedClient({
      workerScript: [{ text: "ANSWER: 4" }],
      verifier: { text: "hmm, looks fine to me" }, // no VERDICT: token
    });
    const runner = verifiedSwarmRunner(client, { workerModel: "claude-fable-5" });

    const res = await runner(task("add", "2+2", "4"));

    expect(res.claimedVerified).toBe(false);
    expect(res.provenance).toContain("verifier:FAIL unparseable verdict");
  });

  it("case-insensitive verdict parsing (lowercase pass)", async () => {
    const client = new ScriptedClient({
      workerScript: [{ text: "ANSWER: 4" }],
      verifier: { text: "verdict: pass looks right" },
    });
    const runner = verifiedSwarmRunner(client, { workerModel: "claude-fable-5" });

    const res = await runner(task("add", "2+2", "4"));
    expect(res.claimedVerified).toBe(true);
  });

  it("cross-model gate: verifierModel is used for the SEPARATE verification call", async () => {
    const client = new ScriptedClient({
      workerScript: [{ text: "ANSWER: 4" }],
      verifier: { text: "VERDICT: PASS ok" },
    });
    const runner = verifiedSwarmRunner(client, {
      workerModel: "claude-fable-5",
      verifierModel: "claude-opus-4-8",
    });

    await runner(task("add", "2+2", "4"));

    const worker = client.modelsSeen.find((m) => m.kind === "worker");
    const verifier = client.modelsSeen.find((m) => m.kind === "verifier");
    expect(worker?.model).toBe("claude-fable-5");
    expect(verifier?.model).toBe("claude-opus-4-8"); // separate, stronger model
  });

  it("never throws when the verifier call throws: returns a zero-cost declined error result", async () => {
    const client = new VerifierThrowsClient("ANSWER: 4");
    const runner = verifiedSwarmRunner(client, { workerModel: "claude-fable-5" });

    const res = await runner(task("add", "2+2", "4"));

    expect(res.claimedVerified).toBe(false);
    expect(res.output).toBe("");
    expect(res.tokensIn).toBe(0);
    expect(res.tokensOut).toBe(0);
    expect(res.usd).toBe(0);
    expect(res.provenance.length).toBe(1);
    expect(res.provenance[0]).toMatch(/^error:/);
  });
});

describe("singleAgentRunner", () => {
  it("trusts itself: claimedVerified ALWAYS true, provenance = tool calls, tokens/usd from loop only", async () => {
    const client = new ScriptedClient({
      workerScript: [{ text: "ANSWER: 4", tokensIn: 7, tokensOut: 2, usd: 0.0009 }],
      verifier: { text: "VERDICT: FAIL should never be called" },
    });
    const runner = singleAgentRunner(client, { model: "claude-fable-5" });

    const res = await runner(task("add", "2+2", "4"));

    expect(res.output).toBe("4");
    expect(res.claimedVerified).toBe(true);
    expect(res.usd).toBeCloseTo(0.0009, 12);
    expect(res.tokensIn).toBe(7);
    expect(res.tokensOut).toBe(2);
    expect(client.verifierCalls).toBe(0); // no gate at all
  });

  it("CONTRAST: same hallucinating worker => claimedVerified TRUE => silentWrong via runVtph", async () => {
    const client = new ScriptedClient({
      workerScript: [{ text: "ANSWER: 42", usd: 0.001 }],
      verifier: { text: "VERDICT: FAIL never called" },
    });
    const runner = singleAgentRunner(client, { model: "claude-fable-5" });

    const single = await runner(task("add", "2+2", "4"));
    expect(single.claimedVerified).toBe(true); // self-trust delivers the wrong answer

    const report = await runVtph(runner, [task("add", "2+2", "4")], {
      label: "single",
      now: (() => {
        let t = 0;
        return () => (t += 1000);
      })(),
    });
    expect(report.silentWrong).toBe(1); // the trust failure the swarm avoided
    expect(report.declined).toBe(0);
  });

  it("never throws even when the model client always throws", async () => {
    const throwing: ModelClient = {
      async chat(): Promise<ChatResponse> {
        throw new Error("infra down");
      },
    };
    const runner = singleAgentRunner(throwing, { model: "claude-fable-5" });

    // The loop swallows infra failures, so this resolves (does not reject).
    await expect(runner(task("add", "2+2", "4"))).resolves.toBeDefined();
    const res = await runner(task("add", "2+2", "4"));
    expect(res.claimedVerified).toBe(true);
    expect(res.output).toBe("");
  });
});
